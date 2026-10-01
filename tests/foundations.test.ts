import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createDigitalId } from '../src/engine/signing'

function bigPdf(pages: number) {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  for (let i = 0; i < pages; i++)
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 12 Tf 72 720 Td (Page ${i + 1} body text) Tj ET`))
  return d.saveToBuffer('compress').asUint8Array().slice()
}

describe('large documents', () => {
  it('edits a 1,000-page document quickly', () => {
    const e = new Engine()
    const s = e.open('big.pdf', bigPdf(1000))
    const t = performance.now()
    e.addAnnot(s.pages[500].id, { type: 'Text', at: [10, 10], text: 'note', color: [1, 1, 0] })
    expect(performance.now() - t).toBeLessThan(100)
  })

  it('keeps the extracted-text cache bounded', () => {
    const e = new Engine()
    e.open('big.pdf', bigPdf(200))
    expect(e.search('body text').length).toBe(200)
    expect(e.cachedTextPages).toBeLessThanOrEqual(48)
    // Repeated searches and edits don't grow it.
    const [first] = e.pageIds()
    for (let i = 0; i < 5; i++) {
      e.addAnnot(first, { type: 'Text', at: [10, 10 + i], text: String(i), color: [1, 1, 0] })
      e.search('Page 1 ')
    }
    expect(e.cachedTextPages).toBeLessThanOrEqual(48)
  })
})

describe('signed documents', () => {
  it('keeps undo history across saves and never returns a broken file', async () => {
    const p12 = await createDigitalId({ name: 'Ada', password: 'pw' })
    const e = new Engine()
    const s = e.open('doc.pdf', bigPdf(2))
    const { state } = await e.sign({ p12, password: 'pw', pageId: null })
    const page = state.pages[0].id

    e.addAnnot(page, { type: 'Text', at: [10, 10], text: 'one', color: [1, 1, 0] })
    const a = e.save({ compress: 'standard', security: { mode: 'keep' } })
    const again = e.save({ compress: 'standard', security: { mode: 'keep' } })
    expect(Buffer.compare(Buffer.from(a), Buffer.from(again))).toBe(0)

    const undone = e.undo()
    expect(undone.pages[0].annots).toHaveLength(0)
    const b = e.save({ compress: 'standard', security: { mode: 'keep' } })
    for (const bytes of [a, b]) {
      const r = new Engine().open('r.pdf', bytes)
      expect(r.pages).toHaveLength(2)
      expect(r.signatures[0].valid).toBe(true)
    }
    expect(new Engine().open('b.pdf', b).pages[0].annots).toHaveLength(0)
    expect(s.pages).toHaveLength(2)
  })
})
