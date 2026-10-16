import { test, expect } from '@playwright/test'
import { openFile, reportPdf } from './fixtures'
import * as mupdf from 'mupdf'

test('cancelling a protected input leaves password controls usable and continues imports', async ({ page }) => {
  const source = mupdf.Document.openDocument(await reportPdf(), 'application/pdf').asPDF()!
  const encrypted = source.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner')
  const locked = Buffer.from(encrypted.asUint8Array())
  encrypted.destroy(); source.destroy()
  await page.goto('/')
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'locked.pdf', mimeType: 'application/pdf', buffer: locked },
    { name: 'later.pdf', mimeType: 'application/pdf', buffer: await reportPdf() },
  ])
  await expect(page.getByRole('dialog', { name: 'Importing files' })).toBeHidden()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Import results' })).toContainText('1 completed · 0 failed · 1 skipped')
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab')).toContainText('later')
})

test('stopping a slow import finishes its file and skips the next one', async ({ page }) => {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'slow.pdf') await new Promise(resolve => setTimeout(resolve, 1500))
      return original.call(this)
    }
  })
  await page.goto('/')
  const buffer = await reportPdf()
  await page.locator('input[type=file]').first().setInputFiles(['slow.pdf', 'skipped.pdf'].map(name => ({ name, mimeType: 'application/pdf', buffer })))
  await page.getByRole('button', { name: 'Stop after this file', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Import results' })).toContainText('1 completed · 0 failed · 1 skipped')
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab')).toContainText('slow')
})

test('converted documents require saving before closing', async ({ page }) => {
  await page.goto('/')
  await openFile(page, 'source.txt', Buffer.from('A converted document needs an explicit PDF save.'))
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: 'Close source', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
})

test('a failed import preserves completed tabs and continues remaining inputs', async ({ page }) => {
  await page.goto('/')
  const buffer = await reportPdf()
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'first.pdf', mimeType: 'application/pdf', buffer },
    { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('broken') },
    { name: 'last.pdf', mimeType: 'application/pdf', buffer },
  ])
  const report = page.getByRole('dialog', { name: 'Import results' })
  await expect(report).toContainText('2 completed · 1 failed · 0 skipped')
  await expect(report).toContainText('broken.pdf: failed')
  await report.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(page.locator('.tab.is-active')).toContainText('last')
})
