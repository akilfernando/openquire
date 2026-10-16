import * as mupdf from 'mupdf'
import { PDFDocument as LibDoc, StandardFonts } from 'pdf-lib'

export async function textPdf() {
  const doc = await LibDoc.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([400, 300])
  p.drawText('Invoice number 12345', { x: 40, y: 240, size: 20, font })
  p.drawText('Total amount due today', { x: 40, y: 200, size: 16, font })
  return doc.save()
}

/** A "scan": the text page rendered to an image, wrapped in a new PDF with no text. */
export async function scannedPdf() {
  const src = mupdf.Document.openDocument(await textPdf(), 'application/pdf')
  const png = src.loadPage(0).toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false).asPNG()
  const d = new mupdf.PDFDocument()
  const img = d.addImage(new mupdf.Image(png))
  d.insertPage(-1, d.addPage([0, 0, 400, 300], 0, { XObject: { Im0: img } }, 'q 400 0 0 300 0 0 cm /Im0 Do Q'))
  return d.saveToBuffer('compress').asUint8Array().slice()
}
