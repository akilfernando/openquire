import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { reportPdf } from './fixtures'

for (const [group, sections] of [
  ['Edit & annotate', []], ['Organize', ['organize', 'split']],
  ['Convert & OCR', ['export', 'ocr']], ['Fill & sign', ['forms', 'digitalSignature']],
  ['Protect & redact', ['redact', 'security', 'sanitize']],
  ['Prepare & automate', ['archive', 'stamps', 'security']],
] as [string, string[]][]) {
  test(`home routes ${group} without changing the document`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 })
    await page.goto('/')
    const card = page.locator('.home-tool').filter({ has: page.getByRole('heading', { name: group, exact: true }) })
    await card.locator('summary').click()
    const chooser = page.waitForEvent('filechooser')
    await card.getByRole('button').click()
    await (await chooser).setFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: await reportPdf() })
    await expect(page.locator('.dock')).toBeVisible()
    if (sections.length) {
      for (const section of sections) await expect(page.locator(`[data-section="${section}"]`)).toHaveAttribute('open', '')
      await expect(page.locator(`[data-section="${sections[0]}"] summary`)).toBeFocused()
      await expect(page.getByRole('button', { name: 'Toggle right sidebar' })).toHaveAttribute('aria-expanded', 'true')
    } else {
      await expect(page.locator('.tool-context')).toContainText('Edit')
    }
    await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)
    await expect(page.locator('.status-bar .spin')).toHaveCount(0)
  })
}

test('cancelled home intent does not route a later ordinary open', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('.home-tool').filter({ hasText: 'Protect & redact' })
  await card.locator('summary').click()
  const chooser = page.waitForEvent('filechooser')
  await card.getByRole('button').click()
  await chooser
  await page.locator('input[type=file]').first().dispatchEvent('cancel')
  const next = page.waitForEvent('filechooser')
  await page.locator('.home-primary').click()
  await (await next).setFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: await reportPdf() })
  await expect(page.locator('.dock')).toBeVisible()
  await expect(page.locator('[data-section="redact"]')).not.toHaveAttribute('open', '')
})

test('exports announce prepared downloads and output failures', async ({ page }) => {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.home-primary').click()
  await (await chooser).setFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: await reportPdf() })
  await expect(page.locator('.dock')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search document tools' }).fill('export')
  for (const [label, suffix] of [['Text', '.txt'], ['HTML', '.html'], ['PNG images', '-images.zip']]) {
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: label, exact: true }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe(`report${suffix}`)
    await expect(page.locator('.status-bar [role=status]')).toHaveText(`Download prepared: report${suffix}`)
  }
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('Injected export failure') } })
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(page.locator('.status-bar [role=status]')).toContainText('Injected export failure')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)
})

test('failed routed import does not leave a task on the next import', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('.home-tool').filter({ hasText: 'Protect & redact' })
  await card.locator('summary').click()
  const chooser = page.waitForEvent('filechooser')
  await card.getByRole('button').click()
  await (await chooser).setFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') })
  await expect(page.getByRole('dialog', { name: 'Import results' })).toContainText('1 failed')
  // Dismiss through the mounted control; this routing test does not test Escape wiring.
  await page.getByRole('dialog', { name: 'Import results' }).getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(page.getByRole('dialog', { name: 'Import results' })).toHaveCount(0)
  await expect(page.locator('.status-bar .spin')).toHaveCount(0)
  await expect(page.locator('.home')).toBeVisible()
  const next = page.waitForEvent('filechooser')
  await page.locator('.home-primary').click()
  await (await next).setFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: await reportPdf() })
  await expect(page.locator('.dock')).toBeVisible()
  await expect(page.locator('[data-section="redact"]')).not.toHaveAttribute('open', '')
})

for (const colorScheme of ['light', 'dark'] as const) for (const width of [1440, 390]) {
  test(`home discovery ${colorScheme} ${width}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Make more of your PDFs.' })).toBeVisible()
    const search = page.getByRole('searchbox', { name: 'Search PDF tools' })
    await search.fill('OCR')
    await expect(page.locator('.home-tool')).toHaveCount(1)
    const summary = page.locator('.home-tool summary')
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Open a supported file to convert it to PDF.', { exact: false })).toBeVisible()
    await search.fill('no-such-tool')
    await expect(page.getByRole('status').filter({ hasText: 'No matching tools' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(page.locator('.home-tool')).toHaveCount(6)
    expect(await page.locator('.home').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    await info.attach('home.png', { body: await page.screenshot({ path: info.outputPath('home.png') }), contentType: 'image/png' })
    await page.getByRole('button', { name: 'Create a blank PDF', exact: true }).click()
    await expect(page.locator('.dock')).toBeVisible()
    await expect(page.locator('.home')).toHaveCount(0)
  })
}

 test('home open action imports a real PDF', async ({ page }) => {
   await page.goto('/')
   const chooser = page.waitForEvent('filechooser')
   await page.getByRole('button', { name: 'Open a file', exact: false }).last().click()
   await (await chooser).setFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: await reportPdf() })
   await expect(page.locator('.dock')).toBeVisible()
   await expect(page.locator('.home')).toHaveCount(0)
 })
