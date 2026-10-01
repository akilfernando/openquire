import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PDFDocument as LibDoc, StandardFonts } from 'pdf-lib'
import { createWorker } from 'tesseract.js'
import { Engine } from '../src/engine/core'
import { wordsFromBlocks, type OcrBlock } from '../src/engine/ocr-layout'
import { createDigitalId, readDigitalId, signPdf } from '../src/engine/signing'

const LANG = fileURLToPath(new URL('../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url))

async function textPdf() {
  const doc = await LibDoc.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([400, 300])
  p.drawText('Invoice number 12345', { x: 40, y: 240, size: 20, font })
  p.drawText('Total amount due today', { x: 40, y: 200, size: 16, font })
  return doc.save()
}

/** A "scan": the text page rendered to an image, wrapped in a new PDF with no text. */
async function scannedPdf() {
  const src = mupdf.Document.openDocument(await textPdf(), 'application/pdf')
  const png = src.loadPage(0).toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false).asPNG()
  const d = new mupdf.PDFDocument()
  const img = d.addImage(new mupdf.Image(png))
  d.insertPage(-1, d.addPage([0, 0, 400, 300], 0, { XObject: { Im0: img } }, 'q 400 0 0 300 0 0 cm /Im0 Do Q'))
  return d.saveToBuffer('compress').asUint8Array().slice()
}

describe('OCR', () => {
  it('adds a searchable text layer to scanned pages', async () => {
    const e = new Engine()
    const s = e.open('scan.pdf', await scannedPdf())
    const [page] = s.pages
    expect(e.pagesWithoutText()).toEqual([page.id])

    const scale = 300 / 72
    const { pixels, width, height } = e.render(page.id, scale)
    // Tesseract in Node wants an encoded image, so wrap the pixels in a PNG.
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)
    const rgb = pix.getPixels()
    for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) rgb.set(pixels.subarray(i, i + 3), j)
    const worker = await createWorker('eng', 1, { langPath: LANG, cacheMethod: 'none', gzip: true })
    const { data } = await worker.recognize(Buffer.from(pix.asPNG()), {}, { blocks: true })
    await worker.terminate()

    const words = wordsFromBlocks(data.blocks as unknown as OcrBlock[], scale)
    expect(words.map((w) => w.text).join(' ')).toContain('Invoice number 12345')
    e.addTextLayer(page.id, words)

    expect(e.pagesWithoutText()).toEqual([])
    const hits = e.search('12345')
    expect(hits.length).toBe(1)
    // The invisible word sits where the printed word is.
    const q = hits[0].quads[0]
    const printed = words.find((w) => w.text === '12345')!
    expect(Math.abs(q[0] - printed.bbox[0])).toBeLessThan(3)
    expect(Math.abs(q[2] - printed.bbox[2])).toBeLessThan(3)
    // And it isn't drawn: the page looks the same.
    const after = e.render(page.id, 1)
    const before = new Engine()
    before.open('scan.pdf', await scannedPdf())
    expect(Buffer.compare(Buffer.from(after.pixels), Buffer.from(before.render(before.pageIds()[0], 1).pixels))).toBe(0)
  }, 60_000)
})

describe('digital signatures', () => {
  const pw = 'correct horse'
  let p12: Uint8Array

  it('creates and reads a digital ID', async () => {
    p12 = await createDigitalId({ name: 'Ada Lovelace', email: 'ada@example.com', organization: 'Analytical Engines', password: pw })
    const id = readDigitalId(p12, pw)
    expect(id.name).toBe('Ada Lovelace')
    expect(id.chain.length).toBe(1)
    expect(() => readDigitalId(p12, 'wrong')).toThrow(/password/)
  })

  it('signs, verifies, detects tampering, and supports a second signature', async () => {
    const e = new Engine()
    const s = e.open('contract.pdf', await textPdf())
    const { bytes, state } = e.sign({
      p12, password: pw, pageId: s.pages[0].id, rect: [200, 220, 380, 280], reason: 'I approve this document', location: 'Colombo',
    })
    expect(state.signatures).toHaveLength(1)
    const [sig] = state.signatures
    expect(sig).toMatchObject({ signer: 'Ada Lovelace', valid: true, coversWholeFile: true, selfSigned: true, reason: 'I approve this document', problem: null })
    expect(sig.signedAt).toBeTruthy()
    // The visible signature box is a signature field with an appearance.
    expect(state.pages[0].widgets.map((w) => w.kind)).toEqual(['signature'])
    const { pixels, width } = e.render(state.pages[0].id, 1)
    let ink = 0
    for (let y = 225; y < 275; y++) for (let x = 205; x < 375; x++) if (pixels[(y * width + x) * 4] < 128) ink++
    expect(ink).toBeGreaterThan(50)

    // Flip one byte inside the signed range: the signature must fail.
    const tampered = bytes.slice()
    const at = new TextDecoder('latin1').decode(tampered).indexOf('Invoice') + 2
    tampered[at] ^= 1
    const t = new Engine()
    expect(t.open('t.pdf', tampered).signatures[0]).toMatchObject({ valid: false })

    // Edits after signing are appended, so the first signature still verifies.
    e.addAnnot(state.pages[0].id, { type: 'Text', at: [10, 10], text: 'Looks good', color: [1, 1, 0] })
    const edited = e.save({ compress: 'strong', security: { mode: 'keep' } })
    expect(Buffer.compare(Buffer.from(edited.subarray(0, bytes.length)), Buffer.from(bytes))).toBe(0)
    const r = new Engine().open('edited.pdf', edited)
    expect(r.signatures[0]).toMatchObject({ valid: true, coversWholeFile: false })
    expect(() => e.save({ compress: 'standard', security: { mode: 'none' } })).toThrow(/signed/)

    // A second, invisible signature.
    const second = e.sign({ p12, password: pw, pageId: null, reason: 'Countersigned' })
    expect(second.state.signatures.map((x) => [x.field, x.valid, x.coversWholeFile])).toEqual([
      ['Signature1', true, false],
      ['Signature2', true, true],
    ])
  })

  it('signs documents that already have form fields', async () => {
    const doc = await LibDoc.create()
    const p = doc.addPage([300, 300])
    doc.getForm().createTextField('name').addToPage(p, { x: 20, y: 200, width: 150, height: 20 })
    const id = readDigitalId(p12, pw)
    const signed = signPdf(await doc.save(), id, {})
    const e = new Engine()
    const s = e.open('form.pdf', signed)
    expect(s.signatures[0].valid).toBe(true)
    expect(s.pages[0].widgets.map((w) => w.kind).sort()).toEqual(['signature', 'text'])
  })
})
