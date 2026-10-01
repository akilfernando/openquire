import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'

/** A scan of a page of text, rotated by `deg` degrees as if fed crooked. */
function crookedScan(deg: number, rotate = 0) {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Times-Roman'))
  const lines = Array.from({ length: 24 }, (_, i) => `BT /F1 13 Tf 70 ${760 - i * 26} Td (Line ${i + 1} of a letter that was scanned at a slight angle.) Tj ET`)
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, lines.join('\n')))
  const page = d.loadPage(0)
  const k = 150 / 72
  // Rotate about the page centre, then scale to 150 dpi.
  const m = mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.translate(-297.5, -421), mupdf.Matrix.rotate(deg)), mupdf.Matrix.concat(mupdf.Matrix.translate(297.5, 421), mupdf.Matrix.scale(k, k)))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, Math.round(595 * k), Math.round(842 * k)], false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  page.run(dev, m)
  dev.close()
  const out = new mupdf.PDFDocument()
  const img = out.addImage(new mupdf.Image(pix))
  out.insertPage(-1, out.addPage([0, 0, 595, 842], rotate as Parameters<mupdf.PDFDocument['addPage']>[1], { XObject: { Im0: img } }, 'q 595 0 0 842 0 0 cm /Im0 Do Q'))
  return out.saveToBuffer('compress').asUint8Array().slice()
}

describe('scan clean-up', () => {
  for (const deg of [3, -2.5]) {
    it(`measures and straightens a page scanned ${deg} degrees off`, () => {
      const e = new Engine()
      const s = e.open('scan.pdf', crookedScan(deg))
      const [skew] = e.detectSkew()
      expect(Math.abs(Math.abs(skew) - Math.abs(deg))).toBeLessThan(0.3)
      const { count } = e.straighten()
      expect(count).toBe(1)
      expect(Math.abs(e.detectSkew()[0])).toBeLessThan(0.3)
      // Undo restores the original page.
      e.undo()
      expect(Math.abs(e.detectSkew([s.pages[0].id])[0])).toBeGreaterThan(2)
    })
  }

  it('straightens a page that is itself turned upside down', () => {
    const e = new Engine()
    e.open('scan.pdf', crookedScan(2, 180))
    expect(e.straighten().count).toBe(1)
    expect(Math.abs(e.detectSkew()[0])).toBeLessThan(0.3)
  })

  it('leaves straight and blank pages alone', () => {
    const e = new Engine()
    e.open('scan.pdf', crookedScan(0))
    e.newBlank()
    expect(e.detectSkew()).toEqual([0])
    const f = new Engine()
    f.open('scan.pdf', crookedScan(0))
    expect(f.straighten().count).toBe(0)
  })
})

describe('language detection', () => {
  it('tells languages apart from common words, even without accents', async () => {
    const { detectLanguage } = await import('../src/ocr-languages')
    expect(detectLanguage('Compte rendu de la reunion du conseil. La societe a presente ses resultats pour l annee et les membres ont approuve le budget.')).toBe('fra')
    expect(detectLanguage('The board met on Monday and approved the budget for the next year, with thanks to all of the staff for their work.')).toBe('eng')
    expect(detectLanguage('Der Vorstand hat den Haushalt genehmigt und die neue Strategie mit den Mitarbeitern besprochen, und das ist gut.')).toBe('deu')
    expect(detectLanguage('El consejo aprobo el presupuesto para el proximo ano y la nueva estrategia de la empresa con los empleados.')).toBe('spa')
    expect(detectLanguage('Too short to tell.')).toBeNull()
  })
})
