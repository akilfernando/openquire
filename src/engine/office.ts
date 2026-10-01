/**
 * Export to Word (.docx) and Excel (.xlsx), written as Office Open XML by hand.
 *
 * Word documents are rebuilt from the page's paragraphs (with their fonts, sizes, weight, color
 * and alignment), images and detected tables, in reading order, with a page break between pages.
 * Headings get Word's heading styles so the navigation pane and table of contents work.
 */
import { strToU8, zipSync } from 'fflate'
import type { Table } from './tables'
import type { Metadata, Rect, RGB, TextBlock } from './types'

export interface ExportImage {
  rect: Rect
  png: Uint8Array
  width: number
  height: number
}

export interface ExportPage {
  width: number
  height: number
  blocks: TextBlock[]
  tables: Table[]
  images: ExportImage[]
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
// XML 1.0 can't hold most control characters.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
const hex = (c: RGB) => c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
const twips = (pt: number) => Math.round(pt * 20)
const emu = (pt: number) => Math.round(pt * 12700)
const inside = (r: Rect, box: Rect) => {
  const cx = (r[0] + r[2]) / 2
  const cy = (r[1] + r[3]) / 2
  return cx >= box[0] - 1 && cx <= box[2] + 1 && cy >= box[1] - 1 && cy <= box[3] + 1
}

/** A font family Word is likely to have, from a PDF font name. */
function family(b: { font: string; serif: boolean; mono: boolean }) {
  if (b.mono) return 'Courier New'
  const name = b.font.replace(/^[A-Z]{6}\+/, '').replace(/[-,](Bold|Italic|Oblique|Regular|Roman|BoldItalic|BoldOblique|Medium|Light|Semibold|MT|PS).*$/i, '').replace(/MT$|PSMT$/, '')
  if (/^(Helvetica|Arial)/i.test(name)) return 'Arial'
  if (/^Times/i.test(name)) return 'Times New Roman'
  if (/^Courier/i.test(name)) return 'Courier New'
  if (name && /^[\w ]+$/.test(name) && !/^(F\d+|T\d+|Font)/.test(name)) return name.replace(/([a-z])([A-Z])/g, '$1 $2')
  return b.serif ? 'Times New Roman' : 'Arial'
}

function run(text: string, s: { font: string; serif: boolean; mono: boolean; size: number; bold: boolean; italic: boolean; color: RGB }, plain = false) {
  const f = family(s)
  const props = plain
    ? ''
    : `<w:rPr><w:rFonts w:ascii="${esc(f)}" w:hAnsi="${esc(f)}" w:cs="${esc(f)}"/>${s.bold ? '<w:b/>' : ''}${s.italic ? '<w:i/>' : ''}` +
      `${hex(s.color) !== '000000' ? `<w:color w:val="${hex(s.color)}"/>` : ''}<w:sz w:val="${Math.round(s.size * 2)}"/><w:szCs w:val="${Math.round(s.size * 2)}"/></w:rPr>`
  return `<w:r>${props}<w:t xml:space="preserve">${esc(clean(text))}</w:t></w:r>`
}

function paragraph(b: TextBlock, heading: number, after: number) {
  const jc = { left: '', center: 'center', right: 'right', justify: 'both' }[b.align]
  const line = b.lines.length > 1 && b.leading > 0 ? `<w:spacing w:after="${twips(after)}" w:line="${Math.round((b.leading / b.size) * 200)}" w:lineRule="auto"/>` : `<w:spacing w:after="${twips(after)}"/>`
  const ppr = `<w:pPr>${heading ? `<w:pStyle w:val="Heading${heading}"/>` : ''}${line}${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>`
  // Short lines (addresses, lists) keep their breaks; prose lines join into one flowing paragraph.
  const breaks = b.text.includes('\n')
  // Heading styles are bold already.
  const style = (l: TextBlock['lines'][number]) => (heading ? { ...l, bold: false } : l)
  const runs = b.lines.map((l, i) => (i ? (breaks ? '<w:r><w:br/></w:r>' : run(' ', style(l))) : '') + run(l.text.trim(), style(l))).join('')
  return `<w:p>${ppr}${runs}</w:p>`
}

function table(t: Table) {
  const widths = t.columns.map(([a, b], i) => {
    const next = t.columns[i + 1]?.[0] ?? b + 12
    return twips(Math.max(36, next - a))
  })
  const rows = t.rows.map((r, ri) => {
    const cells = r.cells.map((c, ci) => {
      const bold = r.bold || ri === 0
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[ci]}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${c ? `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(clean(c))}</w:t></w:r>` : ''}</w:p></w:tc>`
    })
    return `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`
  })
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:firstRow="1" w:val="0420"/></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl><w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`
}

function picture(id: number, rel: string, wPt: number, hPt: number) {
  const cx = emu(wPt)
  const cy = emu(hPt)
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`

function coreProps(meta: Metadata) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `${meta.title ? `<dc:title>${esc(meta.title)}</dc:title>` : ''}${meta.author ? `<dc:creator>${esc(meta.author)}</dc:creator>` : ''}${meta.subject ? `<dc:subject>${esc(meta.subject)}</dc:subject>` : ''}${meta.keywords ? `<cp:keywords>${esc(meta.keywords)}</cp:keywords>` : ''}` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
}

/** Heading levels for blocks: short, clearly larger than the body text, ranked by size. */
function headingLevels(pages: ExportPage[]) {
  const sizes = pages.flatMap((p) => p.blocks.flatMap((b) => Array(Math.min(b.text.length, 2000)).fill(Math.round(b.size)) as number[])).sort((a, b) => a - b)
  const body = sizes[Math.floor(sizes.length / 2)] ?? 11
  const isHeading = (b: TextBlock) => b.text.length <= 200 && b.lines.length <= 3 && b.size >= body * 1.15
  const levels = [...new Set(pages.flatMap((p) => p.blocks.filter(isHeading).map((b) => Math.round(b.size))))].sort((a, b) => b - a)
  return (b: TextBlock) => (isHeading(b) ? Math.min(3, levels.indexOf(Math.round(b.size)) + 1) : 0)
}

export function buildDocx(pages: ExportPage[], meta: Metadata): Uint8Array {
  const level = headingLevels(pages)
  const media: Record<string, Uint8Array> = {}
  const rels: string[] = [`<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`]
  const body: string[] = []
  let pic = 0
  const maxWidth = Math.max(...pages.map((p) => p.width)) - 72 * 2

  pages.forEach((page, pi) => {
    type Item = { y: number; xml: string }
    const items: Item[] = []
    for (const t of page.tables) items.push({ y: t.bbox[1], xml: table(t) })
    const blocks = page.blocks.filter((b) => !page.tables.some((t) => inside(b.bbox, t.bbox)))
    blocks.forEach((b, i) => {
      const next = blocks[i + 1]
      const gap = next ? Math.max(0, Math.min(36, next.bbox[1] - b.bbox[3])) : 6
      items.push({ y: b.bbox[1], xml: paragraph(b, level(b), gap) })
    })
    for (const im of page.images) {
      pic++
      const rel = `rIdImg${pic}`
      media[`word/media/image${pic}.png`] = im.png
      rels.push(`<Relationship Id="${rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${pic}.png"/>`)
      // Shown at its size on the page, scaled down to fit the text width.
      let w = im.rect[2] - im.rect[0]
      let h = im.rect[3] - im.rect[1]
      if (w > maxWidth) {
        h *= maxWidth / w
        w = maxWidth
      }
      items.push({ y: im.rect[1], xml: picture(pic, rel, w, h) })
    }
    items.sort((a, b) => a.y - b.y)
    body.push(...items.map((i) => i.xml))
    if (pi < pages.length - 1) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
  })

  const first = pages[0] ?? { width: 612, height: 792 }
  const sect = `<w:sectPr><w:pgSz w:w="${twips(first.width)}" w:h="${twips(first.height)}"${first.width > first.height ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}${sect}</w:body></w:document>`

  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'word/document.xml': strToU8(doc),
    'word/styles.xml': strToU8(STYLES),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`),
    'docProps/core.xml': strToU8(coreProps(meta)),
    ...media,
  })
}

// ---- Excel ------------------------------------------------------------------------------------

/** A cell's value: numbers (with thousands separators, currency or a percent sign) become numbers. */
export function cellValue(text: string): { n: number; percent: boolean } | null {
  const t = text.trim()
  const m = /^\(?([-+−]?)[$€£¥]?\s?([\d,]*\.?\d+)\s?(%?)\)?$/.exec(t)
  if (!m || !/\d/.test(m[2]) || (m[2].includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(m[2]))) return null
  let n = Number(m[2].replace(/,/g, ''))
  if (m[1] === '-' || m[1] === '−' || (t.startsWith('(') && t.endsWith(')'))) n = -n
  return m[3] ? { n: n / 100, percent: true } : { n, percent: false }
}

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)))

function sheet(t: Table) {
  const rows = t.rows.map((r, ri) => {
    const cells = r.cells.map((c, ci) => {
      if (!c) return ''
      const ref = `${colName(ci)}${ri + 1}`
      const v = ri === 0 ? null : cellValue(c)
      if (v) return `<c r="${ref}"${v.percent ? ' s="2"' : ''}><v>${v.n}</v></c>`
      return `<c r="${ref}" t="inlineStr"${ri === 0 || r.bold ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(clean(c))}</t></is></c>`
    })
    return `<row r="${ri + 1}">${cells.join('')}</row>`
  })
  const cols = t.columns.map(([a, b], i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, Math.min(60, Math.round((b - a) / 5.5) + 2))}" customWidth="1"/>`)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols.join('')}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
}

/** One worksheet per table, named by page. Returns null when there are no tables. */
export function buildXlsx(tables: { page: number; table: Table }[], meta: Metadata): Uint8Array | null {
  if (!tables.length) return null
  const perPage = new Map<number, number>()
  const names = tables.map(({ page }) => {
    const n = (perPage.get(page) ?? 0) + 1
    perPage.set(page, n)
    return `Page ${page + 1}${n > 1 || tables.filter((t) => t.page === page).length > 1 ? ` table ${n}` : ''}`
  })
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    'docProps/core.xml': strToU8(coreProps(meta)),
  }
  tables.forEach(({ table: t }, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheet(t))))
  return zipSync(files)
}
