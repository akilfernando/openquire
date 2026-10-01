/**
 * PDF/A conversion (parts 2b and 3b) and a quick conformance check.
 *
 * Conversion redraws every page through MuPDF's PDF writer, which embeds every font (with widths
 * and Unicode mappings) and draws annotations and form fields into the page. Bookmarks, links,
 * document properties and (for 3b) attachments are carried over, then the archival requirements
 * are added: XMP metadata identifying the file as PDF/A, an sRGB output intent and a file ID.
 */
import * as mupdf from 'mupdf'
import type { Bookmark, Metadata } from './types'

export type PdfAPart = 2 | 3

// ---- sRGB ICC profile --------------------------------------------------------------------

/** A minimal ICC v2 display profile for sRGB (D50-adapted primaries, gamma 2.2), built in code. */
export function srgbProfile(): Uint8Array {
  const s15 = (v: number) => {
    const n = Math.round(v * 65536)
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  }
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const pad = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)]
  const xyz = (x: number, y: number, z: number) => [...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)]
  const curve = [...ascii('curv'), 0, 0, 0, 0, ...u32(1), 0x02, 0x33, 0, 0] // gamma 2.2 (u8Fixed8 = 0x0233)
  const desc = (() => {
    const text = 'sRGB IEC61966-2.1 (OpenQuire)'
    return pad([...ascii('desc'), 0, 0, 0, 0, ...u32(text.length + 1), ...ascii(text), 0, ...u32(0), ...u32(0), 0, 0, 0, ...new Array(67).fill(0)])
  })()
  const cprt = pad([...ascii('text'), 0, 0, 0, 0, ...ascii('No copyright, use freely'), 0])
  const tags: [string, number[]][] = [
    ['desc', desc], ['cprt', cprt], ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)], ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', pad(curve)], ['gTRC', pad(curve)], ['bTRC', pad(curve)],
  ]
  let offset = 128 + 4 + tags.length * 12
  const table: number[] = [...u32(tags.length)]
  const data: number[] = []
  for (const [sig, bytes] of tags) {
    table.push(...ascii(sig), ...u32(offset), ...u32(bytes.length))
    data.push(...bytes)
    offset += bytes.length
  }
  const size = offset
  const header = [
    ...u32(size), 0, 0, 0, 0, 0x02, 0x10, 0, 0, ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '),
    0x07, 0xea, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, // 2026-01-01
    ...ascii('acsp'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ...s15(0.9642), ...s15(1), ...s15(0.8249), // illuminant D50
    0, 0, 0, 0, ...new Array(16).fill(0), ...new Array(28).fill(0),
  ]
  return Uint8Array.from([...header, ...table, ...data])
}

// ---- metadata ---------------------------------------------------------------------------

const xmlEscape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The same instant as a PDF date string and an XMP (ISO 8601) date, with the local offset. */
function dates(d: Date) {
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const [oh, om] = [p(Math.floor(Math.abs(off) / 60)), p(Math.abs(off) % 60)]
  const base = [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()), p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())]
  return {
    pdf: `D:${base.join('')}${sign}${oh}'${om}'`,
    xmp: `${base[0]}-${base[1]}-${base[2]}T${base[3]}:${base[4]}:${base[5]}${sign}${oh}:${om}`,
  }
}

function xmpPacket(part: PdfAPart, meta: Metadata, created: string, modified: string, producer: string) {
  const alt = (v: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(v)}</rdf:li></rdf:Alt>`
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>${part}</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
${meta.title ? `   <dc:title>${alt(meta.title)}</dc:title>\n` : ''}${meta.author ? `   <dc:creator><rdf:Seq><rdf:li>${xmlEscape(meta.author)}</rdf:li></rdf:Seq></dc:creator>\n` : ''}${meta.subject ? `   <dc:description>${alt(meta.subject)}</dc:description>\n` : ''}${meta.keywords ? `   <pdf:Keywords>${xmlEscape(meta.keywords)}</pdf:Keywords>\n` : ''}   <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>
   <xmp:CreatorTool>${xmlEscape(producer)}</xmp:CreatorTool>
   <xmp:CreateDate>${created}</xmp:CreateDate>
   <xmp:ModifyDate>${modified}</xmp:ModifyDate>
   <xmp:MetadataDate>${modified}</xmp:MetadataDate>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

// ---- conversion -----------------------------------------------------------------------------

export interface PdfAOptions {
  part: PdfAPart
  meta: Metadata
  outline: Bookmark[]
  /** Attachments to carry over (PDF/A-3 only). */
  attachments?: { name: string; data: Uint8Array; mime: string }[]
}

export interface PdfAResult {
  bytes: Uint8Array
  /** Things that changed in the conversion, for telling the user. */
  notes: string[]
}

export function convertToPdfA(source: mupdf.PDFDocument, opts: PdfAOptions): PdfAResult {
  const notes: string[] = []
  const count = source.countPages()
  let annots = 0
  let widgets = 0

  // Redraw each page through the PDF writer: fonts get embedded, annotations become page content.
  const buf = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buf, 'pdf', 'compress')
  const links: { page: number; rect: number[]; uri: string; target: number }[] = []
  for (let i = 0; i < count; i++) {
    const page = source.loadPage(i)
    annots += page.getAnnotations().filter((a) => !['Link', 'Popup'].includes(a.getType())).length
    widgets += page.getWidgets().length
    for (const l of page.getLinks()) links.push({ page: i, rect: l.getBounds(), uri: l.getURI(), target: l.isExternal() ? -1 : source.resolveLink(l) })
    const dev = writer.beginPage(page.getBounds())
    page.run(dev, mupdf.Matrix.identity)
    writer.endPage()
    page.destroy()
  }
  writer.close()
  if (annots) notes.push(`${annots} comment${annots === 1 ? ' was' : 's were'} drawn into the page.`)
  if (widgets) notes.push(`${widgets} form field${widgets === 1 ? ' was' : 's were'} flattened.`)

  const doc = mupdf.Document.openDocument(buf.asUint8Array().slice(), 'application/pdf').asPDF() as mupdf.PDFDocument
  const root = doc.getTrailer().get('Root')

  // Links and bookmarks.
  const linkUri = (page: number) => doc.formatLinkURI({ type: 'Fit', chapter: 0, page, x: 0, y: 0, width: 0, height: 0, zoom: 0 })
  for (const l of links) {
    const page = doc.loadPage(l.page)
    page.createLink(l.rect as [number, number, number, number], l.target >= 0 ? linkUri(l.target) : l.uri)
    page.destroy()
  }
  // PDF/A requires every annotation except popups, links included, to be set to print.
  for (let i = 0; i < count; i++) {
    const annots = doc.findPage(i).get('Annots')
    if (annots.isArray()) annots.forEach((a) => a.resolve().get('Subtype').toString() !== '/Popup' && a.resolve().put('F', 4))
  }
  // TrueType CID fonts must state their glyph mapping; Identity is what a missing entry means.
  const fonts = new Set<number>()
  const fixFonts = (res: mupdf.PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 8) return
    res.get('Font').forEach((f) => {
      if (f.isIndirect() && fonts.has(f.asIndirect())) return
      if (f.isIndirect()) fonts.add(f.asIndirect())
      f.resolve().get('DescendantFonts').forEach((c) => {
        const cid = c.resolve()
        if (cid.get('Subtype').toString() === '/CIDFontType2' && cid.get('CIDToGIDMap').isNull()) cid.put('CIDToGIDMap', 'Identity')
      })
    })
    res.get('XObject').forEach((x) => fixFonts(x.resolve().get('Resources'), depth + 1))
  }
  for (let i = 0; i < count; i++) fixFonts(doc.findPage(i).getInheritable('Resources'), 0)

  const it = doc.outlineIterator()
  const insert = (items: Bookmark[]) => {
    for (const b of items) {
      it.insert({ title: b.title, uri: b.page >= 0 ? linkUri(b.page) : undefined, open: false })
      if (b.children.length) {
        it.prev()
        it.down()
        insert(b.children)
        it.up()
        it.next()
      }
    }
  }
  insert(opts.outline)

  // Document information and matching XMP metadata.
  const now = dates(new Date())
  const producer = 'OpenQuire'
  const info = doc.addObject({ Producer: doc.newString(producer), CreationDate: doc.newString(now.pdf), ModDate: doc.newString(now.pdf) })
  const fields: [keyof Metadata, string][] = [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords']]
  for (const [k, key] of fields) if (opts.meta[k]) info.put(key, doc.newString(opts.meta[k]))
  doc.getTrailer().put('Info', info)
  root.put('Metadata', doc.addRawStream(new TextEncoder().encode(xmpPacket(opts.part, opts.meta, now.xmp, now.xmp, producer)), { Type: 'Metadata', Subtype: 'XML' }))
  if (opts.meta.title) root.put('ViewerPreferences', { DisplayDocTitle: true })

  // Colors are defined by an sRGB output intent.
  const icc = doc.addStream(srgbProfile(), { N: 3 })
  root.put('OutputIntents', [doc.addObject({
    Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: doc.newString('sRGB IEC61966-2.1'),
    Info: doc.newString('sRGB IEC61966-2.1'), DestOutputProfile: icc,
  })])

  // PDF/A-3 can embed any file, provided it says how it relates to the document.
  if (opts.part === 3 && opts.attachments?.length) {
    const af = doc.newArray()
    const names = doc.newArray()
    for (const a of opts.attachments) {
      const stream = doc.addStream(a.data, { Type: 'EmbeddedFile', Subtype: a.mime, Params: { Size: a.data.length, ModDate: doc.newString(now.pdf) } })
      const spec = doc.addObject({ Type: 'Filespec', F: doc.newString(a.name), UF: doc.newString(a.name), EF: { F: stream, UF: stream }, AFRelationship: 'Unspecified', Desc: doc.newString(a.name) })
      names.push(doc.newString(a.name))
      names.push(spec)
      af.push(spec)
    }
    root.put('Names', { EmbeddedFiles: { Names: names } })
    root.put('AF', af)
  } else if (opts.attachments?.length) {
    notes.push('Attachments were left out: PDF/A-2 only allows PDF/A attachments. Use PDF/A-3 to keep them.')
  }

  // A file identifier is required.
  const id = doc.newByteString(crypto.getRandomValues(new Uint8Array(16)))
  doc.getTrailer().put('ID', [id, id])
  const bytes = doc.saveToBuffer('garbage=compact').asUint8Array().slice()
  doc.destroy()
  return { bytes, notes }
}

// ---- quick check -----------------------------------------------------------------------------

/**
 * A quick in-app check of the most common PDF/A-2/3 requirements. It is not a full validator:
 * use veraPDF (the command-line tool and desktop app run it) for certification-grade results.
 */
export function checkPdfA(bytes: Uint8Array): { part: number | null; problems: string[] } {
  const problems: string[] = []
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  if (doc.needsPassword()) return { part: null, problems: ['The file is encrypted, which PDF/A does not allow.'] }
  const pdf = doc.asPDF() as mupdf.PDFDocument
  const trailer = pdf.getTrailer()
  const root = trailer.get('Root')

  const meta = root.get('Metadata')
  const xmp = meta.isStream() ? meta.readStream().asString() : ''
  const part = Number(/<pdfaid:part>(\d)<\/pdfaid:part>|pdfaid:part="(\d)"/.exec(xmp)?.slice(1).find(Boolean) ?? 0) || null
  if (!part) problems.push('XMP metadata does not identify the file as PDF/A.')
  if (meta.isStream() && !meta.get('Filter').isNull()) problems.push('The XMP metadata stream is compressed.')
  if (trailer.get('ID').isNull()) problems.push('The file has no identifier (trailer ID).')
  if (!trailer.get('Encrypt').isNull()) problems.push('The file is encrypted.')
  const intents = root.get('OutputIntents')
  let intent = false
  if (intents.isArray()) intents.forEach((i) => (intent ||= i.resolve().get('DestOutputProfile').isStream()))
  if (!intent) problems.push('There is no output intent with an ICC profile.')
  const open = root.get('OpenAction')
  if (!root.get('Names', 'JavaScript').isNull() || (open.isDictionary() && open.get('S').toString() === '/JavaScript')) problems.push('The file contains JavaScript.')

  for (const font of unembeddedFonts(pdf)) problems.push(`The font ${font} is not embedded.`)
  for (let i = 0; i < pdf.countPages(); i++) {
    const annots = pdf.findPage(i).get('Annots')
    if (annots.isArray())
      annots.forEach((a) => {
        const d = a.resolve()
        const type = d.get('Subtype').toString()
        if (type === '/Popup') return
        const flags = d.get('F').isNumber() ? d.get('F').asNumber() : 0
        if (!(flags & 4)) problems.push(`A ${type.slice(1)} annotation on page ${i + 1} is not set to print.`)
        if (type !== '/Link' && d.get('AP').isNull()) problems.push(`A ${type.slice(1)} annotation on page ${i + 1} has no appearance.`)
      })
  }
  pdf.destroy()
  return { part, problems: [...new Set(problems)] }
}

/** Names of the fonts used by page content that are not embedded. */
export function unembeddedFonts(pdf: mupdf.PDFDocument): string[] {
  const seen = new Set<number>()
  const names: string[] = []
  const walk = (res: mupdf.PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 8) return
    res.get('Font').forEach((f) => {
      if (!f.isIndirect() || seen.has(f.asIndirect())) return
      seen.add(f.asIndirect())
      const d = f.resolve()
      if (d.get('Subtype').toString() === '/Type3') return
      const desc = d.get('DescendantFonts').isArray() ? d.get('DescendantFonts').get(0).resolve().get('FontDescriptor') : d.get('FontDescriptor')
      if (!['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.isDictionary() && !desc.get(k).isNull()))
        names.push(d.get('BaseFont').isName() ? d.get('BaseFont').asName() : 'unnamed')
    })
    res.get('XObject').forEach((x) => walk(x.resolve().get('Resources'), depth + 1))
  }
  for (let i = 0; i < pdf.countPages(); i++) walk(pdf.findPage(i).getInheritable('Resources'), 0)
  return names
}
