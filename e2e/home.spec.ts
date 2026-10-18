import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { reportPdf } from './fixtures'

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
