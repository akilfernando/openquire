import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import { bytesOf, openReport, save } from './fixtures'

const example = (name: string) => ({ name, mimeType: 'text/javascript', buffer: readFileSync(`public/docs/examples/${name}`) })

async function install(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.locator('.modal input[type=file][accept*=".js"]').setInputFiles(file)
}

test('installs a third-party plugin that adds an export format, a pane and a tool', async ({ page }) => {
  await openReport(page)
  await install(page, example('csv-export.js'))
  const review = page.getByRole('group', { name: 'Install CSV export?' })
  await expect(review).toContainText('Read the open document')
  const axe = await new AxeBuilder({ page }).include('.modal').withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
  await review.getByRole('button', { name: 'Install' }).click()
  await expect(page.getByRole('checkbox', { name: 'Turn on CSV export' })).toBeChecked()
  await page.keyboard.press('Escape')

  // A new export format, from the command palette.
  await page.keyboard.press('Control+p')
  await page.getByPlaceholder('Type a command...').fill('csv')
  const download = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  const d = await download
  expect(d.suggestedFilename()).toBe('report.csv')
  const csv = new TextDecoder().decode(await bytesOf(d))
  expect(csv).toMatch(/^page,line\n1,"Quarterly Report"/)
  await expect(page.locator('.status-bar')).toContainText('CSV export: Exported')

  // Its pane, drawn by the app.
  await page.getByRole('tab', { name: 'Word count' }).click()
  await page.getByRole('button', { name: 'Count words' }).click()
  await expect(page.locator('.plugin-pane .pane-heading')).toContainText('words')

  // A second plugin with a dock tool that changes the document.
  await install(page, example('review-notes.js'))
  await expect(page.getByRole('group', { name: 'Install Review notes?' })).toContainText('Change the open document')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Review note' }).click()
  const box = (await page.locator('.page').first().boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + 200)
  const doc = mupdf.Document.openDocument(await save(page), 'application/pdf').asPDF() as mupdf.PDFDocument
  const notes = doc.loadPage(0).getAnnotations().filter((a) => a.getType() === 'Text').map((a) => a.getContents())
  expect(notes).toContain('Reviewed by Reviewer')

  // Plugins persist, and can be turned off.
  await page.reload()
  await openReport(page)
  await expect(page.getByRole('tab', { name: 'Word count' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByRole('button', { name: 'Plugins' }).click()
  await page.getByRole('checkbox', { name: 'Turn on CSV export' }).uncheck()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tab', { name: 'Word count' })).toHaveCount(0)
})

test('keeps plugins in their sandbox', async ({ page }) => {
  const sneaky = `export const manifest = { id: 'dev.test.sneaky', name: 'Sneaky', version: '1.0.0', apiVersion: 1, permissions: [] }
export default function activate(api) {
  api.commands.add({ id: 'try', name: 'Try things', run: async () => {
    const results = []
    try { await fetch('https://example.com'); results.push('fetch worked') } catch (e) { results.push('no fetch') }
    results.push(typeof document === 'undefined' ? 'no document' : 'document visible')
    try { await api.document.info(); results.push('read worked') } catch (e) { results.push(e.message) }
    await api.ui.notice(results.join('; '))
  } })
}`
  await openReport(page)
  await install(page, { name: 'sneaky.js', mimeType: 'text/javascript', buffer: Buffer.from(sneaky) })
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+p')
  await page.getByPlaceholder('Type a command...').fill('try things')
  await page.keyboard.press('Enter')
  await expect(page.locator('.status-bar')).toContainText("Sneaky: no fetch; no document; Sneaky doesn't have the document:read permission.")

  // A plugin for a newer API version is refused.
  await install(page, { name: 'future.js', mimeType: 'text/javascript', buffer: Buffer.from(sneaky.replace('apiVersion: 1', 'apiVersion: 2').replace('sneaky', 'future')) })
  await expect(page.locator('.modal .error')).toContainText('needs plugin API version 2')
})

test('the plugin documentation is published with the site', async ({ page, request }) => {
  await page.goto('/docs/plugins.html')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plugins and themes')
  for (const href of ['examples/csv-export.js', 'examples/review-notes.js', 'openquire-plugin.d.ts']) {
    const res = await request.get(`/docs/${href}`)
    expect(res.ok(), href).toBe(true)
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
})
