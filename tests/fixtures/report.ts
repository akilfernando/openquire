import * as mupdf from 'mupdf'
import { Engine } from '../../src/engine/core'

const text = (x: number, y: number, size: number, s: string, font = 'F1') => `BT /${font} ${size} Tf ${x} ${842 - y} Td (${s}) Tj ET`

/** A simple report: title, heading, paragraphs, a table and a picture, and a second page. */
export function reportPdf() {
  const d = new mupdf.PDFDocument()
  const regular = d.addSimpleFont(new mupdf.Font('Helvetica'))
  const bold = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false)
  pix.clear(200)
  const img = d.addImage(new mupdf.Image(pix))
  const rows = [['Region', 'Revenue', 'Growth'], ['North', '1,250,000', '12%'], ['South', '980,500', '-3%'], ['West', '1,100,250', '7.5%']]
  const table = rows.flatMap((r, i) => r.map((c, j) => text(72 + j * 160, 330 + i * 20, 11, c, i === 0 ? 'F2' : 'F1')))
  const page1 = [
    text(72, 90, 24, 'Quarterly Report', 'F2'),
    text(72, 140, 11, 'Revenue grew in every region this quarter, led by new customers in the north.'),
    text(72, 155, 11, 'Costs stayed flat, and the full figures are in the table below.'),
    text(72, 200, 16, 'Results by region', 'F2'),
    ...table,
    'q 160 0 0 80 72 300 cm /Im1 Do Q',
  ]
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: regular, F2: bold }, XObject: { Im1: img } }, page1.join('\n')))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: regular, F2: bold } }, [
    text(72, 90, 16, 'Outlook', 'F2'),
    text(72, 120, 11, 'We expect steady growth next quarter.'),
  ].join('\n')))
  const e = new Engine()
  e.open('report.pdf', d.saveToBuffer('').asUint8Array().slice())
  return e
}
