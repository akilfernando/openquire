import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Engine } from '../../../src/engine/core'
import { createDigitalId } from '../../../src/engine/signing'

export const SECRET = 'alice@example.com'
export const ORPHAN = 'UNREACHABLE_PRIVATE_COPY_87261'

/** Separate text operators must still be recognized as one email address. */
export function splitTextPdf() {
  const doc = new mupdf.PDFDocument()
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } },
    'BT /F1 12 Tf 60 760 Td [(Contact ) (alice@) (example.com) ( today)] TJ ET'))
  doc.addStream(ORPHAN, {})
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

/** Embedded subset font: text cannot be checked by searching raw ASCII alone. */
export async function embeddedTextPdf() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const bytes = readFileSync(fileURLToPath(new URL('../../../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url)))
  const font = await doc.embedFont(bytes, { subset: true })
  const page = doc.addPage([595, 842])
  let x = 60
  for (const text of ['Contact ', 'alice@', 'example.com', ' today']) {
    page.drawText(text, { x, y: 760, size: 12, font })
    x += font.widthOfTextAtSize(text, 12)
  }
  return doc.save()
}

export async function rotatedFormPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 500])
  // Rotation is stored independently of the form's default-space rectangle.
  const { degrees } = await import('pdf-lib')
  page.setRotation(degrees(90))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const field = doc.getForm().createTextField('contact')
  field.addToPage(page, { x: 40, y: 300, width: 220, height: 24, font })
  field.setText(SECRET)
  doc.getForm().updateFieldAppearances(font)
  return doc.save()
}

export async function signedIncrementalPdf() {
  const engine = new Engine()
  const state = engine.open('signed.pdf', splitTextPdf())
  const p12 = await createDigitalId({ name: 'Corpus signer', password: 'fixture-only' })
  await engine.sign({ p12, password: 'fixture-only', pageId: null })
  engine.addAnnot(state.pages[0].id, { type: 'Text', at: [10, 10], text: 'Later revision', color: [1, 1, 0] })
  const bytes = engine.save({ compress: 'none', security: { mode: 'keep' } })
  engine.close()
  return bytes
}
