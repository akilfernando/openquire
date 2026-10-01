import * as mupdf from 'mupdf'
import { zipSync } from 'fflate'
import { findImageDraws, fmt, imageWarp, invert, multiply, patch, type Matrix as CMatrix } from './content'
import { createDigitalId, readDigitalId, signPdf, verifySignatures } from './signing'
import {
  hexOf,
  type AnnotInfo,
  type AnnotPatch,
  type AnnotShape,
  type AnnotSpec,
  type Bookmark,
  type CompressLevel,
  type DocState,
  type FieldKind,
  type FieldProps,
  type Metadata,
  type OcrWord,
  type PageImage,
  type PageInfo,
  type PageLabelStyle,
  type Permission,
  type Point,
  type Quad,
  type RGB,
  type Rect,
  type SaveOptions,
  type SearchHit,
  type SignRequest,
  type SignatureInfo,
  type StampSpec,
  type TextBlock,
  type TextLine,
  type WidgetInfo,
  type WidgetKind,
} from './types'

export class PasswordError extends Error {
  constructor(public file: string, public retry: boolean) {
    super(retry ? `Incorrect password for ${file}` : `${file} is password-protected`)
    this.name = 'PasswordError'
  }
}

const A4: Rect = [0, 0, 595.28, 841.89]
const isPdfName = (name: string) => /\.pdf$/i.test(name)
const LINE_HEIGHT = 1.2
const TEXT_CACHE_PAGES = 48

/** Opens a PDF, or converts anything MuPDF can read (images, Office, EPUB, HTML, text…) to one. */
export function openAsPdf(name: string, bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  let src: mupdf.Document
  try {
    src = mupdf.Document.openDocument(bytes, isPdfName(name) ? 'application/pdf' : name)
  } catch (e) {
    throw new Error(`Can't open ${name}: ${(e as Error).message}`)
  }
  if (src.needsPassword()) {
    if (!password) throw new PasswordError(name, false)
    if (!src.authenticatePassword(password)) throw new PasswordError(name, true)
  }
  const pdf = src.asPDF()
  if (pdf) return pdf

  try {
    src.layout(A4[2], A4[3], 11)
  } catch {
    // fixed-layout formats (images, CBZ) don't reflow
  }
  const buf = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buf, 'pdf', '')
  for (let i = 0; i < src.countPages(); i++) {
    const page = src.loadPage(i)
    const dev = writer.beginPage(page.getBounds())
    page.run(dev, mupdf.Matrix.identity)
    writer.endPage()
  }
  writer.close()
  return mupdf.Document.openDocument(buf.asUint8Array().slice(), 'application/pdf').asPDF()!
}

// ---- small helpers -----------------------------------------------------------

const rgb = (c: mupdf.AnnotColor): RGB | null => {
  if (c.length === 3) return [c[0], c[1], c[2]]
  if (c.length === 1) return [c[0], c[0], c[0]]
  if (c.length === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]
  return null
}

const shapeOf = (a: mupdf.PDFAnnotation): AnnotShape =>
  a.hasInkList() ? 'ink' : a.hasQuadPoints() ? 'quads' : a.hasLine() ? 'line' : a.hasVertices() ? 'vertices' : 'rect'

const shiftQuad = (q: Quad, dx: number, dy: number) => q.map((v, i) => v + (i % 2 ? dy : dx)) as Quad

const pdfDate = (d: Date) => (isNaN(d.getTime()) || d.getTime() <= 0 ? null : d.toISOString())

/** Code points the standard fonts' WinAnsiEncoding can show, mapped to their byte. */
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}
const winAnsi = (cp: number) => (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff) ? cp : WIN_ANSI_EXTRA[cp] ?? 0x3f

const PERMISSION_BITS: Record<Permission, number> = { print: 4 | 2048, edit: 8, copy: 16 | 512, annotate: 32, form: 256, assemble: 1024 }

export type BaseFont =
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'

export function baseFontFor(l: Pick<TextLine, 'bold' | 'italic' | 'serif' | 'mono'>): BaseFont {
  const fam = l.mono ? 'Courier' : l.serif ? 'Times' : 'Helvetica'
  const slant = fam === 'Times' ? 'Italic' : 'Oblique'
  if (l.bold && l.italic) return `${fam}-Bold${slant}` as BaseFont
  if (l.bold) return `${fam}-Bold` as BaseFont
  if (l.italic) return `${fam}-${slant}` as BaseFont
  return fam === 'Times' ? 'Times-Roman' : (fam as BaseFont)
}

interface TextRun {
  text: string
  /** Baseline start of the first line, in page space. */
  x: number
  y: number
  size: number
  font: BaseFont
  color: RGB
  opacity?: number
  /** Counter-clockwise degrees. */
  angle?: number
  /** Searchable but not drawn (an OCR text layer). */
  invisible?: boolean
  /** Stretch or squeeze horizontally to this width. */
  width?: number
}

// ---- text helpers ------------------------------------------------------------

/** Fonts loaded from documents for re-use in new text, by the name MuPDF's layout asks for. */
const loadedFonts = new Map<string, mupdf.Font>()
mupdf.installLoadFontFunction((name) => loadedFonts.get(name) ?? null)

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function styleOf(font: mupdf.Font, size: number, color: mupdf.Color) {
  const name = font.getName()
  return {
    font: name,
    size,
    bold: font.isBold() || /bold|black|heavy|semibold/i.test(name),
    italic: font.isItalic() || /italic|oblique/i.test(name),
    serif: font.isSerif() || /times|serif|georgia|garamond|cambria|minion|roman/i.test(name),
    mono: font.isMono() || /courier|mono|consol/i.test(name),
    color: (rgb(color as mupdf.AnnotColor) ?? [0, 0, 0]) as RGB,
  }
}

/** Summarizes a run of lines as a paragraph: bounds, text, alignment and leading. */
function toBlock(lines: TextLine[]): TextBlock {
  const x0 = Math.min(...lines.map((l) => l.bbox[0]))
  const x1 = Math.max(...lines.map((l) => l.bbox[2]))
  const bbox: Rect = [x0, Math.min(...lines.map((l) => l.bbox[1])), x1, Math.max(...lines.map((l) => l.bbox[3]))]
  const first = lines[0]
  const gaps = lines.slice(1).map((l, i) => l.origin[1] - lines[i].origin[1]).sort((a, b) => a - b)
  const leading = gaps.length ? gaps[Math.floor(gaps.length / 2)] : first.size * LINE_HEIGHT
  let align: TextBlock['align'] = 'left'
  if (lines.length > 1) {
    const tol = first.size * 0.6
    const lefts = lines.map((l) => l.bbox[0] - x0)
    const rights = lines.map((l) => x1 - l.bbox[2])
    const body = lines.slice(0, -1)
    // Justified lines end within a point or two of each other; ragged text varies far more.
    if (lefts.every((d) => d < tol) && body.every((l) => x1 - l.bbox[2] < 1.5) && lines.length > 2) align = 'justify'
    else if (lefts.every((d) => d < tol)) align = 'left'
    else if (rights.every((d) => d < tol)) align = 'right'
    else if (lefts.every((d, i) => Math.abs(d - rights[i]) < tol)) align = 'center'
  }
  // Join wrapped lines with spaces, rejoining words hyphenated at a line end.
  const text = lines
    .map((l) => l.text.replace(/\s+$/, ''))
    .reduce((acc, l) => (!acc ? l : /\w-$/.test(acc) ? acc.slice(0, -1) + l : `${acc} ${l}`), '')
  return { bbox, lines, text, align, leading, ...pick(first, ['size', 'font', 'bold', 'italic', 'serif', 'mono', 'color']) }
}

const pick = <T, K extends keyof T>(o: T, keys: K[]) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>

// ---- the engine --------------------------------------------------------------

export class Engine {
  doc: mupdf.PDFDocument | null = null
  name = 'document'
  author = 'OpenQuire user'
  private password: string | undefined
  private encrypted = false
  private signatures: SignatureInfo[] = []
  private lastSave: { position: number; bytes: Uint8Array } | null = null
  private tick = 0
  private revs = new Map<number, number>()
  private fonts = new Map<string, mupdf.Font>()
  private stext = new Map<string, mupdf.StructuredText>()

  // ---- document lifecycle ----

  open(name: string, bytes: Uint8Array, password?: string) {
    const doc = openAsPdf(name, bytes, password)
    this.replaceDoc(doc, name.replace(/\.[^.]+$/, ''))
    this.password = password
    this.encrypted = isPdfName(name) && !!password
    this.signatures = isPdfName(name) ? verifySignatures(bytes, doc) : []
    return this.state()
  }

  newBlank() {
    const doc = new mupdf.PDFDocument()
    doc.insertPage(-1, doc.addPage(A4, 0, {}, ''))
    this.replaceDoc(doc, 'untitled')
    return this.state()
  }

  private replaceDoc(doc: mupdf.PDFDocument, name: string) {
    this.touch('all')
    this.doc?.destroy()
    this.doc = doc
    this.name = name
    this.password = undefined
    this.encrypted = false
    this.signatures = []
    this.lastSave = null
    doc.enableJournal()
  }

  /** Appends every page of another file, along with its annotations and form fields. */
  append(name: string, bytes: Uint8Array, password?: string) {
    const src = openAsPdf(name, bytes, password)
    // Grafting a page leaves its annotations behind, so they are copied separately. Their
    // back-pointer to the source page (/P) is dropped first, or grafting would copy that page too.
    const annots = Array.from({ length: src.countPages() }, (_, i) => {
      const arr = src.findPage(i).get('Annots')
      if (arr.isArray()) arr.forEach((a) => a.resolve().isDictionary() && a.resolve().delete('P'))
      return arr
    })
    this.op(`Add ${name}`, () => {
      const doc = this.d
      const map = doc.newGraftMap()
      for (let i = 0; i < src.countPages(); i++) {
        map.graftPage(-1, src, i)
        if (!annots[i].isArray()) continue
        const page = doc.findPage(doc.countPages() - 1)
        const copied = map.graftObject(annots[i])
        copied.forEach((a) => a.resolve().put('P', page))
        page.put('Annots', copied)
      }
      const fields = src.getTrailer().get('Root', 'AcroForm', 'Fields')
      if (fields.isArray() && fields.length) {
        const root = doc.getTrailer().get('Root')
        let form = root.get('AcroForm')
        if (form.isNull()) {
          form = doc.addObject(doc.newDictionary())
          root.put('AcroForm', form)
        }
        let dst = form.get('Fields')
        if (dst.isNull()) {
          dst = doc.newArray()
          form.put('Fields', dst)
        }
        fields.forEach((f) => dst.push(map.graftObject(f)))
        const da = src.getTrailer().get('Root', 'AcroForm', 'DR')
        if (form.get('DR').isNull() && !da.isNull()) form.put('DR', map.graftObject(da))
      }
    })
    src.destroy()
    return this.state()
  }

  private get d() {
    if (!this.doc) throw new Error('No document is open')
    return this.doc
  }

  /** Runs a change as one undoable step and marks the given pages for re-rendering. */
  private op(label: string, fn: () => void, touched: number[] | 'all' = 'all') {
    const doc = this.d
    doc.beginOperation(label)
    try {
      fn()
      doc.endOperation()
    } catch (e) {
      doc.abandonOperation()
      throw e
    }
    this.touch(touched)
  }

  private touch(ids: number[] | 'all') {
    if (ids === 'all') {
      this.revs.clear()
      for (const [k, st] of this.stext) this.dropText(k, st)
      this.tick++
    } else {
      for (const id of ids) {
        this.revs.set(id, ++this.tick)
        for (const [k, st] of this.stext) if (k.startsWith(`${id}:`)) this.dropText(k, st)
      }
    }
  }

  undo() {
    if (this.d.canUndo()) this.d.undo()
    this.touch('all')
    return this.state()
  }

  redo() {
    if (this.d.canRedo()) this.d.redo()
    this.touch('all')
    return this.state()
  }

  // ---- reading state ----

  pageIds() {
    const doc = this.d
    return Array.from({ length: doc.countPages() }, (_, i) => doc.findPage(i).asIndirect())
  }

  private indexOf(pageId: number) {
    const i = this.pageIds().indexOf(pageId)
    if (i < 0) throw new Error('Page not found')
    return i
  }

  private page(pageId: number) {
    return this.d.loadPage(this.indexOf(pageId))
  }

  private annotIdOf(a: mupdf.PDFAnnotation, i: number) {
    const obj = a.getObject()
    return obj.isIndirect() ? obj.asIndirect() : -(i + 1)
  }

  private findAnnot(page: mupdf.PDFPage, id: number) {
    const all = page.getAnnotations()
    const i = all.findIndex((a, n) => this.annotIdOf(a, n) === id)
    if (i < 0) throw new Error('Annotation not found')
    return all[i]
  }

  private findWidget(page: mupdf.PDFPage, id: number) {
    const all = page.getWidgets()
    const i = all.findIndex((w, n) => this.annotIdOf(w, n) === id)
    if (i < 0) throw new Error('Form field not found')
    return all[i]
  }

  private annotInfo(a: mupdf.PDFAnnotation, i: number): AnnotInfo {
    const irt = a.getObject().get('IRT')
    const info: AnnotInfo = {
      id: this.annotIdOf(a, i),
      type: a.getType(),
      rect: a.getBounds() as Rect,
      shape: shapeOf(a),
      contents: a.getContents(),
      author: a.hasAuthor() ? a.getAuthor() : '',
      modified: pdfDate(a.getModificationDate()),
      color: (() => {
        const c = rgb(a.getColor())
        return c ? hexOf(c) : null
      })(),
      replyTo: irt.isIndirect() ? irt.asIndirect() : null,
    }
    if (info.type === 'FreeText') info.fontSize = a.getDefaultAppearance().size
    return info
  }

  private widgetInfo(w: mupdf.PDFWidget, i: number): WidgetInfo {
    const kind: WidgetKind =
      w.getFieldType() === 'signature' ? 'signature'
      : w.isPushButton() ? 'button'
      : w.isCheckbox() ? 'checkbox'
      : w.isRadioButton() ? 'radio'
      : w.isChoice() ? 'choice'
      : 'text'
    const info: WidgetInfo = {
      id: this.annotIdOf(w, i),
      name: w.getName(),
      kind,
      rect: w.getBounds() as Rect,
      value: w.getValue() ?? '',
      multiline: kind === 'text' && w.isMultiline(),
      readOnly: w.isReadOnly(),
      required: (w.getFieldFlags() & 2) !== 0,
      tooltip: (() => {
        const f = this.fieldOf(w.getObject()).get('TU')
        return f.isString() ? f.asString() : ''
      })(),
      maxLen: kind === 'text' ? w.getMaxLen() : 0,
    }
    if (kind === 'checkbox' || kind === 'radio') {
      const states: string[] = []
      w.getObject().get('AP', 'N').forEach((_, k) => k !== 'Off' && states.push(String(k)))
      info.on = states[0] ?? 'Yes'
    }
    if (kind === 'choice') info.options = w.getOptions()
    return info
  }

  private pageInfo(index: number): PageInfo {
    const doc = this.d
    const id = doc.findPage(index).asIndirect()
    const page = doc.loadPage(index)
    const [x0, y0, x1, y1] = page.getBounds()
    const rot = page.getObject().getInheritable('Rotate')
    const info: PageInfo = {
      id,
      rev: this.revs.get(id) ?? this.tick,
      width: x1 - x0,
      height: y1 - y0,
      rotation: ((((rot.isNumber() ? rot.asNumber() : 0) % 360) + 360) % 360),
      label: page.getLabel() || String(index + 1),
      annots: page
        .getAnnotations()
        .map((a, i) => (a.getType() === 'Popup' || a.getType() === 'Link' ? null : this.annotInfo(a, i)))
        .filter((a): a is AnnotInfo => !!a),
      widgets: page.getWidgets().map((w, i) => this.widgetInfo(w, i)),
      links: page.getLinks().map((l, i) => ({ index: i, rect: l.getBounds() as Rect, uri: l.getURI(), page: l.isExternal() ? -1 : doc.resolveLink(l) })),
    }
    page.destroy()
    return info
  }

  private outline(): Bookmark[] {
    const walk = (items: ReturnType<mupdf.Document['loadOutline']>): Bookmark[] =>
      (items ?? []).map((it) => ({ title: it.title ?? '', page: it.page ?? -1, children: walk(it.down ?? []) }))
    return walk(this.d.loadOutline())
  }

  meta(): Metadata {
    const g = (k: string) => this.d.getMetaData(k) ?? ''
    return { title: g('info:Title'), author: g('info:Author'), subject: g('info:Subject'), keywords: g('info:Keywords') }
  }

  state(): DocState {
    const doc = this.d
    return {
      name: this.name,
      pages: Array.from({ length: doc.countPages() }, (_, i) => this.pageInfo(i)),
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
      outline: this.outline(),
      meta: this.meta(),
      encrypted: this.encrypted,
      attachments: Object.entries(doc.getEmbeddedFiles()).map(([name, ref]) => ({
        name,
        size: doc.getEmbeddedFileContents(ref)?.getLength() ?? 0,
      })),
      signatures: this.signatures,
    }
  }

  // ---- rendering ----

  /** Renders a page to RGBA pixels, leaving out comment replies and the annotation being dragged. */
  render(pageId: number, scale: number, skipAnnot?: number) {
    const page = this.page(pageId)
    const m = mupdf.Matrix.scale(scale, scale)
    const b = mupdf.Rect.transform(page.getBounds(), m)
    const bbox: Rect = [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])]
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true)
    pix.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
    page.runPageContents(dev, m)
    page.getAnnotations().forEach((a, i) => {
      if (this.annotIdOf(a, i) === skipAnnot) return
      if (a.getType() === 'Popup' || !a.getObject().get('IRT').isNull()) return
      if (a.getFlags() & (mupdf.PDFAnnotation.IS_HIDDEN | mupdf.PDFAnnotation.IS_NO_VIEW)) return
      a.run(dev, m)
    })
    page.runPageWidgets(dev, m)
    dev.close()
    dev.destroy()
    const out = { width: pix.getWidth(), height: pix.getHeight(), pixels: new Uint8ClampedArray(pix.getPixels()) }
    pix.destroy()
    page.destroy()
    return out
  }

  // ---- pages ----

  movePages(ids: number[], beforeId: number | null) {
    const order = this.pageIds()
    const moving = order.filter((id) => ids.includes(id))
    const rest = order.filter((id) => !ids.includes(id))
    const at = beforeId === null ? rest.length : rest.indexOf(beforeId)
    if (at < 0) return this.state()
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    this.op('Move pages', () => this.d.rearrangePages(next.map((id) => order.indexOf(id))), [])
    return this.state()
  }

  deletePages(ids: number[]) {
    const order = this.pageIds()
    if (ids.length >= order.length) throw new Error("A document needs at least one page; you can't delete them all.")
    this.op('Delete pages', () => this.d.rearrangePages(order.map((id, i) => (ids.includes(id) ? -1 : i)).filter((i) => i >= 0)), [])
    return this.state()
  }

  rotatePages(ids: number[], delta: number) {
    this.op(
      'Rotate pages',
      () => {
        for (const id of ids) {
          const obj = this.d.findPage(this.indexOf(id))
          const cur = obj.getInheritable('Rotate')
          obj.put('Rotate', ((((cur.isNumber() ? cur.asNumber() : 0) + delta) % 360) + 360) % 360)
        }
      },
      ids,
    )
    return this.state()
  }

  insertBlank(afterId: number | null) {
    const order = this.pageIds()
    const ref = afterId ?? order.at(-1)
    let box = A4
    if (ref !== undefined) {
      const p = this.page(ref)
      box = p.getBounds() as Rect
      p.destroy()
    }
    const at = afterId === null ? order.length : order.indexOf(afterId) + 1
    this.op('Insert page', () => this.d.insertPage(at, this.d.addPage([0, 0, box[2] - box[0], box[3] - box[1]], 0, {}, '')), [])
    return this.state()
  }

  /** Sets the visible area of pages, in page space of the first page. */
  cropPages(ids: number[], rect: Rect) {
    this.op(
      'Crop pages',
      () => {
        for (const id of ids) {
          const page = this.page(id)
          const [, , w, h] = page.getBounds()
          const r: Rect = [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(w, rect[2]), Math.min(h, rect[3])]
          // setPageBox takes page space and converts to PDF space itself.
          if (r[2] - r[0] >= 10 && r[3] - r[1] >= 10) page.setPageBox('CropBox', r)
          page.destroy()
        }
      },
      ids,
    )
    return this.state()
  }

  /** A new PDF holding just the given pages, keeping their structure. */
  extract(ids: number[]): Uint8Array {
    const order = this.pageIds()
    const copy = this.reopen()
    copy.rearrangePages(ids.map((id) => order.indexOf(id)))
    const out = copy.saveToBuffer('garbage=compact,compress').asUint8Array().slice()
    copy.destroy()
    return out
  }

  split(groups: number[][]): Uint8Array {
    const files: Record<string, Uint8Array> = {}
    for (const g of groups) {
      const pages = this.pageIds()
      const label = g.length > 1 ? `${g[0] + 1}-${g.at(-1)! + 1}` : `${g[0] + 1}`
      files[`${this.name}-p${label}.pdf`] = this.extract(g.map((i) => pages[i]))
    }
    return zipSync(files, { level: 0 })
  }

  /** An independent copy of the current document. */
  private reopen() {
    const doc = mupdf.Document.openDocument(this.d.saveToBuffer('').asUint8Array().slice(), 'application/pdf').asPDF()!
    if (doc.needsPassword()) doc.authenticatePassword(this.password ?? '')
    return doc
  }

  // ---- annotations ----

  addAnnot(pageId: number, spec: AnnotSpec) {
    let id = 0
    this.op(
      `Add ${spec.type}`,
      () => {
        const page = this.page(pageId)
        const a = page.createAnnotation(spec.type)
        a.setAuthor(this.author)
        a.setCreationDate(new Date())
        a.setModificationDate(new Date())
        switch (spec.type) {
          case 'Highlight':
          case 'Underline':
          case 'StrikeOut':
          case 'Squiggly':
            a.setQuadPoints(spec.quads)
            a.setColor(spec.color)
            break
          case 'Ink':
            a.setInkList(spec.strokes)
            a.setColor(spec.color)
            a.setBorderWidth(spec.width)
            break
          case 'FreeText': {
            a.setDefaultAppearance('Helv', spec.size, spec.color)
            a.setBorderWidth(0)
            a.setContents(spec.text)
            a.setRect(this.freeTextRect(spec.at, spec.text, spec.size))
            break
          }
          case 'Square':
          case 'Circle':
            a.setRect(spec.rect)
            a.setColor(spec.color ?? [])
            if (spec.fill) a.setInteriorColor(spec.fill)
            a.setBorderWidth(spec.color ? spec.width : 0)
            break
          case 'Line':
            a.setLine(spec.a, spec.b)
            a.setColor(spec.color)
            a.setBorderWidth(spec.width)
            if (spec.arrow) a.setLineEndingStyles('None', 'OpenArrow')
            break
          case 'Text':
            a.setRect([spec.at[0], spec.at[1], spec.at[0] + 20, spec.at[1] + 20])
            a.setIcon('Comment')
            a.setColor(spec.color)
            a.setContents(spec.text)
            break
          case 'Stamp':
            a.setRect(spec.rect)
            a.setStampImage(new mupdf.Image(spec.png))
            a.setIntent('StampImage')
            break
          case 'Redact':
            if (spec.quads) a.setQuadPoints(spec.quads)
            if (spec.rect) a.setRect(spec.rect)
            break
        }
        a.update()
        id = this.annotIdOf(a, page.getAnnotations().length - 1)
        page.destroy()
      },
      [pageId],
    )
    return { id, state: this.state() }
  }

  private font(name: BaseFont) {
    let f = this.fonts.get(name)
    if (!f) this.fonts.set(name, (f = new mupdf.Font(name)))
    return f
  }

  textWidth(text: string, size: number, font: BaseFont = 'Helvetica') {
    const f = this.font(font)
    let w = 0
    for (const ch of text) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!), 0)
    return w * size
  }

  private freeTextRect([x, y]: Point, text: string, size: number): Rect {
    const lines = text.split('\n')
    const w = Math.max(20, ...lines.map((l) => this.textWidth(l, size))) + size * 0.6
    return [x, y, x + w, y + lines.length * size * LINE_HEIGHT + size * 0.4]
  }

  updateAnnot(pageId: number, annotId: number, patch: AnnotPatch) {
    this.op(
      'Edit annotation',
      () => {
        const page = this.page(pageId)
        const a = this.findAnnot(page, annotId)
        if (patch.contents !== undefined) a.setContents(patch.contents)
        if (patch.color) {
          if (a.getType() === 'FreeText') {
            const da = a.getDefaultAppearance()
            a.setDefaultAppearance(da.font, da.size, patch.color)
          } else {
            a.setColor(patch.color)
          }
        }
        if (patch.fontSize && a.getType() === 'FreeText') {
          const da = a.getDefaultAppearance()
          a.setDefaultAppearance(da.font, patch.fontSize, da.color)
        }
        if (patch.move) {
          const [dx, dy] = patch.move
          const shape = shapeOf(a)
          if (shape === 'ink') a.setInkList(a.getInkList().map((s) => s.map(([x, y]) => [x + dx, y + dy] as Point)))
          else if (shape === 'quads') a.setQuadPoints(a.getQuadPoints().map((q) => shiftQuad(q, dx, dy)))
          else if (shape === 'line') {
            const [p, q] = a.getLine()
            a.setLine([p[0] + dx, p[1] + dy], [q[0] + dx, q[1] + dy])
          } else if (shape === 'vertices') a.setVertices(a.getVertices().map(([x, y]) => [x + dx, y + dy] as Point))
          else {
            const [x0, y0, x1, y1] = a.getRect()
            a.setRect([x0 + dx, y0 + dy, x1 + dx, y1 + dy])
          }
        }
        if (patch.rect) a.setRect(patch.rect)
        if (a.getType() === 'FreeText' && (patch.contents !== undefined || patch.fontSize)) {
          const [x, y] = a.getRect()
          a.setRect(this.freeTextRect([x, y], a.getContents(), a.getDefaultAppearance().size))
        }
        a.setModificationDate(new Date())
        a.update()
        page.destroy()
      },
      [pageId],
    )
    return this.state()
  }

  deleteAnnot(pageId: number, annotId: number) {
    this.op(
      'Delete annotation',
      () => {
        const page = this.page(pageId)
        const target = this.findAnnot(page, annotId)
        // Replies go with their parent.
        page.getAnnotations().forEach((a) => {
          const irt = a.getObject().get('IRT')
          if (irt.isIndirect() && irt.asIndirect() === annotId) page.deleteAnnotation(a)
        })
        page.deleteAnnotation(target)
        page.destroy()
      },
      [pageId],
    )
    return this.state()
  }

  reply(pageId: number, parentId: number, text: string) {
    this.op(
      'Reply',
      () => {
        const page = this.page(pageId)
        const parent = this.findAnnot(page, parentId)
        const [x, y] = parent.getBounds()
        const a = page.createAnnotation('Text')
        a.setRect([x, y, x + 20, y + 20])
        a.setContents(text)
        a.setAuthor(this.author)
        a.setCreationDate(new Date())
        a.setModificationDate(new Date())
        a.getObject().put('IRT', parent.getObject())
        a.update()
        page.destroy()
      },
      [pageId],
    )
    return this.state()
  }

  /** Burns annotations and/or form fields into the page content. */
  flatten(annots: boolean, widgets: boolean) {
    this.op('Flatten', () => this.d.bake(annots, widgets))
    return this.state()
  }

  // ---- forms ----

  setField(pageId: number, widgetId: number, value: string | boolean) {
    this.op(
      'Fill form',
      () => {
        const page = this.page(pageId)
        const w = this.findWidget(page, widgetId)
        if (w.isText()) w.setTextValue(String(value))
        else if (w.isChoice()) w.setChoiceValue(String(value))
        else if (w.isCheckbox() || w.isRadioButton()) {
          const info = this.widgetInfo(w, 0)
          if ((info.value === info.on) !== value) w.toggle()
        }
        w.update()
        page.update()
        page.destroy()
      },
      'all', // radio groups and calculated fields can span pages
    )
    return this.state()
  }

  // ---- text ----

  private structured(pageId: number) {
    const key = `${pageId}:${this.revs.get(pageId) ?? this.tick}`
    let st = this.stext.get(key)
    if (st) {
      // Refresh its position so the cache evicts least recently used pages first.
      this.stext.delete(key)
    } else {
      const page = this.page(pageId)
      st = page.toStructuredText('preserve-whitespace,preserve-spans')
      page.destroy()
      // Entries for untouched pages are keyed by the global tick, so drop older keys for this page.
      for (const [k, old] of this.stext) if (k.startsWith(`${pageId}:`)) this.dropText(k, old)
      while (this.stext.size >= TEXT_CACHE_PAGES) {
        const [k, old] = this.stext.entries().next().value!
        this.dropText(k, old)
      }
    }
    this.stext.set(key, st)
    return st
  }

  private dropText(key: string, st: mupdf.StructuredText) {
    this.stext.delete(key)
    st.destroy()
  }

  /** Number of pages whose extracted text is currently cached (for tests). */
  get cachedTextPages() {
    return this.stext.size
  }

  selectText(pageId: number, a: Point, b: Point) {
    const st = this.structured(pageId)
    return { quads: st.highlight(a, b) as Quad[], text: st.copy(a, b) }
  }

  pageText(pageId: number) {
    return this.structured(pageId).asText()
  }

  search(needle: string, max = 500): SearchHit[] {
    const hits: SearchHit[] = []
    const ids = this.pageIds()
    const lower = needle.toLowerCase()
    for (const [pageIndex, pageId] of ids.entries()) {
      const st = this.structured(pageId)
      const found = st.search(needle, 'ignore-case') as Quad[][]
      if (!found.length) continue
      const text = st.asText().replace(/\s+/g, ' ')
      let from = 0
      for (const quads of found) {
        const at = text.toLowerCase().indexOf(lower, from)
        from = at >= 0 ? at + lower.length : from
        const snippet = at >= 0 ? text.slice(Math.max(0, at - 30), at + needle.length + 40) : needle
        hits.push({ pageId, pageIndex, quads, snippet })
        if (hits.length >= max) return hits
      }
    }
    return hits
  }

  /** Every horizontal text line on a page with its dominant style. */
  textLines(pageId: number): TextLine[] {
    return this.textBlocks(pageId).flatMap((b) => b.lines)
  }

  /** Paragraphs of horizontal text, with the alignment and line spacing of each. */
  textBlocks(pageId: number): TextBlock[] {
    const blocks: TextLine[][] = []
    let block: TextLine[] = []
    let cur: TextLine | null = null
    this.structured(pageId).walk({
      beginTextBlock() {
        block = []
      },
      beginLine(bbox, _wmode, dir) {
        cur = Math.abs(dir[1]) < 0.01 && dir[0] > 0
          ? { bbox: bbox as Rect, origin: [0, 0], text: '', font: '', size: 0, bold: false, italic: false, serif: false, mono: false, color: [0, 0, 0] }
          : null
      },
      onChar(c, origin, font, size, _quad, color) {
        if (!cur) return
        if (!cur.text) Object.assign(cur, styleOf(font, size, color), { origin: origin as Point })
        cur.text += c
      },
      endLine() {
        if (cur && cur.text.trim()) block.push(cur)
        cur = null
      },
      endTextBlock() {
        if (block.length) blocks.push(block)
      },
    })

    // MuPDF sometimes groups unrelated lines into one block; split where the style or spacing breaks.
    const paragraphs: TextLine[][] = []
    for (const lines of blocks) {
      let para: TextLine[] = []
      for (const line of lines) {
        const prev = para.at(-1)
        const gap = prev ? line.origin[1] - prev.origin[1] : 0
        const sameStyle = prev && Math.abs(prev.size - line.size) < 0.6 && prev.bold === line.bold && prev.font === line.font
        if (prev && (!sameStyle || gap <= 0 || gap > prev.size * 1.75)) {
          paragraphs.push(para)
          para = []
        }
        para.push(line)
      }
      if (para.length) paragraphs.push(para)
    }
    return paragraphs.map(toBlock)
  }

  /**
   * Replaces a paragraph of existing page text. The original glyphs are removed (images and
   * graphics underneath stay), and the new text is laid out to the paragraph's width with its
   * alignment, spacing and color, reusing the original font when it covers every character.
   */
  replaceBlock(pageId: number, block: TextBlock, text: string) {
    this.op(
      'Edit text',
      () => {
        // Find the original font first: removing the old text can drop it from the page resources.
        const family = this.cssFamily(pageId, block, text)
        const page = this.page(pageId)
        for (const line of block.lines) {
          const [x0, y0, x1, y1] = line.bbox
          const inset = (y1 - y0) * 0.2
          const r = page.createAnnotation('Redact')
          r.setRect([x0 - 0.5, y0 + inset, x1 + 0.5, y1 - inset])
          r.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
        }
        const [, , W] = page.getBounds()
        page.destroy()
        if (!text.trim()) return
        const [x0, , x1] = block.bbox
        // A single line may grow to the page margin; paragraphs keep their width and reflow.
        const width = block.lines.length > 1 ? x1 - x0 : Math.max(x1 - x0, W - x0 - 18)
        const css = [
          `font-family:${family.css}`, `font-size:${block.size}px`, `line-height:${(block.leading / block.size).toFixed(3)}`,
          `color:${hexOf(block.color)}`, `text-align:${block.lines.length > 1 ? block.align : 'left'}`,
          `font-weight:${block.bold && !family.original ? 'bold' : 'normal'}`, `font-style:${block.italic && !family.original ? 'italic' : 'normal'}`,
          block.lines.length > 1 ? 'white-space:pre-wrap' : 'white-space:pre',
        ].join(';')
        this.placeHtml(pageId, `<p style="margin:0;${css}">${escapeHtml(text)}</p>`, width, { x: x0, baseline: block.lines[0].origin[1] })
      },
      [pageId],
    )
    return this.state()
  }

  /** Replaces one line of text (a single-line paragraph). */
  replaceText(pageId: number, line: TextLine, text: string) {
    return this.replaceBlock(pageId, toBlock([line]), text)
  }

  /**
   * The CSS font family for new text in a paragraph: the original embedded font if it has a
   * glyph for every character, otherwise the closest generic family.
   */
  private cssFamily(pageId: number, block: TextBlock, text: string) {
    const generic = block.mono ? 'monospace' : block.serif ? 'serif' : 'sans-serif'
    const original = this.embeddedFont(pageId, block.font)
    if (original && [...text].every((ch) => /\s/.test(ch) || original.font.encodeCharacter(ch.codePointAt(0)!) > 0))
      return { css: `'${original.key}',${generic}`, original: true }
    return { css: generic, original: false }
  }

  /** Loads the font file embedded for a font name used on a page, if there is one. */
  private embeddedFont(pageId: number, name: string) {
    const page = this.page(pageId)
    const fonts = page.getObject().getInheritable('Resources').get('Font')
    page.destroy()
    if (!fonts.isDictionary()) return null
    const wanted = name.replace(/^[A-Z]{6}\+/, '')
    let found: { key: string; font: mupdf.Font } | null = null
    fonts.forEach((ref) => {
      if (found) return
      const dict = ref.resolve()
      const base = dict.get('BaseFont').isName() ? dict.get('BaseFont').asName().replace(/^[A-Z]{6}\+/, '') : ''
      if (base !== wanted && !wanted.startsWith(base) && !base.startsWith(wanted)) return
      const desc = dict.get('DescendantFonts').isArray() ? dict.get('DescendantFonts').get(0).resolve().get('FontDescriptor') : dict.get('FontDescriptor')
      if (!desc.isDictionary()) return
      const file = ['FontFile2', 'FontFile3', 'FontFile'].map((k) => desc.get(k)).find((f) => f.isStream())
      if (!file) return
      const key = `OQFont${ref.isIndirect() ? ref.asIndirect() : base}`
      let font = loadedFonts.get(key)
      if (!font) {
        try {
          // Keep the original name, so the new text names the same font in the PDF.
          font = new mupdf.Font(base, file.readStream())
        } catch {
          return
        }
        loadedFonts.set(key, font)
      }
      found = { key, font }
    })
    return found as { key: string; font: mupdf.Font } | null
  }

  /**
   * Lays out HTML with MuPDF's layout engine and draws the result into the page content, so the
   * text is real, searchable PDF text with proper shaping, wrapping and font fallback.
   * The first baseline lands on `baseline` (page space) at `x`.
   */
  private placeHtml(pageId: number, html: string, width: number, at: { x: number; baseline?: number; top?: number; angle?: number; opacity?: number }) {
    const page0 = '<style>@page{margin:0}body{margin:0;padding:0}</style>'
    const src = mupdf.Document.openDocument(new TextEncoder().encode(`<html><head>${page0}</head><body>${html}</body></html>`), 'text/html')
    src.layout(width, 10_000, 12)
    const laid = src.loadPage(0)
    let firstBaseline = 0
    let bottom = 0
    laid.toStructuredText('').walk({
      onChar(_c, origin) {
        if (!firstBaseline) firstBaseline = origin[1]
      },
      beginLine(bbox) {
        bottom = Math.max(bottom, bbox[3])
      },
    })
    const height = Math.ceil(bottom + 2)
    const buf = new mupdf.Buffer()
    const writer = new mupdf.DocumentWriter(buf, 'pdf', '')
    const dev = writer.beginPage([0, 0, width, height])
    laid.run(dev, mupdf.Matrix.identity)
    writer.endPage()
    writer.close()
    const frag = mupdf.Document.openDocument(buf.asUint8Array().slice(), 'application/pdf').asPDF() as mupdf.PDFDocument
    const fp = frag.findPage(0)

    const doc = this.d
    const map = doc.newGraftMap()
    const contents = fp.get('Contents')
    const parts: string[] = []
    if (contents.isArray()) contents.forEach((s) => parts.push(s.readStream().asString()))
    else parts.push(contents.readStream().asString())
    const xobject = doc.addStream(parts.join('\n'), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: map.graftObject(fp.get('Resources')),
    })
    frag.destroy()
    src.destroy()

    const top = at.top ?? (at.baseline ?? 0) - firstBaseline
    // Fragment PDF space (y up) -> fragment top-left space (y down) -> rotated about its origin -> page space.
    let m = mupdf.Matrix.concat([1, 0, 0, -1, 0, height], mupdf.Matrix.rotate(-(at.angle ?? 0)))
    m = mupdf.Matrix.concat(m, mupdf.Matrix.translate(at.x, top))
    this.appendContent(pageId, (names) => {
      const x = names.xobject(xobject)
      const gs = at.opacity !== undefined && at.opacity < 1 ? `/${names.extGState(at.opacity)} gs ` : ''
      return `q ${gs}${m.map((v) => +v.toFixed(5)).join(' ')} cm /${x} Do Q\n`
    })
  }

  /** Writes text into the page content stream (not as an annotation). */
  private appendText(pageId: number, runs: TextRun[]) {
    this.appendContent(pageId, (names) => {
      let ops = ''
      for (const run of runs) {
        const fname = names.font(run.font)
        const gs = names.extGState(run.opacity ?? 1)
        const t = ((run.angle ?? 0) * Math.PI) / 180
        const [c, s] = [Math.cos(t), Math.sin(t)]
        const lines = run.text.split('\n')
        const natural = run.width ? this.textWidth(lines[0], run.size, run.font) : 0
        const tz = natural > 0 ? ` ${((100 * run.width!) / natural).toFixed(2)} Tz` : ''
        ops += `q /${gs} gs ${run.color.map((v) => v.toFixed(3)).join(' ')} rg BT /${fname} ${run.size.toFixed(2)} Tf${tz}${run.invisible ? ' 3 Tr' : ''}\n`
        lines.forEach((line, i) => {
          const down = i * run.size * LINE_HEIGHT
          // Page space has y pointing down, so the text matrix flips y back up.
          const x = run.x - s * down
          const y = run.y + c * down
          const hex = [...line].map((ch) => winAnsi(ch.codePointAt(0)!).toString(16).padStart(2, '0')).join('')
          ops += `${c.toFixed(5)} ${(-s).toFixed(5)} ${(-s).toFixed(5)} ${(-c).toFixed(5)} ${x.toFixed(2)} ${y.toFixed(2)} Tm <${hex}> Tj\n`
        })
        ops += 'ET Q\n'
      }
      return ops
    })
  }

  /**
   * Appends drawing operators to a page, in page space (y down), wrapped so they can't affect
   * or be affected by the existing content. `build` names the resources it uses.
   */
  private appendContent(
    pageId: number,
    build: (names: { font(f: BaseFont): string; extGState(alpha: number): string; xobject(ref: mupdf.PDFObject): string }) => string,
  ) {
    const doc = this.d
    const page = this.page(pageId)
    const obj = page.getObject()

    let res = obj.get('Resources')
    if (res.isNull()) {
      // Inherited or missing: give the page its own copy so other pages are unaffected.
      const inherited = obj.getInheritable('Resources')
      res = doc.newDictionary()
      if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v))
      obj.put('Resources', res)
    }
    const sub = (key: string) => {
      let d = res.get(key)
      if (d.isNull()) {
        d = doc.newDictionary()
        res.put(key, d)
      }
      return d
    }
    const fresh = (dict: mupdf.PDFObject, prefix: string) => {
      let n = 1
      while (!dict.get(`${prefix}${n}`).isNull()) n++
      return `${prefix}${n}`
    }
    const fonts = new Map<string, string>()
    const states = new Map<number, string>()
    const names = {
      font: (f: BaseFont) => {
        let n = fonts.get(f)
        if (!n) {
          const dict = sub('Font')
          n = fresh(dict, 'OQF')
          dict.put(n, doc.addSimpleFont(this.font(f), 'Latin'))
          fonts.set(f, n)
        }
        return n
      },
      extGState: (alpha: number) => {
        let n = states.get(alpha)
        if (!n) {
          const dict = sub('ExtGState')
          n = fresh(dict, 'OQG')
          dict.put(n, doc.addObject({ Type: 'ExtGState', ca: alpha, CA: alpha }))
          states.set(alpha, n)
        }
        return n
      },
      xobject: (ref: mupdf.PDFObject) => {
        const dict = sub('XObject')
        const n = fresh(dict, 'OQX')
        dict.put(n, ref)
        return n
      },
    }
    const inv = mupdf.Matrix.invert(page.getTransform())
    const ops = `${inv.map((v) => +v.toFixed(5)).join(' ')} cm\n${build(names)}`

    const contents = doc.newArray()
    contents.push(doc.addStream('q\n', {}))
    const old = obj.get('Contents')
    if (old.isArray()) old.forEach((v) => contents.push(v))
    else if (!old.isNull()) contents.push(old)
    contents.push(doc.addStream(`Q\nq\n${ops}Q\n`, {}))
    obj.put('Contents', contents)
    page.destroy()
  }

  /** Watermarks, headers, footers, page numbers and Bates numbers, written into the page content. */
  stamp(spec: StampSpec) {
    const order = this.pageIds()
    const total = order.length
    const date = new Date().toLocaleDateString()
    let bates = spec.batesStart ?? 1
    this.op(
      'Stamp pages',
      () => {
        for (const id of order) {
          if (!spec.pageIds.includes(id)) continue
          const text = spec.template
            .replaceAll('{page}', String(order.indexOf(id) + 1))
            .replaceAll('{pages}', String(total))
            .replaceAll('{date}', date)
            .replaceAll('{name}', this.name)
            .replaceAll('{bates}', String(bates++).padStart(spec.batesDigits ?? 6, '0'))
          const page = this.page(id)
          const [, , W, H] = page.getBounds()
          page.destroy()
          const lines = text.split('\n')
          const widest = Math.max(...lines.map((l) => this.textWidth(l, 1)), 0.01)
          const size =
            spec.size === 'fit'
              ? Math.min((0.75 * Math.hypot(W, H) * (spec.angle ? 1 : 0.6)) / widest, Math.min(W, H) / 3)
              : spec.size
          const w = widest * size
          const block = size * (1 + LINE_HEIGHT * (lines.length - 1))
          const m = 36
          const t = (spec.angle * Math.PI) / 180
          let x: number, y: number
          if (spec.position === 'center') {
            // Centre the text block on the page, along its own (possibly rotated) axes.
            const [dx, dy] = [Math.cos(t), -Math.sin(t)]
            const [ux, uy] = [-Math.sin(t), -Math.cos(t)]
            const along = -w / 2
            const up = block / 2 - size * 0.75
            x = W / 2 + dx * along + ux * up
            y = H / 2 + dy * along + uy * up
          } else {
            const col = spec.position[1]
            x = col === 'l' ? m : col === 'c' ? (W - w) / 2 : W - m - w
            y = spec.position[0] === 't' ? m * 0.6 + size : H - m * 0.6 - block + size
          }
          this.appendText(id, [{ text, x, y, size, font: 'Helvetica', color: spec.color, opacity: spec.opacity, angle: spec.angle }])
        }
      },
      spec.pageIds,
    )
    return this.state()
  }

  // ---- redaction ----

  /** Permanently removes everything under every redaction mark. */
  applyRedactions() {
    const pages: number[] = []
    this.op('Apply redactions', () => {
      for (const [i, id] of this.pageIds().entries()) {
        const page = this.d.loadPage(i)
        if (page.getAnnotations().some((a) => a.getType() === 'Redact')) {
          page.applyRedactions(
            true,
            mupdf.PDFPage.REDACT_IMAGE_PIXELS,
            mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
            mupdf.PDFPage.REDACT_TEXT_REMOVE,
          )
          pages.push(id)
        }
        page.destroy()
      }
    })
    return { count: pages.length, state: this.state() }
  }

  /** Marks every match of a search (e.g. a name or account number) for redaction. */
  markForRedaction(needles: string[]) {
    let n = 0
    this.op('Mark for redaction', () => {
      for (const [i, id] of this.pageIds().entries()) {
        const st = this.structured(id)
        const page = this.d.loadPage(i)
        for (const needle of needles) {
          for (const quads of st.search(needle, 'ignore-case') as Quad[][]) {
            const a = page.createAnnotation('Redact')
            a.setQuadPoints(quads)
            a.setContents(needle)
            a.update()
            n++
          }
        }
        page.destroy()
      }
    })
    return { count: n, state: this.state() }
  }

  /** Marks every match of a regular expression (e.g. all email addresses) for redaction. */
  markPattern(source: string) {
    const re = new RegExp(source, 'gi')
    const found = new Set<string>()
    for (const id of this.pageIds()) for (const m of this.pageText(id).matchAll(re)) if (m[0].trim()) found.add(m[0].trim())
    return found.size ? this.markForRedaction([...found]) : { count: 0, state: this.state() }
  }

  // ---- bookmarks ----

  private outlineAt(path: number[]) {
    const it = this.d.outlineIterator()
    path.forEach((idx, depth) => {
      for (let i = 0; i < idx; i++) it.next()
      if (depth < path.length - 1) it.down()
    })
    return it
  }

  private linkTo(pageIndex: number) {
    return this.d.formatLinkURI({ type: 'Fit', chapter: 0, page: pageIndex, x: 0, y: 0, width: 0, height: 0, zoom: 0 })
  }

  addBookmark(title: string, pageIndex: number) {
    this.op('Add bookmark', () => {
      const it = this.d.outlineIterator()
      while (it.item()) if (it.next() !== mupdf.OutlineIterator.ITERATOR_AT_ITEM) break
      it.insert({ title, uri: this.linkTo(pageIndex), open: false })
    }, [])
    return this.state()
  }

  renameBookmark(path: number[], title: string) {
    this.op('Rename bookmark', () => {
      const it = this.outlineAt(path)
      const item = it.item()
      if (item) it.update({ ...item, title })
    }, [])
    return this.state()
  }

  deleteBookmark(path: number[]) {
    this.op('Delete bookmark', () => this.outlineAt(path).delete(), [])
    return this.state()
  }

  // ---- form designer ----

  /** The document's AcroForm dictionary, created with default fonts if there isn't one. */
  private acroForm() {
    const doc = this.d
    const root = doc.getTrailer().get('Root')
    let form = root.get('AcroForm')
    if (form.isNull()) {
      form = doc.addObject(doc.newDictionary())
      root.put('AcroForm', form)
    }
    if (form.get('Fields').isNull()) form.put('Fields', doc.newArray())
    if (form.get('DA').isNull()) form.put('DA', doc.newString('/Helv 0 Tf 0 g'))
    let dr = form.get('DR')
    if (dr.isNull()) {
      dr = doc.newDictionary()
      form.put('DR', dr)
    }
    let fonts = dr.get('Font')
    if (fonts.isNull()) {
      fonts = doc.newDictionary()
      dr.put('Font', fonts)
    }
    if (fonts.get('Helv').isNull()) fonts.put('Helv', doc.addSimpleFont(this.font('Helvetica'), 'Latin'))
    return form
  }

  /** Every fully qualified field name in the document. */
  private fieldNames() {
    const names = new Set<string>()
    const walk = (f: mupdf.PDFObject, prefix: string) => {
      const t = f.get('T')
      const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix
      if (name) names.add(name)
      const kids = f.get('Kids')
      if (kids.isArray()) kids.forEach((k) => walk(k.resolve(), name))
    }
    const fields = this.d.getTrailer().get('Root', 'AcroForm', 'Fields')
    if (fields.isArray()) fields.forEach((f) => walk(f.resolve(), ''))
    return names
  }

  private uniqueName(base: string) {
    const names = this.fieldNames()
    const clean = base.replace(/[.\s]+/g, ' ').trim() || 'Field'
    if (!names.has(clean)) return clean
    let n = 2
    while (names.has(`${clean} ${n}`)) n++
    return `${clean} ${n}`
  }

  /** Appearance streams for a checkbox or radio button of a given size, off and on. */
  private toggleAppearance(kind: 'checkbox' | 'radio', w: number, h: number) {
    const doc = this.d
    const s = Math.min(w, h)
    const circle = (cx: number, cy: number, r: number) => {
      const k = 0.5523 * r
      return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ` +
        `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c`
    }
    const frame = kind === 'checkbox'
      ? `1 g 0.5 0.5 ${w - 1} ${h - 1} re f 0.35 G 1 w 0.5 0.5 ${w - 1} ${h - 1} re S`
      : `1 g ${circle(w / 2, h / 2, s / 2 - 0.5)} f 0.35 G 1 w ${circle(w / 2, h / 2, s / 2 - 0.5)} S`
    const mark = kind === 'checkbox'
      ? `0 G ${(s * 0.12).toFixed(2)} w 1 J 1 j ${w * 0.22} ${h * 0.52} m ${w * 0.42} ${h * 0.28} l ${w * 0.8} ${h * 0.76} l S`
      : `0 g ${circle(w / 2, h / 2, s * 0.22)} f`
    const stream = (ops: string) => doc.addStream(`q ${ops} Q`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] })
    return { off: stream(frame), on: stream(`${frame} ${mark}`) }
  }

  /** Converts a page-space rectangle to the page's PDF coordinates. */
  private pdfRect(pageId: number, rect: Rect): Rect {
    const page = this.page(pageId)
    const r = mupdf.Rect.transform(rect, mupdf.Matrix.invert(page.getTransform())) as Rect
    page.destroy()
    return r
  }

  /** Adds a form field. Radio buttons sharing a `group` belong to one field. */
  addField(pageId: number, kind: FieldKind, rect: Rect, opts: { name?: string; group?: string; options?: string[] } = {}) {
    let name = ''
    this.op('Add form field', () => {
      const doc = this.d
      const form = this.acroForm()
      const pageObj = this.d.findPage(this.indexOf(pageId))
      const r = this.pdfRect(pageId, rect)
      const [w, h] = [r[2] - r[0], r[3] - r[1]]
      const base = { Type: 'Annot', Subtype: 'Widget', Rect: r, F: 4, P: pageObj }
      const size = Math.max(6, Math.min(12, Math.round(h * 0.6)))
      let widget: mupdf.PDFObject
      let field: mupdf.PDFObject | null = null
      const label = opts.name ?? { text: 'Text', multiline: 'Text', checkbox: 'Checkbox', radio: 'Choice', choice: 'Dropdown', signature: 'Signature' }[kind]

      if (kind === 'radio') {
        const groupName = opts.group ?? label
        let parent: mupdf.PDFObject | null = null
        form.get('Fields').forEach((f) => {
          const d = f.resolve()
          if (!parent && d.get('T').isString() && d.get('T').asString() === groupName && d.get('FT').toString() === '/Btn') parent = f
        })
        if (!parent) {
          name = this.uniqueName(groupName)
          parent = doc.addObject({ FT: 'Btn', Ff: 49152, T: doc.newString(name), V: 'Off', Kids: doc.newArray() })
          form.get('Fields').push(parent)
        } else {
          name = groupName
        }
        const p = parent as mupdf.PDFObject
        const state = `Option${p.get('Kids').length + 1}`
        const ap = this.toggleAppearance('radio', w, h)
        widget = doc.addObject({ ...base, Parent: p, AS: 'Off', MK: { CA: doc.newString('l') }, AP: { N: { Off: ap.off, [state]: ap.on } } })
        p.get('Kids').push(widget)
      } else {
        name = this.uniqueName(label)
        const common = { ...base, T: doc.newString(name) }
        if (kind === 'checkbox') {
          const ap = this.toggleAppearance('checkbox', w, h)
          widget = doc.addObject({ ...common, FT: 'Btn', V: 'Off', AS: 'Off', MK: { CA: doc.newString('4') }, AP: { N: { Off: ap.off, Yes: ap.on } } })
        } else if (kind === 'choice') {
          const options = (opts.options?.length ? opts.options : ['Option 1', 'Option 2']).map((o) => doc.newString(o))
          widget = doc.addObject({ ...common, FT: 'Ch', Ff: 131072, Opt: options, V: doc.newString(''), DA: doc.newString(`/Helv ${size} Tf 0 g`) })
        } else if (kind === 'signature') {
          widget = doc.addObject({ ...common, FT: 'Sig' })
        } else {
          widget = doc.addObject({
            ...common, FT: 'Tx', V: doc.newString(''), DA: doc.newString(`/Helv ${kind === 'multiline' ? 10 : size} Tf 0 g`),
            ...(kind === 'multiline' ? { Ff: 4096 } : {}),
          })
        }
        field = widget
        form.get('Fields').push(field)
      }

      let annots = pageObj.get('Annots')
      if (annots.isNull()) {
        annots = doc.newArray()
        pageObj.put('Annots', annots)
      }
      annots.push(widget)
      if (kind === 'text' || kind === 'multiline' || kind === 'choice') {
        const page = this.page(pageId)
        page.getWidgets().find((x) => x.getObject().asIndirect() === widget.asIndirect())?.update()
        page.destroy()
      }
    }, [pageId])
    return { name, state: this.state() }
  }

  /** The field dictionary behind a widget: the widget itself, or its parent for radio buttons. */
  private fieldOf(widget: mupdf.PDFObject) {
    return widget.get('T').isString() || widget.get('Parent').isNull() ? widget : widget.get('Parent')
  }

  updateField(pageId: number, widgetId: number, props: FieldProps) {
    this.op('Edit form field', () => {
      const doc = this.d
      const page = this.page(pageId)
      const w = this.findWidget(page, widgetId)
      const field = this.fieldOf(w.getObject())
      const flags = field.get('Ff').isNumber() ? field.get('Ff').asNumber() : 0
      const set = (bit: number, on: boolean | undefined) => (on === undefined ? flags : on ? flags | bit : flags & ~bit)
      let ff = set(1, props.readOnly)
      ff = props.required === undefined ? ff : props.required ? ff | 2 : ff & ~2
      if (props.multiline !== undefined && field.get('FT').toString() === '/Tx') ff = props.multiline ? ff | 4096 : ff & ~4096
      field.put('Ff', ff)
      if (props.name && props.name !== w.getName()) field.put('T', doc.newString(this.uniqueName(props.name)))
      if (props.tooltip !== undefined) field.put('TU', doc.newString(props.tooltip))
      if (props.maxLen !== undefined) props.maxLen > 0 ? field.put('MaxLen', props.maxLen) : field.delete('MaxLen')
      if (props.options && field.get('FT').toString() === '/Ch') {
        const arr = doc.newArray()
        props.options.forEach((o) => arr.push(doc.newString(o)))
        field.put('Opt', arr)
      }
      if (!w.isCheckbox() && !w.isRadioButton()) w.update()
      page.destroy()
    }, 'all')
    return this.state()
  }

  moveField(pageId: number, widgetId: number, rect: Rect) {
    this.op('Move form field', () => {
      const page = this.page(pageId)
      const w = this.findWidget(page, widgetId)
      w.setRect(rect)
      if (w.isCheckbox() || w.isRadioButton()) {
        // Redraw the on/off appearances at the new size, keeping the state names.
        const obj = w.getObject()
        const r = this.pdfRect(pageId, rect)
        const ap = this.toggleAppearance(w.isCheckbox() ? 'checkbox' : 'radio', r[2] - r[0], r[3] - r[1])
        const n = obj.get('AP', 'N')
        n.forEach((_, k) => n.put(k, String(k) === 'Off' ? ap.off : ap.on))
      } else {
        w.update()
      }
      page.destroy()
    }, [pageId])
    return this.state()
  }

  deleteField(pageId: number, widgetId: number) {
    this.op('Delete form field', () => {
      const page = this.page(pageId)
      const obj = this.findWidget(page, widgetId).getObject()
      page.destroy()
      const num = obj.asIndirect()
      const without = (arr: mupdf.PDFObject, n: number) => {
        for (let i = arr.length - 1; i >= 0; i--) if (arr.get(i).asIndirect() === n) arr.delete(i)
      }
      const annots = this.d.findPage(this.indexOf(pageId)).get('Annots')
      if (annots.isArray()) without(annots, num)
      const fields = this.d.getTrailer().get('Root', 'AcroForm', 'Fields')
      const parent = obj.get('Parent')
      if (parent.isIndirect() && !obj.get('T').isString()) {
        without(parent.get('Kids'), num)
        if (!parent.get('Kids').length && fields.isArray()) without(fields, parent.asIndirect())
      } else if (fields.isArray()) {
        without(fields, num)
      }
    }, [pageId])
    return this.state()
  }

  /**
   * Finds likely fields on flat forms: boxes, underlines and runs of underscores, named after the
   * nearest label to their left or above. Returns how many fields were added.
   */
  detectFields(pageIds = this.pageIds()) {
    let added = 0
    for (const pageId of pageIds) {
      const lines = this.textLines(pageId)
      const page = this.page(pageId)
      const existing = page.getWidgets().map((w) => w.getBounds() as Rect)
      const st = page.toStructuredText('vectors,preserve-whitespace')
      page.destroy()
      const found: { kind: FieldKind; rect: Rect; label?: string }[] = []
      const runs: { rect: Rect; label: string }[] = []
      let run: Rect | null = null
      let lineText = ''
      let runLabel = ''
      st.walk({
        onVector(bbox, flags) {
          const [x0, y0, x1, y1] = bbox as Rect
          const [w, h] = [x1 - x0, y1 - y0]
          if (!flags?.isRectangle && !flags?.isStroked) return
          if (w >= 7 && w <= 24 && Math.abs(w - h) < 3) found.push({ kind: 'checkbox', rect: [x0, y0, x1, y1] })
          else if (w >= 40 && h >= 10 && h <= 120) found.push({ kind: h > 40 ? 'multiline' : 'text', rect: [x0 + 1, y0 + 1, x1 - 1, y1 - 1] })
          else if (w >= 40 && h <= 2.5) found.push({ kind: 'text', rect: [x0, y0 - 16, x1, y0] })
        },
        onChar(c, _origin, _font, size, quad) {
          const q = quad as number[]
          if (c === '_') {
            if (run && Math.abs(q[0] - run[2]) < size) run = [run[0], Math.min(run[1], q[1]), q[2], Math.max(run[3], q[7])]
            else {
              if (run && run[2] - run[0] > size * 2) runs.push({ rect: run, label: runLabel })
              run = [q[0], q[1], q[2], q[7]]
              // Text earlier on the same line, such as "Phone", labels the blank.
              runLabel = lineText
            }
          } else if (run) {
            if (run[2] - run[0] > size * 2) runs.push({ rect: run, label: runLabel })
            run = null
          }
          lineText += c
        },
        endLine() {
          if (run && run[2] - run[0] > 12) runs.push({ rect: run, label: runLabel })
          run = null
          lineText = ''
        },
      })
      for (const r of runs) found.push({ kind: 'text', rect: [r.rect[0], r.rect[3] - 16, r.rect[2], r.rect[3]], label: r.label })

      const overlap = (a: Rect, b: Rect) => {
        const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
        const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
        return (ix * iy) / Math.max(1, Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))
      }
      const hasText = (r: Rect) => lines.some((l) => !/^_+$/.test(l.text.trim()) && overlap(l.bbox, r) > 0.5)
      const kept: typeof found = []
      for (const f of found) {
        // Underscore blanks are text themselves, so only shapes are checked for text inside.
        if (existing.some((e) => overlap(e, f.rect) > 0.5) || kept.some((k) => overlap(k.rect, f.rect) > 0.5) || (f.label === undefined && hasText(f.rect))) continue
        kept.push(f)
      }
      for (const f of kept) {
        // Name the field after the closest label on its left (same row) or just above it.
        const [x0, y0, , y1] = f.rect
        const mid = (y0 + y1) / 2
        const label = (f.label?.trim() ? { text: f.label } : null) ??
          lines.filter((l) => l.bbox[2] <= x0 + 4 && l.bbox[1] <= mid + 4 && l.bbox[3] >= mid - 4).sort((a, b) => b.bbox[2] - a.bbox[2])[0] ??
          lines.filter((l) => l.bbox[3] <= y0 + 2 && y0 - l.bbox[3] < 24 && l.bbox[0] < f.rect[2] && l.bbox[2] > x0).sort((a, b) => b.bbox[3] - a.bbox[3])[0]
        const name = label?.text.replace(/_+/g, '').replace(/[:*]+\s*$/, '').trim().slice(0, 40) || undefined
        this.addField(pageId, f.kind, f.rect, { name })
        added++
      }
    }
    return { count: added, state: this.state() }
  }

  // ---- images and graphics ----

  /** The page's own content as one string, and a function to write a new version back. */
  private pageContent(pageId: number) {
    const doc = this.d
    const page = this.page(pageId)
    const obj = page.getObject()
    const contents = obj.get('Contents')
    const parts: string[] = []
    if (contents.isArray()) contents.forEach((s) => parts.push(s.readStream().asString()))
    else if (contents.isStream()) parts.push(contents.readStream().asString())
    const transform = page.getTransform() as CMatrix
    page.destroy()
    const xobjects = obj.getInheritable('Resources').get('XObject')
    const isImage = (name: string) => {
      const x = xobjects.isDictionary() ? xobjects.get(name) : null
      return !!x && x.isStream() && x.resolve().get('Subtype').toString() === '/Image'
    }
    return {
      text: parts.join('\n'),
      // PDF user space -> page space.
      transform,
      isImage,
      write: (text: string) => obj.put('Contents', doc.addStream(text, {})),
    }
  }

  /** Images drawn directly on a page, with their bounds in page space. */
  pageImages(pageId: number): PageImage[] {
    const c = this.pageContent(pageId)
    return findImageDraws(c.text, c.isImage).map((d, i) => {
      const m = multiply(d.ctm, c.transform)
      const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]]
      const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]]
      return { index: i, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Rect }
    })
  }

  /** Moves or resizes an image so its bounds become `rect` (page space). */
  moveImage(pageId: number, index: number, rect: Rect) {
    this.editImage(pageId, index, (d, c, name) => {
      const from = this.pageImages(pageId)[index].rect
      return `q ${fmt(imageWarp(d.ctm, c.transform, from, rect))} cm /${name} Do Q`
    })
    return this.state()
  }

  deleteImage(pageId: number, index: number) {
    this.editImage(pageId, index, () => '')
    return this.state()
  }

  /** Swaps an image for a new one, fitted inside the old one's bounds. */
  replaceImage(pageId: number, index: number, bytes: Uint8Array) {
    const doc = this.d
    const img = new mupdf.Image(bytes)
    this.editImage(pageId, index, (d, c) => {
      const ref = doc.addImage(img)
      const name = this.addXObject(pageId, ref)
      const from = this.pageImages(pageId)[index].rect
      const [x0, y0, x1, y1] = from
      const k = Math.min((x1 - x0) / img.getWidth(), (y1 - y0) / img.getHeight())
      const w = img.getWidth() * k
      const h = img.getHeight() * k
      const to: Rect = [x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0 - h) / 2, x0 + (x1 - x0 + w) / 2, y0 + (y1 - y0 + h) / 2]
      // The new image is drawn upright in the old image's place, whatever the old transform was.
      const unitToPage: CMatrix = [w, 0, 0, -h, to[0], to[3]]
      return `q ${fmt(multiply(multiply(unitToPage, invert(c.transform)), invert(d.ctm)))} cm /${name} Do Q`
    })
    return this.state()
  }

  /** Removes vector graphics (lines, shapes, fills) entirely inside an area, leaving text and images. */
  eraseGraphics(pageId: number, rect: Rect) {
    this.op('Erase graphics', () => {
      const page = this.page(pageId)
      const r = page.createAnnotation('Redact')
      r.setRect(rect)
      r.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_NONE)
      page.destroy()
    }, [pageId])
    return this.state()
  }

  private editImage(pageId: number, index: number, replace: (d: ReturnType<typeof findImageDraws>[number], c: ReturnType<Engine['pageContent']>, name: string) => string) {
    this.op('Edit image', () => {
      const c = this.pageContent(pageId)
      const draw = findImageDraws(c.text, c.isImage)[index]
      if (!draw) throw new Error('Image not found')
      // Work on page-space coordinates relative to the content's own coordinate system.
      c.write(patch(c.text, [{ start: draw.start, end: draw.end, text: replace(draw, c, draw.name) }]))
    }, [pageId])
  }

  private addXObject(pageId: number, ref: mupdf.PDFObject) {
    let name = ''
    this.appendContent(pageId, (names) => {
      name = names.xobject(ref)
      return ''
    })
    return name
  }

  // ---- links ----

  /** A link URI for a web address or a page index. Bare domains get https://. */
  private linkUri(target: string | number) {
    if (typeof target === 'number') return this.linkTo(target)
    const t = target.trim()
    if (/^(https?|mailto|tel):/i.test(t)) return t
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return `mailto:${t}`
    return `https://${t}`
  }

  addLink(pageId: number, rect: Rect, target: string | number) {
    this.op('Add link', () => {
      const page = this.page(pageId)
      page.createLink(rect, this.linkUri(target))
      page.destroy()
    }, [pageId])
    return this.state()
  }

  updateLink(pageId: number, index: number, change: { rect?: Rect; target?: string | number }) {
    this.op('Edit link', () => {
      const page = this.page(pageId)
      const link = page.getLinks()[index]
      if (!link) throw new Error('Link not found')
      const uri = change.target !== undefined ? this.linkUri(change.target) : link.getURI()
      if (change.rect) {
        // Link.setBounds ignores page rotation, so recreate the link at its new place instead.
        page.deleteLink(link)
        page.createLink(change.rect, uri)
      } else {
        link.setURI(uri)
      }
      page.destroy()
    }, [pageId])
    return this.state()
  }

  deleteLink(pageId: number, index: number) {
    this.op('Delete link', () => {
      const page = this.page(pageId)
      const link = page.getLinks()[index]
      if (link) page.deleteLink(link)
      page.destroy()
    }, [pageId])
    return this.state()
  }

  // ---- page labels ----

  /** Starts a page numbering range at a page: style D (1, 2), r (i, ii), R (I, II), a, A, or none. */
  setPageLabels(pageId: number, style: PageLabelStyle, prefix = '', start = 1) {
    const index = this.indexOf(pageId)
    const code = style === 'none' ? mupdf.PDFDocument.PAGE_LABEL_NONE : style
    this.op('Set page labels', () => this.d.setPageLabels(index, code, prefix, Math.max(1, Math.round(start))))
    return this.state()
  }

  /** Removes the numbering range that starts at a page, so it continues the previous range. */
  removePageLabels(pageId: number) {
    const index = this.indexOf(pageId)
    this.op('Remove page labels', () => this.d.deletePageLabels(index))
    return this.state()
  }

  // ---- metadata and attachments ----

  setMeta(meta: Metadata) {
    this.op('Edit properties', () => {
      const keys: [keyof Metadata, string][] = [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords']]
      for (const [k, key] of keys) this.d.setMetaData(`info:${key}`, meta[k])
    }, [])
    return this.state()
  }

  attach(name: string, bytes: Uint8Array, mime = 'application/octet-stream') {
    // Built by hand: MuPDF's addEmbeddedFile leaves an undo operation open.
    this.op('Attach file', () => {
      const doc = this.d
      const now = new Date()
      const stream = doc.addStream(bytes, { Type: 'EmbeddedFile', Subtype: mime, Params: { Size: bytes.length } })
      stream.get('Params').put('ModDate', doc.newString(`D:${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`))
      const spec = doc.addObject({ Type: 'Filespec', F: doc.newString(name), UF: doc.newString(name), EF: { F: stream } })
      doc.insertEmbeddedFile(name, spec)
    }, [])
    return this.state()
  }

  attachment(name: string) {
    const ref = this.d.getEmbeddedFiles()[name]
    return ref ? this.d.getEmbeddedFileContents(ref)?.asUint8Array().slice() ?? null : null
  }

  removeAttachment(name: string) {
    this.op('Remove attachment', () => this.d.deleteEmbeddedFile(name), [])
    return this.state()
  }

  // ---- output ----

  /** Pages that have no text at all, such as scans. */
  pagesWithoutText() {
    return this.pageIds().filter((id) => !this.pageText(id).trim())
  }

  /** Adds invisible, searchable text over recognized words (the output of OCR). */
  addTextLayer(pageId: number, words: OcrWord[]) {
    const runs: TextRun[] = words
      .filter((w) => w.text.trim() && w.bbox[2] > w.bbox[0])
      .map((w) => ({
        text: w.text, x: w.bbox[0], y: w.baseline, size: Math.max(2, w.size), width: w.bbox[2] - w.bbox[0],
        font: 'Helvetica' as BaseFont, color: [0, 0, 0] as RGB, invisible: true,
      }))
    if (runs.length) this.op('Recognize text', () => this.appendText(pageId, runs), [pageId])
    return this.state()
  }

  // ---- digital signatures ----

  createDigitalId(opts: Parameters<typeof createDigitalId>[0]) {
    return createDigitalId(opts)
  }

  /** Signs the current document and reopens the signed result. */
  sign(req: SignRequest) {
    if (this.encrypted) throw new Error('Remove the password protection (Compression & security) and save before signing.')
    const id = readDigitalId(req.p12, req.password)
    const order = this.pageIds()
    const base = this.save({ compress: this.signatures.length ? 'none' : 'standard', security: { mode: 'keep' } })
    const bytes = signPdf(base, id, {
      page: req.pageId === null ? undefined : order.indexOf(req.pageId),
      rect: req.pageId === null ? undefined : req.rect,
      reason: req.reason, location: req.location, image: req.image, field: req.field,
    })
    const state = this.open(`${this.name}.pdf`, bytes.slice())
    return { bytes, state }
  }

  save(opts: SaveOptions): Uint8Array {
    if (this.signatures.length) {
      // Rewriting a signed file would break its signatures; append the changes instead.
      if (opts.security.mode !== 'keep') throw new Error("Password changes aren't possible on a signed document without invalidating its signatures.")
      // MuPDF still reports unsaved changes after an incremental save, and a second save with
      // nothing new returns a broken file, so reuse the last output until the journal moves.
      const position = this.d.getJournal().position
      if (this.lastSave?.position === position) return this.lastSave.bytes.slice()
      const out = this.d.saveToBuffer('incremental').asUint8Array().slice()
      this.lastSave = { position, bytes: out }
      this.signatures = verifySignatures(out, this.d)
      return out.slice()
    }
    const doc = this.reopen()
    if (opts.compress === 'medium' || opts.compress === 'strong') {
      downsampleImages(doc, opts.compress === 'medium' ? { maxDim: 2000, quality: 75 } : { maxDim: 1200, quality: 55 })
    }
    if (opts.compress !== 'none') doc.subsetFonts()
    const parts = compressOptions(opts.compress)
    if (opts.security.mode === 'none') parts.push('encrypt=none')
    if (opts.security.mode === 'set') {
      const s = opts.security
      const bits = s.allow.reduce((p, k) => p | PERMISSION_BITS[k], 0)
      parts.push('encrypt=aes-256', `permissions=${(0xfffff0c0 | bits) >> 0}`)
      if (s.userPassword) parts.push(`user-password=${s.userPassword}`)
      parts.push(`owner-password=${s.ownerPassword || s.userPassword || crypto.randomUUID()}`)
    }
    const out = doc.saveToBuffer(parts.join(',')).asUint8Array().slice()
    doc.destroy()
    return out
  }

  exportImages(scale = 2): Uint8Array {
    const files: Record<string, Uint8Array> = {}
    for (const [i, id] of this.pageIds().entries()) {
      const page = this.page(id)
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
      files[`${this.name}-${String(i + 1).padStart(3, '0')}.png`] = pix.asPNG().slice()
      pix.destroy()
      page.destroy()
    }
    return zipSync(files, { level: 0 })
  }

  exportText() {
    return this.pageIds().map((id) => this.pageText(id)).join('\n\f\n')
  }

  exportHtml() {
    const body = this.pageIds()
      .map((id, i) => this.structured(id).asHTML(i))
      .join('\n')
    return `<!doctype html><meta charset="utf-8"><title>${this.name}</title>\n${body}`
  }
}

function compressOptions(level: CompressLevel) {
  if (level === 'none') return ['compress']
  return [level === 'standard' ? 'garbage=compact' : 'garbage=deduplicate', 'compress', 'compress-fonts', 'clean']
}

/** Re-encodes large raster images as JPEG, scaled so neither side exceeds maxDim. */
export function downsampleImages(doc: mupdf.PDFDocument, { maxDim, quality }: { maxDim: number; quality: number }) {
  // Soft masks and stencil masks must keep their exact pixels.
  const masks = new Set<number>()
  const n = doc.countObjects()
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i).resolve()
    if (!o.isDictionary()) continue
    for (const key of ['SMask', 'Mask']) {
      const m = o.get(key)
      if (m.isIndirect()) masks.add(m.asIndirect())
    }
  }

  let changed = 0
  for (let i = 1; i < n; i++) {
    if (masks.has(i)) continue
    const ref = doc.newIndirect(i)
    if (!ref.isStream()) continue
    const dict = ref.resolve()
    if (dict.get('Subtype').toString() !== '/Image') continue
    if (dict.get('ImageMask').valueOf() === true) continue
    const bpc = dict.get('BitsPerComponent')
    if (bpc.isNumber() && bpc.asNumber() < 8) continue // bilevel scans compress better as they are
    const w = dict.get('Width').asNumber()
    const h = dict.get('Height').asNumber()
    const filter = dict.get('Filter').toString()
    const big = Math.max(w, h) > maxDim
    if (!big && (filter.includes('DCT') || w * h < 250_000)) continue

    try {
      let pix = doc.loadImage(ref).toPixmap()
      const cs = pix.getColorSpace()
      if (pix.getAlpha() || !(cs?.isGray() || cs?.isRGB())) {
        pix = pix.convertToColorSpace(cs?.isGray() ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false)
      }
      if (big) {
        const k = maxDim / Math.max(w, h)
        pix = pix.warp([[0, 0], [w, 0], [w, h], [0, h]], Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
      }
      const jpg = pix.asJPEG(quality)
      if (jpg.length >= ref.readRawStream().getLength()) continue
      const smask = dict.get('SMask')
      const tmp = doc.addImage(new mupdf.Image(jpg))
      ref.writeObject(tmp.resolve())
      ref.writeRawStream(tmp.readRawStream())
      if (!smask.isNull()) ref.put('SMask', smask)
      doc.deleteObject(tmp)
      changed++
    } catch {
      // leave images we can't decode untouched
    }
  }
  return changed
}
