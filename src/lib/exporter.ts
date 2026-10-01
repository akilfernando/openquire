import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib'
import { TEXT_LINE_HEIGHT, type Annot, type Metadata, type PageEntry } from './types'

export interface ExportOptions {
  metadata?: Metadata
  /** Rasterize every page (lossy compression). */
  rasterAll?: boolean
  /**
   * Renders a page to JPEG with its redactions burned in. Required when any page
   * has redactions or when rasterAll is set.
   */
  rasterize?: (entry: PageEntry) => Promise<Uint8Array>
}

const hex = (c: string) => {
  const n = parseInt(c.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const dataUrlBytes = (url: string) => {
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Matrix taking view space (y flipped to point up) to the page's user space, and the view height. */
function viewOf(page: PDFPage) {
  const r = ((page.getRotation().angle % 360) + 360) % 360
  const { x, y, width: w, height: h } = page.getCropBox()
  const m =
    r === 90 ? [0, 1, -1, 0, x + w, y]
    : r === 180 ? [-1, 0, 0, -1, x + w, y + h]
    : r === 270 ? [0, -1, 1, 0, x, y + h]
    : [1, 0, 0, 1, x, y]
  return { m, H: r % 180 === 0 ? h : w, r }
}

class Drawer {
  private font?: PDFFont
  private images = new Map<string, PDFImage>()
  constructor(private doc: PDFDocument) {}

  private async getFont() {
    return (this.font ??= await this.doc.embedFont(StandardFonts.Helvetica))
  }

  private async getImage(dataUrl: string) {
    let img = this.images.get(dataUrl)
    if (!img) {
      const bytes = dataUrlBytes(dataUrl)
      img = dataUrl.startsWith('data:image/png') ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes)
      this.images.set(dataUrl, img)
    }
    return img
  }

  /** The standard fonts only cover WinAnsi; anything else becomes "?". */
  private encodable(font: PDFFont, text: string) {
    const ok = new Set(font.getCharacterSet())
    return [...text].map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : '?')).join('')
  }

  async draw(page: PDFPage, annots: Annot[]) {
    if (!annots.length) return
    const { m, H } = viewOf(page)
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]))
    for (const a of annots) {
      switch (a.type) {
        case 'redact': // burned into the raster; nothing to draw
          break
        case 'highlight':
          page.drawRectangle({
            x: a.x, y: H - a.y - a.h, width: a.w, height: a.h,
            color: hex(a.color), opacity: 0.4, blendMode: BlendMode.Multiply,
          })
          break
        case 'whiteout':
          page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: rgb(1, 1, 1) })
          break
        case 'ink': {
          const pts = a.points.length === 1 ? [a.points[0], a.points[0]] : a.points
          const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
          page.drawSvgPath(path, {
            x: 0, y: H, borderColor: hex(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round,
          })
          break
        }
        case 'text': {
          const font = await this.getFont()
          const lines = a.text.split('\n')
          for (let i = 0; i < lines.length; i++) {
            page.drawText(this.encodable(font, lines[i]), {
              x: a.x, y: H - (a.y + a.size * (1 + TEXT_LINE_HEIGHT * i)),
              size: a.size, font, color: hex(a.color), opacity: a.opacity ?? 1, rotate: degrees(a.angle ?? 0),
            })
          }
          break
        }
        case 'image':
          page.drawImage(await this.getImage(a.dataUrl), { x: a.x, y: H - a.y - a.h, width: a.w, height: a.h })
          break
      }
    }
    page.pushOperators(popGraphicsState())
  }
}

const needsRaster = (p: PageEntry, opts: ExportOptions) => !!opts.rasterAll || p.annots.some((a) => a.type === 'redact')

/** Builds the final PDF from the working page list. */
export async function buildPdf(
  pages: PageEntry[],
  sourceBytes: (sourceId: string) => Uint8Array,
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  if (!pages.length) throw new Error('The document has no pages.')

  const docs = new Map<string, PDFDocument>()
  const load = async (id: string) => {
    let d = docs.get(id)
    if (!d) docs.set(id, (d = await PDFDocument.load(sourceBytes(id), { ignoreEncryption: true })))
    return d
  }

  const anyRaster = pages.some((p) => needsRaster(p, opts))
  if (anyRaster && !opts.rasterize) throw new Error('A rasterizer is required for redaction and compression.')

  // An untouched page order from a single source is edited in place, which keeps
  // interactive form fields, bookmarks and other document-level structure.
  const first = await load(pages[0].sourceId)
  const inPlace =
    !anyRaster &&
    pages.every((p, i) => p.sourceId === pages[0].sourceId && p.pageIndex === i) &&
    pages.length === first.getPageCount()

  const out = inPlace ? first : await PDFDocument.create()
  const drawer = new Drawer(out)

  if (inPlace) {
    for (const [i, entry] of pages.entries()) {
      const page = out.getPage(i)
      await drawer.draw(page, entry.annots)
      if (entry.rotation) page.setRotation(degrees((page.getRotation().angle + entry.rotation) % 360))
    }
  } else {
    // Copy each source's pages in one batch so shared fonts and images are copied once.
    const copied = new Map<string, PDFPage>()
    const bySource = new Map<string, PageEntry[]>()
    for (const p of pages) {
      if (needsRaster(p, opts)) continue
      bySource.set(p.sourceId, [...(bySource.get(p.sourceId) ?? []), p])
    }
    for (const [sourceId, entries] of bySource) {
      const result = await out.copyPages(await load(sourceId), entries.map((e) => e.pageIndex))
      entries.forEach((e, i) => copied.set(e.id, result[i]))
    }

    for (const entry of pages) {
      let page = copied.get(entry.id)
      if (page) {
        out.addPage(page)
        await drawer.draw(page, entry.annots)
        if (entry.rotation) page.setRotation(degrees((page.getRotation().angle + entry.rotation) % 360))
      } else {
        const img = await out.embedJpg(await opts.rasterize!(entry))
        page = out.addPage([entry.width, entry.height])
        page.drawImage(img, { x: 0, y: 0, width: entry.width, height: entry.height })
        await drawer.draw(page, entry.annots)
        page.setRotation(degrees(entry.rotation))
      }
    }
  }

  const md = opts.metadata ?? {}
  if (md.title) out.setTitle(md.title)
  if (md.author) out.setAuthor(md.author)
  if (md.subject) out.setSubject(md.subject)
  if (md.keywords) out.setKeywords(md.keywords.split(',').map((k) => k.trim()).filter(Boolean))
  out.setProducer('OpenQuire')
  out.setModificationDate(new Date())

  return out.save({ useObjectStreams: true })
}

/**
 * Parses a 1-based page range spec such as "1-3, 5, 8-" into groups of 0-based indices,
 * one group per comma-separated part.
 */
export function parseRanges(spec: string, total: number): number[][] {
  const groups: number[][] = []
  for (const raw of spec.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part)
    if (!m || (!m[1] && !m[3])) throw new Error(`Invalid page range "${part}"`)
    const start = m[1] ? Number(m[1]) : 1
    const end = m[2] ? (m[3] ? Number(m[3]) : total) : start
    if (start < 1 || end > total || start > end) throw new Error(`Page range "${part}" is outside 1-${total}`)
    groups.push(Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i))
  }
  if (!groups.length) throw new Error('Enter at least one page range, e.g. 1-3, 4-6')
  return groups
}
