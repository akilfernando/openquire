import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { openReport } from './fixtures'

// Unlike workspace tests, exercise setup with no previously saved preferences.
test.use({ storageState: { cookies: [], origins: [] } })

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`first-run setup at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('finishes setup and keeps the workspace usable after reloading', async ({ page }) => {
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: 'Welcome to OpenQuire' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('checkbox', { name: 'Disable All AI Features' })).not.toBeChecked()
      const axe = await new AxeBuilder({ page }).include('.onboarding-modal').withTags(['wcag2a', 'wcag2aa']).analyze()
      expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])

      await dialog.getByRole('button', { name: 'Get Started with OpenQuire' }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => localStorage.getItem('openquire.onboarded'))).toBe('true')
      await openReport(page)
      await expect(dialog).toHaveCount(0)
      await page.locator('button[aria-label="Settings"]:visible').first().click()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    })

    test('remembers the choice to disable AI', async ({ page }) => {
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: 'Welcome to OpenQuire' })
      await dialog.getByRole('checkbox', { name: 'Disable All AI Features' }).check()
      await expect(dialog.getByText('AI & Assistant Integrations', { exact: true })).toHaveCount(0)
      await dialog.getByRole('button', { name: 'Get Started with OpenQuire' }).click()
      await page.reload()
      await expect(page.locator('.app')).toBeVisible()
      await expect(dialog).toHaveCount(0)
      const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings') ?? '{}'))
      expect(settings.aiDisabled).toBe(true)
      expect(settings.aiEnabled).toBe(false)
    })
  })
}
