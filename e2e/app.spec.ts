import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import * as mupdf from 'mupdf'
import { LINES, bytesOf, openFile, openReport, openSection, pagePoint, pdfText, reportPdf, save, scannedPdf } from './fixtures'

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
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
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
  await expect(page.getByRole('tab', { name: 'Comments, 1' })).toBeVisible()
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
  // Keep the test offline: no timestamp from a live server.
  await dialog.getByLabel(/Add a trusted timestamp/).uncheck()
  const signedDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Sign & download' }).click()
  const signed = await bytesOf(await signedDownload)
  // A self-signed ID is valid, but its identity can't be verified.
  await expect(page.locator('.sig.warn')).toContainText('Valid, identity not verified')
  await expect(page.locator('.sig.warn')).toContainText('Ada Lovelace')
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

test.describe('tablet', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true })

  test('uses drawers and supports keyboard page navigation', async ({ page }) => {
    await openReport(page)
    // Sidebars start closed on a narrow screen and open as drawers.
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await page.getByRole('button', { name: 'Toggle left sidebar' }).click()
    await expect(page.locator('.sidebar.left')).toBeVisible()
    await page.locator('.drawer-scrim').click({ position: { x: 700, y: 500 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)

    // Ctrl+wheel zooms, as a trackpad pinch does.
    const before = await page.locator('.zoom-label').textContent()
    await page.locator('main.desk').hover()
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -200)
    await page.keyboard.up('Control')
    await expect(page.locator('.zoom-label')).not.toHaveText(before!)
  })
})

test('reorders pages from the keyboard', async ({ page }) => {
  await openReport(page)
  const first = page.getByRole('option').first()
  await first.focus()
  await page.keyboard.press('Control+ArrowDown')
  // The form page (originally second) is now first, and focus followed the moved page.
  await expect(page.getByRole('option').nth(1)).toBeFocused()
  await expect(page.locator('.page').first().locator('.widget')).toHaveCount(3)
})

test('edits a whole paragraph that reflows', async ({ page }) => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const text = 'This paragraph spans several lines so that editing it exercises the paragraph editor, which keeps the width, spacing and alignment of the original text.'
  doc.addPage([595, 842]).drawText(text, { x: 72, y: 760, size: 13, font, maxWidth: 260, lineHeight: 18 })
  await page.goto('/')
  await openFile(page, 'para.pdf', Buffer.from(await doc.save()))
  await expect(page.locator('.page canvas[width]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const p = await pagePoint(page, 0, 120, 842 - 742)
  await page.mouse.click(p.x, p.y)
  const editor = page.locator('.line-edit')
  await expect(editor).toHaveValue(text)
  await page.screenshot({ path: 'test-results/paragraph-editor.png', clip: { x: 0, y: 0, width: 1440, height: 500 } })
  await editor.fill('A rewritten paragraph that is long enough to wrap across a few lines inside the same width as the original paragraph had.')
  await editor.press('Control+Enter')
  await expect(page.locator('.line-edit')).toHaveCount(0)
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/paragraph-edited.png', clip: { x: 0, y: 0, width: 1440, height: 500 } })
  const saved = pdfText(await save(page))
  expect(saved.replace(/\s+/g, ' ')).toContain('A rewritten paragraph that is long enough to wrap')
  expect(saved).not.toContain('exercises the paragraph editor')
})

test('adds an internal link and follows it', async ({ page }) => {
  await openReport(page)
  await page.getByRole('button', { name: 'Link', exact: true }).click()
  const a = await pagePoint(page, 0, 60, 60)
  const b = await pagePoint(page, 0, 300, 90)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 5 })
  await page.mouse.up()
  const dialog = page.getByRole('dialog', { name: 'Add link' })
  await dialog.getByRole('button', { name: 'Page in this document' }).click()
  await dialog.getByLabel(/Page number/).fill('2')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.link-area')).toHaveCount(1)

  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2)
  await expect(page.locator('.view-title')).toContainText('Page 2 of 2')

  const doc = mupdf.Document.openDocument(await save(page), 'application/pdf')
  const [link] = doc.loadPage(0).getLinks()
  expect(doc.resolveLink(link)).toBe(1)
})

test('moves and deletes an image with the Edit tool', async ({ page }) => {
  const d = new mupdf.PDFDocument()
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false)
  pix.clear(0)
  const img = d.addImage(new mupdf.Image(pix))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { XObject: { Im: img } }, 'q 100 0 0 100 50 692 cm /Im Do Q'))
  await page.goto('/')
  await openFile(page, 'img.pdf', Buffer.from(d.saveToBuffer('').asUint8Array()))
  await expect(page.locator('.page canvas[width]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.img-box')).toHaveCount(1)

  const from = await pagePoint(page, 0, 100, 100)
  const to = await pagePoint(page, 0, 300, 400)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await expect(page.locator('.img-bar')).toBeVisible()
  let saved = mupdf.Document.openDocument(await save(page), 'application/pdf')
  const pixAt = (doc: mupdf.Document, x: number, y: number) => {
    const p = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false)
    return p.getPixels()[(y * p.getWidth() + x) * 3]
  }
  expect(pixAt(saved, 300, 400)).toBeLessThan(50)
  expect(pixAt(saved, 100, 100)).toBeGreaterThan(200)

  await page.getByRole('toolbar', { name: 'Image 1' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.img-box')).toHaveCount(0)
  saved = mupdf.Document.openDocument(await save(page), 'application/pdf')
  expect(pixAt(saved, 300, 400)).toBeGreaterThan(200)
})

test('designs a form field and fills it in', async ({ page }) => {
  const d = new mupdf.PDFDocument()
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, [
    'BT /F1 12 Tf 60 770 Td (Company:) Tj ET',
    'BT /F1 12 Tf 60 720 Td (Phone ____________________) Tj ET',
  ].join('\n')))
  await page.goto('/')
  await openFile(page, 'flat.pdf', Buffer.from(d.saveToBuffer('').asUint8Array()))
  await expect(page.locator('.page canvas[width]').first()).toBeVisible()

  await page.getByRole('button', { name: 'Form field', exact: true }).click()
  const a = await pagePoint(page, 0, 130, 842 - 785)
  const b = await pagePoint(page, 0, 360, 842 - 765)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 5 })
  await page.mouse.up()
  const dialog = page.getByRole('dialog', { name: 'Add text field' })
  await dialog.getByLabel('Name').fill('Company')
  await dialog.getByLabel('Required').check()
  await dialog.getByRole('button', { name: 'Add field' }).click()
  await expect(page.locator('.field-box')).toHaveCount(1)

  // Detection adds the underscore blank, named after its label.
  await openSection(page, 'Forms & flattening')
  await page.getByRole('button', { name: 'Detect fields' }).click()
  await expect(page.locator('.status-bar')).toContainText('Added 1 form field')
  await expect(page.locator('.field-box')).toHaveCount(2)

  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.locator('.widget.text').first().fill('Teams Squared')
  await page.locator('.widget.text').first().press('Enter')
  const saved = mupdf.Document.openDocument(await save(page), 'application/pdf').asPDF() as mupdf.PDFDocument
  const values = Object.fromEntries(saved.loadPage(0).getWidgets().map((w) => [w.getName(), w.getValue()]))
  expect(values).toEqual({ Company: 'Teams Squared', Phone: '' })
})

test('sanitizes a document', async ({ page }) => {
  await openReport(page)
  await openSection(page, 'Properties')
  await page.getByLabel('Author').fill('Secret Author')
  await page.getByLabel('Author').blur()
  await openSection(page, 'Sanitize')
  await page.getByRole('button', { name: 'Sanitize document' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sanitize document' })
  await dialog.getByRole('button', { name: 'Sanitize' }).click()
  await expect(page.locator('.status-bar')).toContainText('Removed')
  const raw = new TextDecoder('latin1').decode(await save(page))
  expect(raw).not.toContain('Secret Author')
})

test('saves a PDF/A copy', async ({ page }) => {
  await openReport(page)
  await openSection(page, 'Archive (PDF/A)')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save as PDF/A' }).click()
  const d = await download
  expect(d.suggestedFilename()).toBe('report-pdfa.pdf')
  await expect(page.locator('.status-bar')).toContainText('flattened')
  const bytes = new TextDecoder('latin1').decode(await bytesOf(d))
  expect(bytes).toContain('pdfaid:part>2<')
  await page.getByRole('button', { name: 'Check PDF/A' }).click()
  await expect(page.locator('.status-bar')).toContainText('Not PDF/A')
})

test('tags a document and edits its reading order', async ({ page }) => {
  await openReport(page)
  await page.getByRole('tab', { name: 'Accessibility' }).click()
  await expect(page.getByText('This document has no tags yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Check accessibility' }).click()
  await expect(page.locator('.a11y-report')).toContainText('The document is not tagged')

  await page.getByRole('button', { name: 'Tag document' }).click()
  await expect(page.locator('.status-bar')).toContainText('Tagged the document.')
  const items = page.locator('.tag-item')
  await expect(items.first()).toBeVisible()
  await expect(page.locator('.a11y-report')).not.toContainText('The document is not tagged')
  const count = await items.count()
  expect(count).toBeGreaterThan(2)

  // Move the second tag first, then change its type.
  const second = (await items.nth(1).locator('.tag-text').textContent())!
  await items.nth(1).getByRole('button', { name: 'Read earlier' }).click()
  await expect(items.first().locator('.tag-text')).toHaveText(second)
  await items.first().getByRole('combobox', { name: 'Tag type' }).selectOption('H1')
  await expect(items.first().getByRole('combobox', { name: 'Tag type' })).toHaveValue('H1')

  const results = await new AxeBuilder({ page }).include('.sidebar.left').withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ') + ' ' + n.failureSummary).join(', ')}`)).toEqual([])
  const bytes = new TextDecoder('latin1').decode(await save(page))
  expect(bytes).toContain('StructTreeRoot')
})

test('opens documents in tabs and shows two side by side', async ({ page }) => {
  await openReport(page)
  await openFile(page, 'scan.pdf', await scannedPdf())
  const tabs = page.getByRole('navigation', { name: 'Open documents' })
  await expect(tabs.getByRole('button', { name: 'scan', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.view-title')).toContainText('scan')

  // Each tab keeps its own document and undo history.
  await tabs.getByRole('button', { name: 'report', exact: true }).click()
  await expect(page.locator('.view-title')).toContainText('report')
  await expect(page.locator('main.desk > .page')).toHaveCount(2)

  // Open the scan beside the report, then link scrolling.
  await tabs.getByRole('button', { name: 'Open scan to the side' }).click()
  const side = page.getByRole('region', { name: 'scan, side view' })
  await expect(side.locator('canvas[width]').first()).toBeVisible()
  await expect(side.getByRole('button', { name: 'Link scrolling' })).toHaveAttribute('aria-pressed', 'true')
  // The report's second page at the top of the main view brings the side view along.
  await openFile(page, 'report2.pdf', await reportPdf())
  await tabs.getByRole('button', { name: 'report', exact: true }).click()
  await tabs.getByRole('button', { name: 'Open report2 to the side' }).click()
  const side2 = page.getByRole('region', { name: 'report2, side view' })
  await expect(side2.locator('canvas[width]').first()).toBeVisible()
  await page.locator('main.desk').evaluate((el) => (el.scrollTop = (el.querySelectorAll('.page')[1] as HTMLElement).offsetTop))
  await expect.poll(() => side2.locator('.desk').evaluate((el) => Math.round(el.scrollTop - (el.querySelectorAll('.page')[1] as HTMLElement).offsetTop))).toBe(0)

  // Closing the active tab moves to a neighbour.
  await tabs.getByRole('button', { name: 'Close report', exact: true }).click()
  await expect(tabs.getByRole('button', { name: /^Close / })).toHaveCount(2)
  await expect(page.locator('.view-title')).not.toContainText('report ')
})
