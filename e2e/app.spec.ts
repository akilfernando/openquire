import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import * as mupdf from 'mupdf'
import { LINES, bytesOf, openFile, openReport, openSection, pagePoint, pdfText, save, scannedPdf } from './fixtures'

test('opens a document and finds text', async ({ page }) => {
  await openReport(page)
  await expect(page.locator('.page')).toHaveCount(2)
  await expect(page.locator('.view-title')).toContainText('report')
  await page.keyboard.press('Control+f')
  await page.getByPlaceholder('Find...').fill('regions')
  await page.keyboard.press('Enter')
  await expect(page.locator('.find-count')).toHaveText('1/1')
})

test('command palette runs commands', async ({ page }) => {
  await openReport(page)
  await page.keyboard.press('Control+p')
  await page.getByPlaceholder('Type a command...').fill('tool high')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Highlight', exact: true })).toHaveClass(/is-active/)
})

test('edits a line of existing text', async ({ page }) => {
  await openReport(page)
  await page.getByRole('button', { name: 'Edit text', exact: true }).click()
  const p = await pagePoint(page, 0, 120, 842 - 716)
  await page.mouse.click(p.x, p.y)
  const editor = page.locator('.line-edit')
  await expect(editor).toHaveValue(LINES.revenue)
  await editor.fill('Revenue grew 24 percent this quarter.')
  await editor.press('Enter')
  const text = pdfText(await save(page))
  expect(text).toContain('Revenue grew 24 percent this quarter.')
  expect(text).not.toContain(LINES.revenue)
})

test('highlights text as a real annotation', async ({ page }) => {
  await openReport(page)
  await page.getByRole('button', { name: 'Highlight', exact: true }).click()
  const a = await pagePoint(page, 0, 62, 842 - 725)
  const b = await pagePoint(page, 0, 300, 842 - 725)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Comments' }).locator('.badge')).toHaveText('1')
  const doc = mupdf.Document.openDocument(await save(page), 'application/pdf').asPDF() as mupdf.PDFDocument
  expect(doc.loadPage(0).getAnnotations().map((x) => x.getType())).toContain('Highlight')
})

test('fills a form on the page', async ({ page }) => {
  await openReport(page)
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await page.locator('.widget.text').fill('Ada Lovelace')
  await page.locator('.widget.text').press('Enter')
  await page.locator('.widget.toggle').click()
  await page.locator('.widget.choice').selectOption('Pro')
  await expect(page.locator('.widget.toggle')).toHaveAttribute('aria-pressed', 'true')
  const doc = mupdf.Document.openDocument(await save(page), 'application/pdf').asPDF() as mupdf.PDFDocument
  const values = Object.fromEntries(doc.loadPage(1).getWidgets().map((w) => [w.getName(), w.getValue()]))
  expect(values.full_name).toBe('Ada Lovelace')
  expect(values.plan).toBe('Pro')
  expect(values.subscribe).not.toBe('Off')
})

test('redacts by pattern', async ({ page }) => {
  await openReport(page)
  await openSection(page, 'Redact')
  await page.getByLabel('Email addresses').check()
  await page.getByRole('button', { name: 'Find and mark' }).click()
  await expect(page.locator('.section > summary', { hasText: 'Redact' })).toContainText('1 marked')
  await page.getByRole('button', { name: /^Apply 1 redaction/ }).click()
  await expect(page.locator('.status-bar')).toContainText('Redacted content on 1 page')
  const text = pdfText(await save(page))
  expect(text).not.toContain('jane.doe@example.com')
  expect(text).toContain('for details.')
})

test('protects with a password and reopens', async ({ page }) => {
  await openReport(page)
  await openSection(page, 'Compression & security')
  await page.getByLabel('Password protection').selectOption('set')
  await page.getByLabel('Password to open (optional)').fill('open-sesame')
  await page.getByLabel('Permissions password').fill('owner-secret')
  const bytes = await save(page)
  expect(mupdf.Document.openDocument(bytes, 'application/pdf').needsPassword()).toBe(true)

  await openFile(page, 'locked.pdf', Buffer.from(bytes))
  const dialog = page.getByRole('dialog', { name: 'Password required' })
  await dialog.getByPlaceholder('Password').fill('wrong')
  await dialog.getByRole('button', { name: 'Open' }).click()
  await expect(dialog).toContainText("didn't work")
  await dialog.getByPlaceholder('Password').fill('open-sesame')
  await dialog.getByRole('button', { name: 'Open' }).click()
  await expect(page.locator('.status-bar')).toContainText('Protected')
  expect(pdfText(bytes, 'open-sesame')).toContain(LINES.title)
})

test('signs with a new digital ID and verifies it', async ({ page }) => {
  await openReport(page)
  await page.getByRole('button', { name: 'Sign with a digital ID' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Sign with a digital ID' })
  await dialog.getByRole('button', { name: 'Create a new ID' }).click()
  await dialog.getByLabel('Your name').fill('Ada Lovelace')
  await dialog.getByLabel('Password', { exact: true }).fill('engine-123')
  await dialog.getByLabel('Confirm').fill('engine-123')
  const idDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Create & download ID' }).click()
  expect((await idDownload).suggestedFilename()).toBe('Ada-Lovelace.p12')
  const signedDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Sign & download' }).click()
  const signed = await bytesOf(await signedDownload)
  await expect(page.locator('.sig.ok')).toContainText('Valid signature')
  await expect(page.locator('.sig.ok')).toContainText('Ada Lovelace')
  expect(new TextDecoder('latin1').decode(signed)).toContain('/SubFilter/adbe.pkcs7.detached')
})

test('recognizes text on a scanned page', async ({ page }) => {
  test.slow()
  await page.goto('/')
  await openFile(page, 'scan.pdf', await scannedPdf())
  await expect(page.locator('.page canvas[width]').first()).toBeVisible()
  await openSection(page, 'Recognize text (OCR)')
  await page.getByRole('button', { name: 'Pages without text (1)' }).click()
  await expect(page.locator('.status-bar')).toContainText('Recognized text on 1 page', { timeout: 60_000 })
  await page.keyboard.press('Control+f')
  await page.getByPlaceholder('Find...').fill('thirty days')
  await page.keyboard.press('Enter')
  await expect(page.locator('.find-count')).toHaveText('1/1')
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const view of ['empty state', 'document view'] as const) {
      test(`has no serious violations: ${view}, ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme })
        if (view === 'empty state') await page.goto('/')
        else await openReport(page)
        await expect(page.locator('.app')).toHaveClass(new RegExp(`theme-${scheme}`))
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
        const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
        expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
      })
    }
  }
})
