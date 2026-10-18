import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { reportPdf } from './fixtures'

test.use({ storageState: { cookies: [], origins: [] } })

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 360, height: 540 }]) {
    test(`welcome ${theme} ${viewport.width}px: accessible, concise and dismissible`, async ({ page }, info) => {
      await page.setViewportSize(viewport)
      await page.addInitScript(theme => {
        localStorage.setItem('openquire.settings', JSON.stringify({ theme }))
      }, theme)
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: 'Welcome to OpenQuire' })
      await expect(dialog).toBeVisible()
      // Entry text must be fully readable immediately, including during axe capture.
      await expect(dialog).toHaveCSS('animation-name', 'none')
      await expect(dialog).toHaveCSS('opacity', '1')
      await expect(dialog.getByRole('button', { name: 'Open a PDF', exact: true })).toBeVisible()
      await expect(dialog.getByRole('checkbox')).toHaveCount(0)
      await expect(dialog.getByText(/MCP|Claude|API|air-gapped/)).toHaveCount(0)
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      const axe = await new AxeBuilder({ page }).include('.welcome-modal').withTags(['wcag2a', 'wcag2aa']).analyze()
      expect(axe.violations).toEqual([])
      await page.screenshot({ path: info.outputPath('welcome.png') })
      await dialog.getByRole('button', { name: 'Explore tools', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Find the right tool' })).toBeVisible()
      await page.reload()
      await expect(page.locator('.home')).toBeVisible()
      await expect(dialog).toHaveCount(0)
    })
  }
}

test('opening from welcome imports a PDF without enabling AI', async ({ page }) => {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open a PDF', exact: true }).click()
  await (await chooser).setFiles({ name: 'welcome-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await reportPdf()) })
  await expect(page.locator('.page').first()).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Welcome to OpenQuire' })).toHaveCount(0)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings') ?? '{}'))
  expect(saved.aiEnabled ?? false).toBe(false)
})

test('optional AI opens the AI category without enabling requests', async ({ page }) => {
  const external: string[] = []
  page.on('request', req => { if (!new URL(req.url()).hostname.match(/^(localhost|127\.0\.0\.1)$/)) external.push(req.url()) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Explore optional AI' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'AI & connections', exact: true })).toBeVisible()
  await expect(settings.getByRole('checkbox', { name: 'Enable the AI assistant', exact: true })).not.toBeChecked()
  expect(external).toEqual([])
})

test('welcome preserves disabled AI and Escape persists dismissal', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('openquire.settings')) localStorage.setItem('openquire.settings', JSON.stringify({ aiDisabled: true, aiEnabled: false }))
  })
  await page.goto('/')
  const welcome = page.getByRole('dialog', { name: 'Welcome to OpenQuire' })
  await expect(welcome).toBeVisible()
  await expect(welcome.getByRole('button', { name: 'Explore optional AI' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(welcome).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.home')).toBeVisible()
  await expect(welcome).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings')!).aiDisabled)).toBe(true)
})

test('existing onboarded users go straight to Home', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('openquire.onboarded', 'true'))
  await page.goto('/')
  await expect(page.locator('.home')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Welcome to OpenQuire' })).toHaveCount(0)
})

test('keyboard focus stays inside welcome and cancelled picker leaves Home usable', async ({ page }) => {
  await page.goto('/')
  const dialog = page.getByRole('dialog', { name: 'Welcome to OpenQuire' })
  await expect(dialog.getByRole('button', { name: 'Open a PDF', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Explore optional AI' }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Explore optional AI' })).toBeFocused()
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Open a PDF', exact: true }).click()
  await (await chooser).setFiles([])
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Create a blank PDF', exact: true }).click()
  await expect(page.locator('.page').first()).toBeVisible()
})

test('revisiting welcome keeps the document and opens its tools', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Explore tools', exact: true }).click()
  await page.getByRole('button', { name: 'Create a blank PDF', exact: true }).click()
  await expect(page.locator('.page').first()).toBeVisible()
  const tools = page.locator('#document-tools')
  if (await tools.isVisible()) await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Open command palette', exact: true }).click()
  await page.getByPlaceholder('Type a command...').fill('Show welcome')
  await page.getByPlaceholder('Type a command...').press('Enter')
  const welcome = page.getByRole('dialog', { name: 'Welcome to OpenQuire' })
  await expect(welcome).toBeVisible()
  await welcome.getByRole('button', { name: 'Explore tools', exact: true }).click()
  await expect(tools).toBeVisible()
  await expect(page.locator('.page').first()).toBeVisible()
  await expect(page.locator('.tab').filter({ hasText: 'untitled' }).getByLabel('Unsaved changes')).toBeVisible()
})
