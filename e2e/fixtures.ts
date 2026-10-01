import { readFileSync } from 'node:fs'
import { expect, type Download, type Page } from '@playwright/test'
import * as mupdf from 'mupdf'
import { PDFDocument, StandardFonts } from 'pdf-lib'

export const LINES = {
  title: 'Quarterly Report',
  revenue: 'Revenue grew strongly this quarter across all regions.',
  contact: 'Contact jane.doe@example.com for details.',
}

/** A two-page report with a form on page 2. Text positions are in PDF points from the top-left. */
export async function reportPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const p1 = doc.addPage([595, 842])
  p1.drawText(LINES.title, { x: 60, y: 770, size: 24, font: bold })
  p1.drawText(LINES.revenue, { x: 60, y: 720, size: 14, font })
  p1.drawText(LINES.contact, { x: 60, y: 690, size: 14, font })
  const p2 = doc.addPage([595, 842])
  p2.drawText('Name', { x: 60, y: 760, size: 12, font })
  const form = doc.getForm()
  form.createTextField('full_name').addToPage(p2, { x: 120, y: 752, width: 220, height: 22 })
  form.createCheckBox('subscribe').addToPage(p2, { x: 120, y: 712, width: 16, height: 16 })
  const plan = form.createDropdown('plan')
  plan.addOptions(['Basic', 'Pro', 'Enterprise'])
  plan.addToPage(p2, { x: 120, y: 670, width: 150, height: 22 })
  return Buffer.from(await doc.save())
}

/** An image-only "scan" of a short letter, with no text layer. */
export async function scannedPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const p = doc.addPage([595, 842])
  p.drawText('SERVICE AGREEMENT', { x: 70, y: 760, size: 22, font })
  p.drawText('The client agrees to pay within thirty days.', { x: 70, y: 720, size: 15, font })
  const src = mupdf.Document.openDocument(await doc.save(), 'application/pdf')
  const png = src.loadPage(0).toPixmap(mupdf.Matrix.scale(2.5, 2.5), mupdf.ColorSpace.DeviceGray, false).asPNG()
  const d = new mupdf.PDFDocument()
  const img = d.addImage(new mupdf.Image(png))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { XObject: { Im0: img } }, 'q 595 0 0 842 0 0 cm /Im0 Do Q'))
  return Buffer.from(d.saveToBuffer('compress').asUint8Array())
}

export async function openFile(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type=file]').first().setInputFiles({ name, mimeType: 'application/pdf', buffer })
}

export async function openReport(page: Page) {
  await page.goto('/')
  await openFile(page, 'report.pdf', await reportPdf())
  await expect(page.locator('.page canvas[width]').first()).toBeVisible()
}

/** Screen position of a point given in PDF points from the page's top-left corner. */
export async function pagePoint(page: Page, index: number, x: number, y: number) {
  const box = (await page.locator('.page').nth(index).boundingBox())!
  const k = box.width / 595
  return { x: box.x + x * k, y: box.y + y * k }
}

export async function bytesOf(download: Download) {
  return new Uint8Array(readFileSync((await download.path())!))
}

export function pdfText(bytes: Uint8Array, password?: string) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  if (password) doc.authenticatePassword(password)
  return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText().asText()).join('\n')
}

export async function save(page: Page) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  return bytesOf(await download)
}

export async function openSection(page: Page, title: string) {
  const summary = page.locator('.section > summary', { hasText: title })
  const open = await summary.evaluate((s) => (s.parentElement as HTMLDetailsElement).open)
  if (!open) await summary.click()
}

export async function status(page: Page) {
  return page.locator('.status-bar')
}
