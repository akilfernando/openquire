import { test, expect } from '@playwright/test'
import { openReport } from './fixtures'

for (const width of [1440, 390]) test(`Settings traps both tab directions and restores focus at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 })
  await openReport(page)
  const opener = page.getByRole('button', { name: 'Settings', exact: true })
  await opener.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < 35; i++) {
    await page.keyboard.press(key)
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('dock arrow keys, Home and End reach tools without leaving the toolbar', async ({ page }) => {
  await openReport(page)
  const first = page.getByRole('button', { name: 'Select', exact: true })
  await first.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  expect(await page.evaluate(() => document.activeElement?.closest('.dock') !== null)).toBe(true)
  await page.keyboard.press('Home')
  await expect(first).toBeFocused()
})
