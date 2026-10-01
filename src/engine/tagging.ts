/**
 * Accessibility: automatic tagging of untagged PDFs, a PDF/UA checker and a small tag editor.
 *
 * Tagging works on each page's own content stream. Every text-showing operator is located on the
 * page (by following the graphics and text matrices) and assigned to the paragraph MuPDF found
 * there; consecutive operators of one paragraph become one marked-content sequence with an MCID,
 * and each paragraph becomes a structure element (P, or H1 to H3 when its type is notably larger
 * than the body text). Images become Figure elements, and everything else (rules, fills,
 * backgrounds) is marked as an Artifact. Links, form fields and comments are added to the tree
 * through object references, so screen readers reach them in reading order.
 */
import * as mupdf from 'mupdf'
import { decodeName, multiply, tokenize, type Matrix, type Op } from './content'
import { unembeddedFonts } from './pdfa'
import type { Rect } from './types'

export type TagType = 'P' | 'H1' | 'H2' | 'H3' | 'Figure'
export const TAG_TYPES: TagType[] = ['P', 'H1', 'H2', 'H3', 'Figure']

export interface TagNode {
  /** Object number of the structure element. */
  id: number
  type: string
  page: number
  /** Bounds on the page (page space), when known. */
  rect: Rect | null
  /** The start of its text, for figures the alternate text. */
  text: string
  alt: string
}

export interface AccessibilityProblem {
  severity: 'error' | 'warning'
  message: string
  page?: number
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const SHOW = new Set(['Tj', 'TJ', "'", '"'])
const PATH = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'sh'])
const PAINT = new Set([...SHOW, 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh', 'Do', 'BI'])
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const num = (op: Op, i: number) => Number(op.operands[i]?.text ?? 0)

function rectOf(m: Matrix): Rect {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])

// ---- page text ------------------------------------------------------------------------------

interface Block {
  bbox: Rect
  lines: Rect[]
  size: number
  text: string
}

function blocksOf(page: mupdf.PDFPage): Block[] {
  const blocks: Block[] = []
  let cur: Block | null = null
  let line = ''
  const st = page.toStructuredText('preserve-whitespace')
  st.walk({
    beginTextBlock(bbox) {
      cur = { bbox: bbox as Rect, lines: [], size: 0, text: '' }
    },
    beginLine(bbox) {
      cur?.lines.push(bbox as Rect)
      line = ''
    },
    onChar(c, _origin, _font, size) {
      if (!cur) return
      line += c
      if (c.trim()) cur.size = Math.max(cur.size, size)
    },
    endLine() {
      if (cur) cur.text += (cur.text ? ' ' : '') + line.trim()
    },
    endTextBlock() {
      if (cur && cur.text.trim()) blocks.push(cur)
      cur = null
    },
  })
  st.destroy()
  return blocks
}

/** The block a text-showing operator at `p` (page space) belongs to, or -1. */
function blockAt(blocks: Block[], p: [number, number]) {
  let best = -1
  let bestArea = Infinity
  blocks.forEach((b, i) => {
    for (const l of b.lines) {
      const pad = Math.max(2, (l[3] - l[1]) * 0.3)
      if (p[0] >= l[0] - pad && p[0] <= l[2] + pad && p[1] >= l[1] - pad && p[1] <= l[3] + pad && area(l) < bestArea) {
        best = i
        bestArea = area(l)
      }
    }
  })
  if (best >= 0) return best
  // Otherwise the nearest block, if any is reasonably close.
  let dist = 24
  blocks.forEach((b, i) => {
    const dx = Math.max(b.bbox[0] - p[0], 0, p[0] - b.bbox[2])
    const dy = Math.max(b.bbox[1] - p[1], 0, p[1] - b.bbox[3])
    const d = Math.hypot(dx, dy)
    if (d < dist) {
      dist = d
      best = i
    }
  })
  return best
}

// ---- content -------------------------------------------------------------------------------

function contentOf(pageObj: mupdf.PDFObject) {
  const contents = pageObj.get('Contents')
  const parts: string[] = []
  if (contents.isArray()) contents.forEach((s) => parts.push(s.readStream().asString()))
  else if (contents.isStream()) parts.push(contents.readStream().asString())
  return parts.join('\n')
}

/** Whether a form XObject (or anything it draws) shows text. */
function formHasText(x: mupdf.PDFObject, depth = 0): boolean {
  const res = x.get('Resources')
  if (!res.isDictionary() || depth > 6) return false
  let found = false
  res.get('Font').forEach(() => (found = true))
  if (found) return true
  res.get('XObject').forEach((c) => (found ||= c.resolve().get('Subtype').toString() === '/Form' && formHasText(c.resolve(), depth + 1)))
  return found
}

interface Element {
  type: TagType
  mcids: number[]
  rect: Rect | null
}

/**
 * Rewrites a page's content with marked content and returns its structure elements in content
 * order. Existing structure marking is removed; optional content (layer) marking is kept.
 */
function tagContent(src: string, xobjects: mupdf.PDFObject, transform: Matrix, pageRect: Rect, blocks: Block[], roles: TagType[]) {
  const out: string[] = []
  const elements: Element[] = []
  const blockElement = new Map<number, Element>()
  const stack: Matrix[] = []
  let ctm = IDENTITY
  let tm = IDENTITY
  let tlm = IDENTITY
  let leading = 0
  let mcid = 0
  // Marked content open in the source: true for sequences being kept.
  const kept: boolean[] = []
  let cur: { kind: 'art' } | { kind: 'tag'; el: Element } | null = null
  const hasText = blocks.length > 0
  const pageArea = area(pageRect)

  const close = () => {
    if (cur) out.push('EMC')
    cur = null
  }
  const artifact = () => {
    if (cur?.kind === 'art') return
    close()
    out.push('/Artifact BMC')
    cur = { kind: 'art' }
  }
  const tag = (el: Element) => {
    if (cur?.kind === 'tag' && cur.el === el) return
    close()
    out.push(`/${el.type === 'Figure' ? 'Figure' : el.type} <</MCID ${mcid}>> BDC`)
    el.mcids.push(mcid++)
    cur = { kind: 'tag', el }
  }
  const figure = (rect: Rect) => {
    // A picture filling the page behind text is a scan or a background, not a figure.
    if (hasText && area(rect) > pageArea * 0.8) return artifact()
    const el: Element = { type: 'Figure', mcids: [], rect }
    elements.push(el)
    tag(el)
  }
  const pagePoint = (m: Matrix) => apply(multiply(multiply(m, ctm), transform), 0, 0)
  const td = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
    tm = tlm
  }

  tokenize(src, (op) => {
    const text = src.slice(op.start, op.end)
    switch (op.op) {
      case 'q':
        close()
        stack.push(ctm)
        out.push(text)
        return
      case 'Q':
        close()
        ctm = stack.pop() ?? IDENTITY
        out.push(text)
        return
      case 'cm':
        ctm = multiply([num(op, 0), num(op, 1), num(op, 2), num(op, 3), num(op, 4), num(op, 5)], ctm)
        out.push(text)
        return
      case 'BT':
        close()
        tm = tlm = IDENTITY
        out.push(text)
        return
      case 'ET':
        close()
        out.push(text)
        return
      case 'BMC':
      case 'BDC': {
        close()
        const keep = op.operands[0]?.text === '/OC'
        kept.push(keep)
        if (keep) out.push(text)
        return
      }
      case 'EMC':
        close()
        if (kept.pop()) out.push(text)
        return
      case 'Tm':
        tm = tlm = [num(op, 0), num(op, 1), num(op, 2), num(op, 3), num(op, 4), num(op, 5)]
        out.push(text)
        return
      case 'Td':
        td(num(op, 0), num(op, 1))
        out.push(text)
        return
      case 'TD':
        leading = -num(op, 1)
        td(num(op, 0), num(op, 1))
        out.push(text)
        return
      case 'TL':
        leading = num(op, 0)
        out.push(text)
        return
      case 'T*':
        td(0, -leading)
        out.push(text)
        return
    }
    if (SHOW.has(op.op)) {
      if (op.op === "'" || op.op === '"') td(0, -leading)
      const b = blockAt(blocks, pagePoint(tm))
      if (b < 0) artifact()
      else {
        let el = blockElement.get(b)
        if (!el) {
          el = { type: roles[b], mcids: [], rect: blocks[b].bbox }
          blockElement.set(b, el)
          elements.push(el)
        }
        tag(el)
      }
    } else if (op.op === 'Do') {
      const x = xobjects.isDictionary() ? xobjects.get(decodeName(op.operands[0]?.text.slice(1) ?? '')) : null
      const subtype = x && !x.isNull() ? x.resolve().get('Subtype').toString() : ''
      const rect = rectOf(multiply(ctm, transform))
      if (subtype === '/Image') figure(rect)
      else if (subtype === '/Form' && formHasText(x!.resolve())) {
        const el: Element = { type: 'P', mcids: [], rect: null }
        elements.push(el)
        tag(el)
      } else artifact()
    } else if (op.op === 'BI') {
      figure(rectOf(multiply(ctm, transform)))
    } else if (PATH.has(op.op)) artifact()
    out.push(text)
  })
  close()
  // Unbalanced source marking is closed so the result stays well formed.
  for (const k of kept) if (k) out.push('EMC')
  return { content: out.join('\n'), elements }
}

// ---- metadata ---------------------------------------------------------------------------------

const xmlEscape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The PDF/A extension schema that declares the pdfuaid namespace, so PDF/A files stay valid. */
const UA_SCHEMA = `<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
    <pdfaSchema:schema>PDF/UA Universal Accessibility Schema</pdfaSchema:schema>
    <pdfaSchema:namespaceURI>http://www.aiim.org/pdfua/ns/id/</pdfaSchema:namespaceURI>
    <pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>
    <pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">
     <pdfaProperty:name>part</pdfaProperty:name>
     <pdfaProperty:valueType>Integer</pdfaProperty:valueType>
     <pdfaProperty:category>internal</pdfaProperty:category>
     <pdfaProperty:description>Indicates, which part of ISO 14289 standard is followed</pdfaProperty:description>
    </rdf:li></rdf:Seq></pdfaSchema:property>
   </rdf:li></rdf:Bag></pdfaExtension:schemas>
  </rdf:Description>`

function updateXmp(doc: mupdf.PDFDocument, title: string) {
  const root = doc.getTrailer().get('Root')
  const meta = root.get('Metadata')
  let xmp = meta.isStream() ? meta.readStream().asString() : ''
  if (!/<rdf:RDF/.test(xmp))
    xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
  const add: string[] = []
  if (!/pdfuaid:part/.test(xmp)) add.push(`<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></rdf:Description>`)
  if (!/http:\/\/www\.aiim\.org\/pdfua\/ns\/id\/<\/pdfaSchema:namespaceURI>/.test(xmp) && /pdfaid:part/.test(xmp)) add.push(UA_SCHEMA)
  if (!/<dc:title>/.test(xmp) && title)
    add.push(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title></rdf:Description>`)
  if (!add.length) return
  xmp = xmp.replace('</rdf:RDF>', `  ${add.join('\n  ')}\n </rdf:RDF>`)
  const stream = doc.addRawStream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })
  root.put('Metadata', stream)
}

// ---- tagging ----------------------------------------------------------------------------------

export interface TagOptions {
  /** BCP 47 language of the document, such as "en-US". */
  lang: string
  /** Title to use when the document has none. */
  title: string
}

export function autoTag(doc: mupdf.PDFDocument, opts: TagOptions): string[] {
  const notes: string[] = []
  const root = doc.getTrailer().get('Root')
  if (!root.get('StructTreeRoot').isNull()) notes.push('The existing tags were replaced.')

  // Headings are found by size relative to the body text of the whole document.
  const count = doc.countPages()
  const pages = Array.from({ length: count }, (_, i) => {
    const page = doc.loadPage(i) as mupdf.PDFPage
    const blocks = blocksOf(page)
    const info = { blocks, transform: page.getTransform() as Matrix, rect: page.getBounds() as Rect }
    page.destroy()
    return info
  })
  const sizes = pages.flatMap((p) => p.blocks.flatMap((b) => Array(Math.min(b.text.length, 2000)).fill(b.size) as number[])).sort((a, b) => a - b)
  const body = sizes[Math.floor(sizes.length / 2)] ?? 12
  // Short blocks set clearly larger than the body are headings, ranked by size: the largest size is
  // level 1, the next level 2, and anything smaller level 3.
  const isHeading = (b: Block) => b.text.length <= 200 && b.lines.length <= 3 && b.size >= body * 1.12
  const levels = [...new Set(pages.flatMap((p) => p.blocks.filter(isHeading).map((b) => Math.round(b.size))))].sort((a, b) => b - a)
  const roleOf = (b: Block): TagType => (isHeading(b) ? (['H1', 'H2', 'H3'] as const)[Math.min(2, levels.indexOf(Math.round(b.size)))] : 'P')

  const tree = doc.addObject({ Type: 'StructTreeRoot' })
  const top = doc.addObject({ Type: 'StructElem', S: 'Document', P: tree })
  const kids = doc.newArray()
  top.put('K', kids)
  tree.put('K', top)
  const nums = doc.newArray()
  let key = 0
  let figures = 0
  let tooltips = 0

  for (let i = 0; i < count; i++) {
    const pageObj = doc.findPage(i)
    const { blocks, transform, rect } = pages[i]
    const toPdf = invertMatrix(transform)
    const res = pageObj.getInheritable('Resources')
    const { content, elements } = tagContent(contentOf(pageObj), res.isDictionary() ? res.get('XObject') : doc.newNull(), transform, rect, blocks, blocks.map(roleOf))
    pageObj.put('Contents', doc.addStream(content, {}))

    const parents: mupdf.PDFObject[] = []
    for (const el of elements) {
      const obj = doc.addObject({ Type: 'StructElem', S: el.type, P: top, Pg: pageObj })
      obj.put('K', el.mcids.length === 1 ? el.mcids[0] : el.mcids)
      if (el.rect) obj.put('A', { O: 'Layout', BBox: pdfRect(el.rect, toPdf) })
      if (el.type === 'Figure') figures++
      kids.push(obj)
      for (const m of el.mcids) parents[m] = obj
    }
    if (parents.length) {
      pageObj.put('StructParents', key)
      nums.push(key++)
      const arr = doc.newArray()
      for (const p of parents) arr.push(p)
      nums.push(arr)
    } else pageObj.delete('StructParents')

    // Annotations join the tree after the page's content.
    const annots = pageObj.get('Annots')
    let any = false
    if (annots.isArray())
      annots.forEach((ref) => {
        const a = ref.resolve()
        const subtype = a.get('Subtype').toString()
        if (subtype === '/Popup') return
        any = true
        const type = subtype === '/Link' ? 'Link' : subtype === '/Widget' ? 'Form' : 'Annot'
        const obj = doc.addObject({ Type: 'StructElem', S: type, P: top, Pg: pageObj })
        obj.put('K', doc.newDictionary())
        obj.get('K').put('Type', 'OBJR')
        obj.get('K').put('Obj', ref)
        obj.get('K').put('Pg', pageObj)
        kids.push(obj)
        a.put('StructParent', key)
        nums.push(key++)
        nums.push(obj)
        if (type === 'Link' && a.get('Contents').isNull()) a.put('Contents', doc.newString(linkDescription(doc, a)))
        if (type === 'Form') {
          const field = a.get('T').isNull() && a.get('Parent').isDictionary() ? a.get('Parent') : a
          if (field.get('TU').isNull() && !field.get('T').isNull()) {
            field.put('TU', field.get('T'))
            tooltips++
          }
        }
      })
    if (any) pageObj.put('Tabs', 'S')
  }

  tree.put('ParentTree', doc.addObject({ Nums: nums }))
  tree.put('ParentTreeNextKey', key)
  root.put('StructTreeRoot', tree)
  root.put('MarkInfo', { Marked: true })
  if (opts.lang) root.put('Lang', doc.newString(opts.lang))
  root.put('ViewerPreferences', { DisplayDocTitle: true })

  let info = doc.getTrailer().get('Info')
  if (!info.isDictionary()) {
    info = doc.addObject({})
    doc.getTrailer().put('Info', info)
  }
  const title = info.get('Title').isString() && info.get('Title').asString() ? info.get('Title').asString() : opts.title
  if (!info.get('Title').isString() || !info.get('Title').asString()) info.put('Title', doc.newString(title))
  updateXmp(doc, title)

  if (figures) notes.push(`${figures} figure${figures === 1 ? ' needs' : 's need'} alternate text.`)
  if (tooltips) notes.push(`${tooltips} form field${tooltips === 1 ? ' was' : 's were'} given its name as a description; review ${tooltips === 1 ? 'it' : 'them'}.`)
  return notes
}

function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

function pdfRect(r: Rect, m: Matrix): Rect {
  const a = apply(m, r[0], r[1])
  const b = apply(m, r[2], r[3])
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((v) => Math.round(v * 100) / 100) as Rect
}

function linkDescription(doc: mupdf.PDFDocument, a: mupdf.PDFObject) {
  const action = a.get('A')
  const uri = action.isDictionary() ? action.get('URI') : null
  if (uri && uri.isString()) return `Link to ${uri.asString()}`
  const dest = a.get('Dest').isNull() && action.isDictionary() ? action.get('D') : a.get('Dest')
  if (dest.isArray()) {
    const target = dest.get(0)
    for (let i = 0; i < doc.countPages(); i++) if (target.isIndirect() && doc.findPage(i).asIndirect() === target.asIndirect()) return `Link to page ${i + 1}`
  }
  return 'Link'
}

// ---- structure editing ------------------------------------------------------------------------

function topElement(doc: mupdf.PDFDocument) {
  const tree = doc.getTrailer().get('Root', 'StructTreeRoot')
  if (!tree.isDictionary()) return null
  const k = tree.get('K')
  const first = k.isArray() ? k.get(0) : k
  if (first.isDictionary() && first.get('S').toString() === '/Document') return first.resolve()
  return tree
}

function pageIndexOf(doc: mupdf.PDFDocument, pg: mupdf.PDFObject) {
  if (!pg.isIndirect()) return -1
  for (let i = 0; i < doc.countPages(); i++) if (doc.findPage(i).asIndirect() === pg.asIndirect()) return i
  return -1
}

/** The top-level structure elements in reading order, with an excerpt of each one's text. */
export function structure(doc: mupdf.PDFDocument): TagNode[] {
  const top = topElement(doc)
  if (!top) return []
  const k = top.get('K')
  const nodes: TagNode[] = []
  const pages = new Map<number, { transform: Matrix; lines: { rect: Rect; text: string }[] }>()
  const pageText = (i: number) => {
    let p = pages.get(i)
    if (!p) {
      const page = doc.loadPage(i) as mupdf.PDFPage
      const lines: { rect: Rect; text: string }[] = []
      let cur: { rect: Rect; text: string } | null = null
      const st = page.toStructuredText('preserve-whitespace')
      st.walk({
        beginLine(bbox) { cur = { rect: bbox as Rect, text: '' } },
        onChar(c) { if (cur) cur.text += c },
        endLine() { if (cur) lines.push(cur); cur = null },
      })
      st.destroy()
      p = { transform: page.getTransform() as Matrix, lines }
      page.destroy()
      pages.set(i, p)
    }
    return p
  }
  const visit = (ref: mupdf.PDFObject) => {
    const el = ref.resolve()
    if (!ref.isIndirect() || !el.isDictionary() || el.get('Type').toString() === '/OBJR' || el.get('Type').toString() === '/MCR') return
    const page = pageIndexOf(doc, el.get('Pg'))
    const bbox = el.get('A').isDictionary() ? el.get('A').get('BBox') : null
    let rect: Rect | null = null
    let text = ''
    if (page >= 0 && bbox?.isArray()) {
      const p = pageText(page)
      const a = apply(p.transform, bbox.get(0).asNumber(), bbox.get(1).asNumber())
      const b = apply(p.transform, bbox.get(2).asNumber(), bbox.get(3).asNumber())
      rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
      const r = rect
      text = p.lines
        .filter((l) => {
          const cx = (l.rect[0] + l.rect[2]) / 2
          const cy = (l.rect[1] + l.rect[3]) / 2
          return cx >= r[0] - 1 && cx <= r[2] + 1 && cy >= r[1] - 1 && cy <= r[3] + 1
        })
        .map((l) => l.text.trim())
        .join(' ')
        .slice(0, 160)
    }
    const alt = el.get('Alt').isString() ? el.get('Alt').asString() : ''
    const contents = el.get('K').isDictionary() && el.get('K').get('Type').toString() === '/OBJR' ? el.get('K').get('Obj').resolve().get('Contents') : null
    nodes.push({
      id: ref.asIndirect(),
      type: el.get('S').isName() ? el.get('S').asName() : '',
      page,
      rect,
      text: text || alt || (contents?.isString() ? contents.asString() : ''),
      alt,
    })
  }
  if (k.isArray()) k.forEach(visit)
  else visit(k)
  return nodes
}

/** Changes an element's type, or sets its alternate text (an empty string removes it). */
export function updateTag(doc: mupdf.PDFDocument, id: number, change: { type?: TagType; alt?: string }) {
  const el = doc.newIndirect(id).resolve()
  if (!el.isDictionary() || el.get('Type').toString() !== '/StructElem') throw new Error('Tag not found')
  if (change.type) el.put('S', change.type)
  if (change.alt !== undefined) {
    if (change.alt.trim()) el.put('Alt', doc.newString(change.alt.trim()))
    else el.delete('Alt')
  }
}

/** Moves an element earlier (negative) or later (positive) in the reading order. */
export function moveTag(doc: mupdf.PDFDocument, id: number, delta: number) {
  const top = topElement(doc)
  const k = top?.get('K')
  if (!k?.isArray()) return
  const items: mupdf.PDFObject[] = []
  k.forEach((el) => items.push(el))
  const from = items.findIndex((el) => el.isIndirect() && el.asIndirect() === id)
  if (from < 0) throw new Error('Tag not found')
  const to = Math.max(0, Math.min(items.length - 1, from + delta))
  const [el] = items.splice(from, 1)
  items.splice(to, 0, el)
  const arr = doc.newArray()
  for (const it of items) arr.push(it)
  top!.put('K', arr)
}

// ---- checking ---------------------------------------------------------------------------------

/** Counts painting operators outside both tagged content and artifacts. */
function untaggedContent(src: string) {
  const stack: boolean[] = []
  let count = 0
  tokenize(src, (op) => {
    if (op.op === 'BMC' || op.op === 'BDC') {
      const tagName = op.operands[0]?.text
      const covered = tagName === '/Artifact' || (op.op === 'BDC' && op.operands.some((o) => o.text === '/MCID'))
      stack.push(covered || stack.at(-1) === true)
    } else if (op.op === 'EMC') stack.pop()
    else if (PAINT.has(op.op) && !stack.at(-1)) count++
  })
  return count
}

/**
 * Checks the main machine-verifiable PDF/UA-1 requirements. Some requirements (meaningful
 * alternate text, correct reading order) need a person to judge.
 */
export function checkAccessibility(doc: mupdf.PDFDocument): { tagged: boolean; problems: AccessibilityProblem[] } {
  const problems: AccessibilityProblem[] = []
  const error = (message: string, page?: number) => problems.push({ severity: 'error', message, page })
  const warn = (message: string, page?: number) => problems.push({ severity: 'warning', message, page })
  const trailer = doc.getTrailer()
  const root = trailer.get('Root')
  const tree = root.get('StructTreeRoot')
  const tagged = tree.isDictionary()

  if (!tagged) error('The document is not tagged, so assistive technology cannot read its structure.')
  if (!root.get('MarkInfo').isDictionary() || !root.get('MarkInfo').get('Marked').asBoolean()) error('The document is not marked as tagged (MarkInfo).')
  if (!root.get('Lang').isString() || !root.get('Lang').asString()) error('The document language is not set.')
  const info = trailer.get('Info')
  const meta = root.get('Metadata')
  const xmp = meta.isStream() ? meta.readStream().asString() : ''
  if (!/<dc:title>/.test(xmp) && !(info.isDictionary() && info.get('Title').isString() && info.get('Title').asString())) error('The document has no title.')
  else if (!/<dc:title>/.test(xmp)) error('The title is missing from the XMP metadata.')
  if (!root.get('ViewerPreferences').isDictionary() || !root.get('ViewerPreferences').get('DisplayDocTitle').asBoolean()) error('Viewers are not told to show the title instead of the file name.')
  if (!/pdfuaid:part/.test(xmp)) warn('The metadata does not identify the file as PDF/UA.')
  const encrypt = trailer.get('Encrypt')
  if (encrypt.isDictionary() && encrypt.get('P').isNumber() && !(encrypt.get('P').asNumber() & 512)) error('Security settings block assistive technology from reading the text.')

  for (const font of unembeddedFonts(doc)) error(`The font ${font} is not embedded.`)

  for (let i = 0; i < doc.countPages(); i++) {
    const pageObj = doc.findPage(i)
    if (tagged) {
      const loose = untaggedContent(contentOf(pageObj))
      if (loose) error(`${loose} piece${loose === 1 ? '' : 's'} of content ${loose === 1 ? 'is' : 'are'} neither tagged nor marked as decoration.`, i)
    }
    const annots = pageObj.get('Annots')
    if (!annots.isArray()) continue
    let any = false
    annots.forEach((ref) => {
      const a = ref.resolve()
      const subtype = a.get('Subtype').toString()
      if (subtype === '/Popup') return
      any = true
      const name = subtype.slice(1)
      if (tagged && a.get('StructParent').isNull()) error(`A ${name} annotation is not in the tag tree.`, i)
      if (subtype === '/Widget') {
        const field = a.get('T').isNull() && a.get('Parent').isDictionary() ? a.get('Parent') : a
        if (field.get('TU').isNull()) error(`The form field ${field.get('T').isString() ? field.get('T').asString() : ''} has no description (tooltip).`.replace('  ', ' '), i)
      } else if (a.get('Contents').isNull()) error(`A ${name} annotation has no description.`, i)
    })
    if (any && pageObj.get('Tabs').toString() !== '/S') error('The tab order does not follow the document structure.', i)
  }

  if (tagged) {
    let level = 0
    for (const node of structure(doc)) {
      if (node.type === 'Figure' && !node.alt) error('A figure has no alternate text.', node.page)
      const h = /^H([1-6])$/.exec(node.type)
      if (h) {
        const n = Number(h[1])
        if (n > level + 1) warn(`A level ${n} heading follows ${level ? `a level ${level} heading` : 'no heading'}, skipping a level.`, node.page)
        level = n
      }
    }
  }
  return { tagged, problems }
}
