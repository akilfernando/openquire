import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { PRIVACY_REVISION_KEY } from '../src/privacy'

const CATALOGUE = 'http://localhost:11434/v1/models'

async function openDiscovery(page: Page) {
  await page.goto('/')
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await settings.getByRole('button', { name: 'Find connections', exact: true }).click()
  return page.getByRole('dialog', { name: 'Find your AI connections' })
}

async function mockDesktopDetection(page: Page, hold = false) {
  await page.addInitScript(({ hold }) => {
    const state = { calls: [] as string[], hold, completed: 0, release: null as (() => void) | null }
    Object.defineProperty(window, '__aiDiscoveryNativeMock', { configurable: true, value: state })
    let callbackId = 0
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++callbackId,
        unregisterCallback: () => undefined,
        async invoke(command: string) {
          state.calls.push(command)
          if (command === 'plugin:event|listen') return ++callbackId
          if (command === 'plugin:event|unlisten' || command === 'take_opened_files') return null
          if (command === 'native_tools') return { libreoffice: null, tesseract: null, tesseract_langs: [] }
          if (command === 'detect_ai_assistants') {
            if (state.hold) await new Promise<void>(resolve => { state.release = resolve })
            state.completed++
            return {
              claude_desktop: { name: 'Claude Desktop', installed: true, linked: false },
              chatgpt_desktop: { name: 'ChatGPT Desktop', installed: true, linked: false },
              cursor: { name: 'Cursor', installed: true, linked: false },
              codex_cli: { name: 'Codex CLI', installed: true, linked: false },
              claude_code: { name: 'Claude Code', installed: true, linked: false },
            }
          }
          return null
        },
      },
    })
  }, { hold })
}

test('discovery waits for explicit consent, then shows local and desktop findings as they arrive', async ({ page }) => {
  await mockDesktopDetection(page, true)
  let catalogueCalls = 0
  let releaseCatalogue!: () => Promise<void>
  await page.route(CATALOGUE, route => { catalogueCalls++; return new Promise<void>(resolve => { releaseCatalogue = async () => { await route.fulfill({ json: { data: [{ id: 'qwen-local' }] } }); resolve() } }) })
  await openDiscovery(page)
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)).not.toContain('detect_ai_assistants')
  expect(catalogueCalls).toBe(0)

  const dialog = page.getByRole('dialog', { name: 'Find your AI connections' })
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls.includes('detect_ai_assistants'))).toBe(true)
  await expect.poll(() => !!releaseCatalogue).toBe(true)
  expect(catalogueCalls).toBe(1)
  await releaseCatalogue()
  await expect(dialog.getByRole('region', { name: 'Local models' })).toContainText('1 model listed')
  await expect(dialog.getByRole('region', { name: 'Desktop findings' })).toHaveCount(0)

  await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.release())
  const findings = dialog.getByRole('region', { name: 'Desktop findings' })
  await expect(findings).toBeVisible()
  for (const name of ['Codex CLI', 'Claude Code']) {
    const item = findings.locator('details').filter({ has: page.getByText(name, { exact: true }) })
    await item.locator('summary').click()
    await expect(item).not.toContainText(/configuration found|connected|linked/i)
    await expect(item.getByRole('button')).toHaveCount(0)
  }
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)).not.toContain('link_claude_desktop')
})

test('stopping a pending search ignores late local catalogue results', async ({ page }) => {
  let fulfill!: () => Promise<void>
  await page.route(CATALOGUE, route => new Promise<void>(resolve => { fulfill = async () => { await route.fulfill({ json: { data: [{ id: 'late-model' }] } }); resolve() } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect.poll(() => !!fulfill).toBe(true)
  await dialog.getByRole('button', { name: 'Stop search', exact: true }).click()
  await fulfill()
  await expect(dialog.getByText('Search stopped.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Local models' })).toHaveCount(0)
  await expect(dialog.getByText('late-model')).toHaveCount(0)
})

test('manual provider setup opens AI settings without enabling or saving a draft', async ({ page }) => {
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Set up a provider', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'AI & connections', exact: true })).toBeVisible()
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).not.toBeChecked()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings') ?? '{}'))
  expect(saved.aiEnabled ?? false).toBe(false)
  expect(saved.aiConnections ?? '').toBe('')
  expect(saved.aiKey ?? '').toBe('')
})

test('reviewing a local model opens a populated manual setup and cancel leaves settings unchanged', async ({ page }) => {
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [{ id: 'qwen-local' }, { id: 'llama-local' }] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect(dialog.getByRole('region', { name: 'Local models' })).toBeVisible()
  const before = await page.evaluate(() => localStorage.getItem('openquire.settings'))
  await dialog.getByRole('button', { name: 'Review local setup', exact: true }).click()
  const setup = page.getByRole('region', { name: 'Provider setup' })
  await expect(setup).toBeVisible()
  await expect(setup).toContainText('STEP 2 OF 2')
  await expect(setup.getByLabel('Model', { exact: true })).toHaveValue('')
  await setup.getByLabel('Choose a listed model').selectOption('qwen-local')
  await expect(setup.getByLabel('Model', { exact: true })).toHaveValue('qwen-local')
  await setup.getByRole('button', { name: 'Cancel setup', exact: true }).click()
  await expect(setup).toHaveCount(0)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await expect(setup).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('openquire.settings'))).toBe(before)
  await expect(page.getByRole('checkbox', { name: 'Enable the AI assistant', exact: true })).not.toBeChecked()
})

test('unreachable local service produces a friendly empty state', async ({ page }) => {
  await page.route(CATALOGUE, route => route.abort())
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect(dialog.getByText(/No connections found here\. Set up a provider to get started\./)).toBeVisible()
  await expect(dialog.getByText(/TypeError|Failed to fetch|ERR_CONNECTION/i)).toHaveCount(0)
})

test('a pending search finishes on its own and keeps manual setup available', async ({ page }) => {
  await page.route(CATALOGUE, () => new Promise(() => {}))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Set up a provider', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Search again', exact: true })).toBeVisible()
  await expect(dialog.locator('.discovery-spinner')).toHaveCount(0)
  await expect(dialog.getByText('No connections found here. Set up a provider to get started.')).toBeVisible()
})

test('closing during native detection discards its late result after reopening', async ({ page }) => {
  await mockDesktopDetection(page, true)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls.includes('detect_ai_assistants'))).toBe(true)
  await expect(dialog.getByRole('region', { name: 'Local models' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const settingsButton = page.locator('button[aria-label="Settings"]:visible').first()
  await settingsButton.click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await settings.getByRole('button', { name: 'Find connections', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: 'Find your AI connections' })
  await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.release())
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.completed)).toBe(1)
  await expect(reopened.getByRole('region', { name: 'Desktop findings' })).toHaveCount(0)
  await expect(reopened.getByRole('button', { name: 'Find connections', exact: true })).toBeVisible()
})

test('a privacy revision closes discovery and prevents a pending result appearing on reopen', async ({ page }) => {
  let fulfill!: () => Promise<void>
  await page.route(CATALOGUE, route => new Promise<void>(resolve => { fulfill = async () => { await route.fulfill({ json: { data: [{ id: 'private-late-model' }] } }); resolve() } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect.poll(() => !!fulfill).toBe(true)
  await page.evaluate(key => {
    localStorage.setItem(key, 'changed-in-another-tab')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'changed-in-another-tab' }))
  }, PRIVACY_REVISION_KEY)
  await expect(dialog).toHaveCount(0)

  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await settings.getByRole('button', { name: 'Find connections', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: 'Find your AI connections' })
  await fulfill()
  await expect(reopened.getByRole('region', { name: 'Local models' })).toHaveCount(0)
  await expect(reopened.getByText('private-late-model')).toHaveCount(0)
  await expect(reopened.getByRole('button', { name: 'Find connections', exact: true })).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test(`connection discovery stays accessible at mobile width in ${theme} theme with reduced motion`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('openquire.settings', JSON.stringify({ theme })), theme)
    await page.route(CATALOGUE, () => new Promise(() => {}))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const dialog = await openDiscovery(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
    await expect(dialog.locator('.discovery-orbit span').first()).toHaveCSS('animation-name', 'none')
    await expect(dialog.locator('.discovery-spinner').first()).toHaveCSS('animation-name', 'none')
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const axe = await new AxeBuilder({ page }).include('.discovery-modal').withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(axe.violations).toEqual([])
    await page.screenshot({ path: info.outputPath('discovery.png') })
    await dialog.getByRole('button', { name: 'Stop search' }).click()
  })
}
