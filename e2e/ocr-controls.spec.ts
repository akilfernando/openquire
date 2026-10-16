import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import * as mupdf from 'mupdf'
import { openFile, save, scannedPdf } from './fixtures'

test('stopping OCR preserves the current page, skips the rest and keeps changes unsaved', async ({ page }) => {
  test.slow()
  const source = await PDFDocument.load(await scannedPdf())
  const document = await PDFDocument.create()
  for (let i = 0; i < 2; i++) document.addPage((await document.copyPages(source, [0]))[0])

  // Hold the first OCR worker load so the stop occurs during the first page,
  // while keeping real Tesseract recognition and PDF output in this test.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested!: () => void
  const started = new Promise<void>((resolve) => { requested = resolve })
  await page.route('**/ocr/worker.min.js*', async (route) => {
    requested()
    await gate
    await route.continue()
  })
  await page.goto('/')
  await openFile(page, 'two-scans.pdf', Buffer.from(await document.save()))
  await expect(page.locator('.page canvas[width]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Recognize text (OCR)', exact: true }).first().click()
  await started
  const progress = page.getByRole('dialog', { name: 'Recognizing text', exact: true })
  try {
    await expect(progress).toContainText('0 of 2 pages processed')
    await progress.getByRole('button', { name: 'Stop after this page' }).click()
    await expect(progress.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled()
  } finally {
    release()
  }
  await expect(progress).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.status-bar')).toContainText('processed 1 of 2 pages; 1 skipped')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: 'Close two-scans', exact: true }).click()
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' })
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()
  const pdf = mupdf.Document.openDocument(await save(page), 'application/pdf')
  expect(pdf.loadPage(0).toStructuredText().asText()).toContain('thirty days')
  expect(pdf.loadPage(1).toStructuredText().asText().trim()).toBe('')
  pdf.destroy()
})
