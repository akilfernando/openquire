import * as mupdf from 'mupdf'
import { zipSync } from 'fflate'
import {
  hexOf,
  type AnnotInfo,
  type AnnotPatch,
  type AnnotShape,
  type AnnotSpec,
  type Bookmark,
  type CompressLevel,
  type DocState,
  type Metadata,
  type PageInfo,
  type Permission,
  type Point,
  type Quad,
  type RGB,
  type Rect,
  type SaveOptions,
  type SearchHit,
  type StampSpec,
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
}

// ---- the engine --------------------------------------------------------------

export class Engine {
  doc: mupdf.PDFDocument | null = null
  name = 'document'
  author = 'OpenQuire user'
  private password: string | undefined
  private encrypted = false
  private tick = 0
  private revs = new Map<number, number>()
  private fonts = new Map<string, mupdf.Font>()
  private stext = new Map<string, mupdf.StructuredText>()

  // ---- document lifecycle ----

  open(name: string, bytes: Uint8Array, password?: string) {
    const doc = openAsPdf(name, bytes, password)
    this.doc?.destroy()
    this.doc = doc
    this.name = name.replace(/\.[^.]+$/, '')
    this.password = password
    this.encrypted = isPdfName(name) && !!password
    this.revs.clear()
    this.stext.clear()
    doc.enableJournal()
    return this.state()
  }

  newBlank() {
    const doc = new mupdf.PDFDocument()
    doc.insertPage(-1, doc.addPage(A4, 0, {}, ''))
    this.doc?.destroy()
    this.doc = doc
    this.name = 'untitled'
    this.password = undefined
    this.encrypted = false
    this.revs.clear()
    doc.enableJournal()
    return this.state()
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
      this.stext.clear()
      this.tick++
    } else {
      for (const id of ids) {
        this.revs.set(id, ++this.tick)
        for (const k of this.stext.keys()) if (k.startsWith(`${id}:`)) this.stext.delete(k)
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
    if (!st) {
      const page = this.page(pageId)
      st = page.toStructuredText('preserve-whitespace,preserve-spans')
      page.destroy()
      this.stext.set(key, st)
    }
    return st
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
    const lines: TextLine[] = []
    let cur: TextLine | null = null
    this.structured(pageId).walk({
      beginLine(bbox, _wmode, dir) {
        cur = Math.abs(dir[1]) < 0.01 && dir[0] > 0
          ? { bbox: bbox as Rect, origin: [0, 0], text: '', font: '', size: 0, bold: false, italic: false, serif: false, mono: false, color: [0, 0, 0] }
          : null
      },
      onChar(c, origin, font, size, _quad, color) {
        if (!cur) return
        if (!cur.text) {
          const name = font.getName()
          cur.origin = origin as Point
          cur.font = name
          cur.size = size
          cur.bold = font.isBold() || /bold|black|heavy|semibold/i.test(name)
          cur.italic = font.isItalic() || /italic|oblique/i.test(name)
          cur.serif = font.isSerif() || /times|serif|georgia|garamond|cambria|minion|roman/i.test(name)
          cur.mono = font.isMono() || /courier|mono|consol/i.test(name)
          cur.color = (rgb(color as mupdf.AnnotColor) ?? [0, 0, 0]) as RGB
        }
        cur.text += c
      },
      endLine() {
        if (cur && cur.text.trim()) lines.push(cur)
        cur = null
      },
    })
    return lines
  }

  /**
   * Replaces a line of existing page text: removes the original glyphs (keeping images and
   * graphics underneath) and writes the new text in the closest standard font.
   */
  replaceText(pageId: number, line: TextLine, text: string, opts: { size?: number; color?: RGB; font?: BaseFont } = {}) {
    this.op(
      'Edit text',
      () => {
        const page = this.page(pageId)
        const [x0, y0, x1, y1] = line.bbox
        const inset = (y1 - y0) * 0.2
        const r = page.createAnnotation('Redact')
        r.setRect([x0 - 0.5, y0 + inset, x1 + 0.5, y1 - inset])
        r.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
        page.destroy()
        if (text.trim())
          this.appendText(pageId, [{
            text, x: line.origin[0], y: line.origin[1], size: opts.size ?? line.size,
            font: opts.font ?? baseFontFor(line), color: opts.color ?? line.color,
          }])
      },
      [pageId],
    )
    return this.state()
  }

  /** Writes text into the page content stream (not as an annotation). */
  private appendText(pageId: number, runs: TextRun[]) {
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
    const fontDict = sub('Font')
    const gsDict = sub('ExtGState')
    const fresh = (dict: mupdf.PDFObject, prefix: string) => {
      let n = 1
      while (!dict.get(`${prefix}${n}`).isNull()) n++
      return `${prefix}${n}`
    }

    const names = new Map<string, string>()
    let ops = ''
    const inv = mupdf.Matrix.invert(page.getTransform())
    ops += `${inv.map((v) => +v.toFixed(5)).join(' ')} cm\n`
    for (const run of runs) {
      let fname = names.get(run.font)
      if (!fname) {
        fname = fresh(fontDict, 'OQF')
        fontDict.put(fname, doc.addSimpleFont(this.font(run.font), 'Latin'))
        names.set(run.font, fname)
      }
      const gs = fresh(gsDict, 'OQG')
      gsDict.put(gs, doc.addObject({ Type: 'ExtGState', ca: run.opacity ?? 1, CA: run.opacity ?? 1 }))
      const t = ((run.angle ?? 0) * Math.PI) / 180
      const [c, s] = [Math.cos(t), Math.sin(t)]
      const lines = run.text.split('\n')
      ops += `q /${gs} gs ${run.color.map((v) => v.toFixed(3)).join(' ')} rg BT /${fname} ${run.size.toFixed(2)} Tf\n`
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

  save(opts: SaveOptions): Uint8Array {
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
