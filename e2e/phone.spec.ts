import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import * as mupdf from 'mupdf'
import { openReport, save } from './fixtures'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('reads, annotates, fills and signs on a 390 px phone', async ({ page }) => {
  await openReport(page)

  // Pages fit the width and nothing scrolls sideways.
  // The page is fitted to the width a frame after opening.
  await expect.poll(async () => {
    const box = (await page.locator('.page').first().boundingBox())!
    return box.x >= 0 && box.x + box.width <= 390
  }).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // The ribbon's essentials are reachable from the tab bar.
  const bar = page.getByRole('navigation', { name: 'Open documents' })
  await bar.getByRole('button', { name: 'Toggle left sidebar' }).click()
  await expect(page.locator('.sidebar.left')).toBeVisible()
  await page.locator('.drawer-scrim').click({ position: { x: 370, y: 400 } })
  await expect(page.locator('.sidebar.left')).toHaveCount(0)
  for (const name of ['Open file', 'Command palette', 'Settings']) await expect(bar.getByRole('button', { name })).toBeVisible()

  // Annotate: a sticky note, placed with a tap.
  await page.getByRole('button', { name: 'Sticky note' }).tap()
  const p = (await page.locator('.page').first().boundingBox())!
  await page.touchscreen.tap(p.x + p.width * 0.7, p.y + 100)
  await expect(page.locator('.status-bar')).not.toContainText('Error')
  // The note opens in the comments drawer, ready to type; close it to carry on.
  await expect(page.locator('.sidebar.left')).toBeVisible()
  await page.locator('.drawer-scrim').click({ position: { x: 370, y: 400 } })
  await expect(page.locator('.drawer-scrim')).toHaveCount(0)

  // Fill a field.
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await page.locator('.widget.text').fill('Ada Lovelace')
  await page.locator('.widget.text').press('Enter')

  // Sign: draw with a finger, then place it.
  await bar.getByRole('button', { name: 'Command palette' }).tap()
  await page.getByPlaceholder('Type a command...').fill('signature image')
  await page.keyboard.press('Enter')
  const pad = page.locator('.modal canvas')
  const b = (await pad.boundingBox())!
  await pad.dispatchEvent('pointerdown', { clientX: b.x + 20, clientY: b.y + 60, pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 })
  for (let i = 1; i <= 10; i++) await pad.dispatchEvent('pointermove', { clientX: b.x + 20 + i * 20, clientY: b.y + 60 + (i % 2 ? 20 : -20), pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 1 })
  await pad.dispatchEvent('pointerup', { clientX: b.x + 220, clientY: b.y + 60, pointerId: 1, pointerType: 'touch', isPrimary: true })
  await page.getByRole('button', { name: 'Place on page' }).tap()
  await expect(page.locator('.modal')).toHaveCount(0)

  const doc = mupdf.Document.openDocument(await save(page), 'application/pdf').asPDF() as mupdf.PDFDocument
  const types = [0, 1].flatMap((i) => doc.loadPage(i).getAnnotations().map((a) => a.getType()))
  expect(types).toContain('Text')
  expect(types).toContain('Stamp')
  expect(Object.fromEntries(doc.loadPage(1).getWidgets().map((w) => [w.getName(), w.getValue()])).full_name).toBe('Ada Lovelace')

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ') + ' ' + n.failureSummary).join(', '))).toEqual([])
})
