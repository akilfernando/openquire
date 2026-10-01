import { describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import { buildPdf, parseRanges } from '../src/lib/exporter'
import { readFields, writeFields } from '../src/lib/forms'
import type { Annot, PageEntry } from '../src/lib/types'

async function makePdf(sizes: [number, number][], rotate = 0) {
  const doc = await PDFDocument.create()
  for (const s of sizes) doc.addPage(s).setRotation(degrees(rotate))
  return doc.save()
}

const entries = (sourceId: string, sizes: [number, number][]): PageEntry[] =>
  sizes.map(([width, height], pageIndex) => ({
    id: `${sourceId}-${pageIndex}`, sourceId, pageIndex, rotation: 0, width, height, annots: [],
  }))

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const allAnnots: Annot[] = [
  { id: 'a', type: 'highlight', x: 10, y: 10, w: 100, h: 20, color: '#ffe600' },
  { id: 'b', type: 'whiteout', x: 10, y: 40, w: 100, h: 20, color: '#ffffff' },
  { id: 'c', type: 'ink', points: [[5, 5], [50, 60], [80, 20]], color: '#ff0000', width: 2 },
  { id: 'd', type: 'text', x: 20, y: 100, text: 'Hello\nwörld ✓', size: 14, color: '#111111', angle: 45, opacity: 0.5 },
  { id: 'e', type: 'image', x: 20, y: 150, w: 40, h: 40, dataUrl: PNG_1PX },
]

describe('buildPdf', () => {
  it('merges, reorders, deletes and rotates pages across sources', async () => {
    const a = await makePdf([[200, 300], [200, 300]])
    const b = await makePdf([[400, 100], [400, 100], [400, 100]])
    const pa = entries('a', [[200, 300], [200, 300]])
    const pb = entries('b', [[400, 100], [400, 100], [400, 100]])
    const pages = [pb[2], pa[0], { ...pb[0], rotation: 90 as const }, pa[1]]

    const out = await PDFDocument.load(await buildPdf(pages, (id) => (id === 'a' ? a : b)))
    expect(out.getPageCount()).toBe(4)
    expect(out.getPage(0).getSize()).toEqual({ width: 400, height: 100 })
    expect(out.getPage(1).getSize()).toEqual({ width: 200, height: 300 })
    expect(out.getPage(2).getRotation().angle).toBe(90)
  })

  it('draws every annotation type on rotated pages and adds user rotation', async () => {
    for (const rot of [0, 90, 180, 270]) {
      const src = await makePdf([[300, 400], [300, 400]], rot)
      const pages = entries('s', [[300, 400], [300, 400]])
      pages[1] = { ...pages[1], annots: allAnnots, rotation: 180 }
      const out = await PDFDocument.load(await buildPdf([pages[1]], () => src))
      expect(out.getPageCount()).toBe(1)
      expect(out.getPage(0).getRotation().angle).toBe((rot + 180) % 360)
    }
  })

  it('keeps form fields when the page order is untouched', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([300, 300])
    doc.getForm().createTextField('name').addToPage(page, { x: 20, y: 200, width: 150, height: 20 })
    doc.getForm().createCheckBox('agree').addToPage(page, { x: 20, y: 150, width: 15, height: 15 })
    const src = await doc.save()

    const fields = await readFields(src)
    expect(fields.map((f) => f.kind)).toEqual(['text', 'check'])
    const filled = await writeFields(src, [{ name: 'name', kind: 'text', value: 'Ada' }, { name: 'agree', kind: 'check', value: true }], false)
    expect(await readFields(filled)).toMatchObject([{ value: 'Ada' }, { value: true }])

    const pages = entries('s', [[300, 300]])
    pages[0].annots = allAnnots
    const out = await buildPdf(pages, () => filled, { metadata: { title: 'T', keywords: 'a, b' } })
    expect(await readFields(out)).toMatchObject([{ value: 'Ada' }, { value: true }])
    expect((await PDFDocument.load(out)).getTitle()).toBe('T')

    const flat = await writeFields(src, [{ name: 'name', kind: 'text', value: 'Ada' }], true)
    expect(await readFields(flat)).toEqual([])
  })

  it('rasterizes redacted pages through the supplied rasterizer', async () => {
    const src = await makePdf([[300, 400], [300, 400]])
    const pages = entries('s', [[300, 400], [300, 400]])
    pages[0].annots = [{ id: 'r', type: 'redact', x: 0, y: 0, w: 50, h: 50, color: '#000000' }]
    await expect(buildPdf(pages, () => src)).rejects.toThrow(/rasterizer/)

    // Smallest valid baseline JPEG (1x1).
    const jpg = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='), (c) => c.charCodeAt(0))
    let calls = 0
    const out = await PDFDocument.load(await buildPdf(pages, () => src, { rasterize: async () => (calls++, jpg) }))
    expect(calls).toBe(1)
    expect(out.getPageCount()).toBe(2)
  })
})

describe('parseRanges', () => {
  it('parses ranges', () => {
    expect(parseRanges('1-3, 5, 8-', 9)).toEqual([[0, 1, 2], [4], [7, 8]])
    expect(parseRanges('-2', 9)).toEqual([[0, 1]])
  })
  it('rejects bad input', () => {
    expect(() => parseRanges('0-2', 5)).toThrow()
    expect(() => parseRanges('4-9', 5)).toThrow()
    expect(() => parseRanges('abc', 5)).toThrow()
    expect(() => parseRanges('', 5)).toThrow()
  })
})
