import { it } from 'vitest'
import * as mupdf from 'mupdf'
import { skewAngle } from '../src/engine/scan'
it('dbg', () => {
  for (const deg of [3, -3]) {
    const d = new mupdf.PDFDocument()
    const font = d.addSimpleFont(new mupdf.Font('Times-Roman'))
    const lines = Array.from({ length: 24 }, (_, i) => `BT /F1 13 Tf 70 ${760 - i * 26} Td (Line ${i + 1} of a letter that was scanned at a slight angle.) Tj ET`)
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, lines.join('\n')))
    const page = d.loadPage(0)
    const m = mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.translate(-297.5, -421), mupdf.Matrix.rotate(deg)), mupdf.Matrix.translate(297.5, 421))
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 595, 842], false)
    pix.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
    page.run(dev, m)
    dev.close()
    const g = pix.getPixels()
    let dark = 0; for (const v of g) if (v < 128) dark++
    console.log('DEG', deg, 'dark', dark, 'skew', skewAngle(g, 595, 842))
  }
})
