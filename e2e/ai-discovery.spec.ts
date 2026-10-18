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

interface ClaudeMockOptions {
  folder?: string | null
  failLink?: boolean
  holdLink?: boolean
  failSetupLink?: boolean
}

async function mockDesktopDetection(page: Page, hold = false, claude: ClaudeMockOptions = {}) {
  await page.addInitScript(({ hold, claude }) => {
    const state = {
      calls: [] as string[], invoked: [] as { command: string; args?: any }[], hold, completed: 0,
      release: null as (() => void) | null,
      folder: claude.folder === undefined ? 'C:\\Users\\Akil\\Documents\\PDFs' : claude.folder,
      failLink: claude.failLink ?? false,
      holdLink: claude.holdLink ?? false,
      failSetupLink: claude.failSetupLink ?? false,
      pickerCalls: 0, linkCalls: 0, linkRelease: null as (() => void) | null,
    }
    Object.defineProperty(window, '__aiDiscoveryNativeMock', { configurable: true, value: state })
    let callbackId = 0
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++callbackId,
        unregisterCallback: () => undefined,
        async invoke(command: string, args?: any) {
          state.calls.push(command)
          state.invoked.push({ command, args })
          if (command === 'plugin:event|listen') return ++callbackId
          if (command === 'plugin:event|unlisten' || command === 'take_opened_files') return null
          if (command === 'native_tools') return { libreoffice: null, tesseract: null, tesseract_langs: [] }
          if (command === 'plugin:dialog|open') { state.pickerCalls++; return state.folder }
          if (command === 'open_setup_link' && state.failSetupLink) throw new Error('Injected browser open failure')
          if (command === 'link_claude_desktop' || command === 'link_codex' || command === 'link_chatgpt_desktop') {
            state.linkCalls++
            if (state.holdLink) await new Promise<void>(resolve => { state.linkRelease = resolve })
            if (state.failLink) throw new Error('Injected assistant configuration write failure')
            return 'Setup saved'
          }
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
  }, { hold, claude })
}

async function openClaudeConnection(page: Page, claude: ClaudeMockOptions = {}) {
  await mockDesktopDetection(page, false, claude)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  const findings = dialog.getByRole('region', { name: 'Desktop findings' })
  const claudeItem = findings.locator('details').filter({ has: page.getByText('Claude Desktop', { exact: true }) })
  await expect(claudeItem).toBeVisible()
  await claudeItem.locator(':scope > summary').click()
  return { dialog, claudeItem }
}

async function openCodexConnection(page: Page, codex: ClaudeMockOptions = {}) {
  await mockDesktopDetection(page, false, codex)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  const findings = dialog.getByRole('region', { name: 'Desktop findings' })
  const codexItem = findings.locator('details').filter({ has: page.getByText('Codex CLI', { exact: true }) })
  await expect(codexItem).toBeVisible()
  await codexItem.locator(':scope > summary').click()
  return { dialog, codexItem }
}

async function openChatGPTConnection(page: Page, chatgpt: ClaudeMockOptions = {}) {
  await mockDesktopDetection(page, false, chatgpt)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  const findings = dialog.getByRole('region', { name: 'Desktop findings' })
  const chatgptItem = findings.locator('details').filter({ has: page.getByText('ChatGPT Desktop', { exact: true }) })
  await expect(chatgptItem).toBeVisible()
  await chatgptItem.locator(':scope > summary').click()
  return { dialog, chatgptItem }
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
  for (const name of ['Claude Code']) {
    const item = findings.locator('details').filter({ has: page.getByText(name, { exact: true }) })
    await item.locator('summary').click()
    await expect(item).not.toContainText(/configuration found|connected|linked/i)
    await expect(item.getByRole('button')).toHaveCount(0)
  }
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)).not.toContain('link_claude_desktop')
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)).not.toContain('link_codex')
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)).not.toContain('plugin:dialog|open')
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

test('immediate discovery results remain in the searching state for 900 ms', async ({ page }) => {
  await page.clock.pauseAt(new Date('2025-01-01T00:00:00Z'))
  await mockDesktopDetection(page)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [{ id: 'qwen-local' }] } }))
  const dialog = await openDiscovery(page)
  const catalogueResponse = page.waitForResponse(CATALOGUE)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Looking around…' })).toBeVisible()
  await catalogueResponse
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.completed)).toBe(1)
  await page.clock.runFor(899)
  await expect(dialog.getByRole('region', { name: 'Local models' })).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: 'Desktop findings' })).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(dialog.getByRole('region', { name: 'Local models' })).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Desktop findings' })).toBeVisible()
})

test('stopping during the minimum search delay discards already returned results', async ({ page }) => {
  await page.clock.pauseAt(new Date('2025-01-01T00:00:00Z'))
  await mockDesktopDetection(page)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [{ id: 'early-model' }] } }))
  const dialog = await openDiscovery(page)
  const catalogueResponse = page.waitForResponse(CATALOGUE)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Looking around…' })).toBeVisible()
  await catalogueResponse
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.completed)).toBe(1)
  await page.clock.runFor(400)
  await dialog.getByRole('button', { name: 'Stop search', exact: true }).click()
  await page.clock.runFor(500)
  await expect(dialog.getByText('Search stopped.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Local models' })).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: 'Desktop findings' })).toHaveCount(0)
  await expect(dialog.getByText('early-model')).toHaveCount(0)
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

test('Claude setup stays opt-in and manual instructions expose the pinned package only on demand', async ({ page }) => {
  await mockDesktopDetection(page)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  const calls = await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)
  expect(calls).not.toContain('plugin:dialog|open')
  expect(calls).not.toContain('link_claude_desktop')
  const findings = dialog.getByRole('region', { name: 'Desktop findings' })
  const item = findings.locator('details').filter({ has: page.getByText('Claude Desktop', { exact: true }) })
  await item.locator(':scope > summary').click()
  const manual = item.locator('details').filter({ has: page.getByText('Manual setup', { exact: true }) })
  await expect(manual).toBeVisible()
  const command = manual.locator('code')
  await expect(command).toBeHidden()
  await manual.locator(':scope > summary').click()
  await expect(command).toContainText('https://github.com/akilfernando/openquire/releases/download/desktop-v0.2.0-rc.1/openquire-1.0.3.tgz')
})

test('Claude Node.js setup link uses the desktop browser command and shows a manual fallback on failure', async ({ page }) => {
  const { claudeItem } = await openClaudeConnection(page, { failSetupLink: true })
  const connectionDetails = claudeItem.locator('details').filter({ has: page.getByText('What this connection does', { exact: true }) })
  await connectionDetails.locator(':scope > summary').click()
  await connectionDetails.getByRole('link', { name: 'Get Node.js', exact: true }).click()
  await expect(connectionDetails.getByRole('alert')).toHaveText('Could not open your browser. Open this address manually: https://nodejs.org/en/download')
  const state = await page.evaluate(() => (window as any).__aiDiscoveryNativeMock)
  const openLink = state.invoked.find((call: any) => call.command === 'open_setup_link')
  expect(openLink?.args).toEqual({ url: 'https://nodejs.org/en/download' })
  expect(state.calls).not.toContain('link_claude_desktop')
  expect(state.calls).not.toContain('plugin:dialog|open')
})

test('Connect Claude Desktop picks a folder and writes only that exact allowed path', async ({ page }) => {
  const chosen = 'C:\\Users\\Akil\\Documents\\Research PDFs'
  const { claudeItem } = await openClaudeConnection(page, { folder: chosen })
  await claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true }).click()
  await expect(claudeItem.getByRole('status')).toContainText('Setup saved. Finish in Claude Desktop.')
  const invoked = await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.invoked)
  const picker = invoked.find((call: any) => call.command === 'plugin:dialog|open')
  const link = invoked.find((call: any) => call.command === 'link_claude_desktop')
  expect(picker?.args).toMatchObject({ options: { directory: true, multiple: false } })
  expect(link?.args).toEqual({ allowedDir: chosen })
  await expect(claudeItem.getByText(/connected/i)).toHaveCount(0)
})

test('canceling Claude folder selection writes nothing and leaves setup retry available', async ({ page }) => {
  const { claudeItem } = await openClaudeConnection(page, { folder: null })
  await claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.pickerCalls)).toBe(1)
  await expect(claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(0)
  await claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.pickerCalls)).toBe(2)
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(0)
})

test('Claude native write errors stay visible and allow a retry', async ({ page }) => {
  const { claudeItem } = await openClaudeConnection(page, { failLink: true })
  await claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true }).click()
  await expect(claudeItem.getByRole('alert')).toHaveText('Injected assistant configuration write failure')
  await expect(claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true })).toBeEnabled()
  await claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(2)
  await expect(claudeItem.getByRole('alert')).toBeVisible()
})

test('Claude setup disables search, provider setup, and closing while native linking is pending', async ({ page }) => {
  const { dialog, claudeItem } = await openClaudeConnection(page, { holdLink: true })
  await claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(1)
  await expect(dialog.getByRole('button', { name: 'Search again', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Set up a provider', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0)
  await expect(claudeItem.getByRole('button', { name: 'Setting up…', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Search again', exact: true })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkRelease())
  await expect(claudeItem.getByRole('status')).toContainText('Setup saved. Finish in Claude Desktop.')
})

test('Codex setup is opt-in and exposes its pinned manual command only on demand', async ({ page }) => {
  await mockDesktopDetection(page)
  await page.route(CATALOGUE, route => route.fulfill({ json: { data: [] } }))
  const dialog = await openDiscovery(page)
  await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
  const calls = await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.calls)
  expect(calls).not.toContain('plugin:dialog|open')
  expect(calls).not.toContain('link_codex')
  const findings = dialog.getByRole('region', { name: 'Desktop findings' })
  const item = findings.locator('details').filter({ has: page.getByText('Codex CLI', { exact: true }) })
  await item.locator(':scope > summary').click()
  await expect(item.getByRole('button', { name: 'Connect Codex', exact: true })).toBeVisible()
  const manual = item.locator('details').filter({ has: page.getByText('Manual setup', { exact: true }) })
  const command = manual.locator('code')
  await expect(command).toBeHidden()
  await manual.locator(':scope > summary').click()
  await expect(command).toContainText('codex mcp add openquire -- npx -y')
  await expect(command).toContainText('<absolute path to your PDF folder>')
  await expect(command).toContainText('https://github.com/akilfernando/openquire/releases/download/desktop-v0.2.0-rc.1/openquire-1.0.3.tgz')
})

test('Codex folder cancellation writes nothing and leaves the setup button available to retry', async ({ page }) => {
  const { codexItem } = await openCodexConnection(page, { folder: null })
  await codexItem.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.pickerCalls)).toBe(1)
  await expect(codexItem.getByRole('button', { name: 'Connect Codex', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(0)
  await codexItem.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.pickerCalls)).toBe(2)
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(0)
})

test('Codex native write errors remain visible and can be retried', async ({ page }) => {
  const { codexItem } = await openCodexConnection(page, { failLink: true })
  await codexItem.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  await expect(codexItem.getByRole('alert')).toHaveText('Injected assistant configuration write failure')
  await expect(codexItem.getByRole('button', { name: 'Connect Codex', exact: true })).toBeEnabled()
  await codexItem.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(2)
  await expect(codexItem.getByRole('alert')).toBeVisible()
})

test('ChatGPT Desktop chooses a folder, saves its exact path, and shows Settings MCP next steps', async ({ page }) => {
  const chosen = 'C:\\Users\\Akil\\Documents\\Research PDFs'
  const { chatgptItem } = await openChatGPTConnection(page, { folder: chosen })
  await chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true }).click()
  await expect(chatgptItem.getByRole('status')).toContainText('Setup saved. Finish in ChatGPT Desktop.')
  await expect(chatgptItem).toContainText('Settings → MCP servers')
  await expect(chatgptItem).toContainText('In a local chat, use /mcp')
  await expect(chatgptItem).toContainText('Restart ChatGPT Desktop')
  const invoked = await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.invoked)
  const picker = invoked.find((call: any) => call.command === 'plugin:dialog|open')
  const link = invoked.find((call: any) => call.command === 'link_chatgpt_desktop')
  expect(picker?.args).toMatchObject({ options: { directory: true, multiple: false, title: 'Choose a folder ChatGPT Desktop can use for PDFs' } })
  expect(link?.args).toEqual({ allowedDir: chosen })
  expect(invoked.filter((call: any) => call.command === 'link_chatgpt_desktop')).toHaveLength(1)
})

test('canceling ChatGPT folder selection writes nothing and leaves setup available to retry', async ({ page }) => {
  const { chatgptItem } = await openChatGPTConnection(page, { folder: null })
  await chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.pickerCalls)).toBe(1)
  await expect(chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(0)
  await chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.pickerCalls)).toBe(2)
  expect(await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(0)
})

test('ChatGPT native write errors stay visible and setup can be retried', async ({ page }) => {
  const { chatgptItem } = await openChatGPTConnection(page, { failLink: true })
  await chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true }).click()
  await expect(chatgptItem.getByRole('alert')).toHaveText('Injected assistant configuration write failure')
  await expect(chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true })).toBeEnabled()
  await chatgptItem.getByRole('button', { name: 'Connect ChatGPT Desktop', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(2)
  await expect(chatgptItem.getByRole('alert')).toBeVisible()
})

test('Connect Codex picks a PDF folder, saves its exact path, and asks for restart', async ({ page }) => {
  const chosen = 'C:\\Users\\Akil\\Documents\\Research PDFs'
  const { codexItem } = await openCodexConnection(page, { folder: chosen })
  await codexItem.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  await expect(codexItem.getByRole('status')).toContainText('Setup saved. Finish in Codex.')
  const invoked = await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.invoked)
  const picker = invoked.find((call: any) => call.command === 'plugin:dialog|open')
  const link = invoked.find((call: any) => call.command === 'link_codex')
  expect(picker?.args).toMatchObject({ options: { directory: true, multiple: false, title: 'Choose a folder Codex can use for PDFs' } })
  expect(link?.args).toEqual({ allowedDir: chosen })
  await expect(codexItem.getByText(/connected/i)).toHaveCount(0)
})

test('a pending Codex link disables Claude setup, search, and provider setup', async ({ page }) => {
  const { dialog, codexItem } = await openCodexConnection(page, { holdLink: true })
  const claudeItem = dialog.getByRole('region', { name: 'Desktop findings' }).locator('details').filter({ has: page.getByText('Claude Desktop', { exact: true }) })
  await claudeItem.locator(':scope > summary').click()
  await codexItem.getByRole('button', { name: 'Connect Codex', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkCalls)).toBe(1)
  await expect(claudeItem.getByRole('button', { name: 'Connect Claude Desktop', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Search again', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Set up a provider', exact: true })).toBeDisabled()
  await page.evaluate(() => (window as any).__aiDiscoveryNativeMock.linkRelease())
  await expect(codexItem.getByRole('status')).toContainText('Setup saved. Finish in Codex.')
})

for (const theme of ['light', 'dark'] as const) {
  test(`connection discovery stays accessible at mobile width in ${theme} theme with reduced motion`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('openquire.settings', JSON.stringify({ theme })), theme)
    if (theme === 'light') await mockDesktopDetection(page)
    await page.route(CATALOGUE, () => new Promise(() => {}))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const dialog = await openDiscovery(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Find connections', exact: true }).click()
    await expect(dialog.locator('.discovery-orbit span').first()).toHaveCSS('animation-name', 'none')
    await expect(dialog.locator('.discovery-spinner').first()).toHaveCSS('animation-name', 'none')
    if (theme === 'light') {
      const findings = dialog.getByRole('region', { name: 'Desktop findings' })
      await expect(findings).toBeVisible()
      for (const name of ['Claude Desktop', 'Codex CLI', 'ChatGPT Desktop']) {
        const item = findings.locator('details').filter({ has: page.getByText(name, { exact: true }) })
        await item.locator(':scope > summary').click()
        const manual = item.locator('details').filter({ has: page.getByText('Manual setup', { exact: true }) })
        await manual.locator(':scope > summary').click()
      }
    }
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const axe = await new AxeBuilder({ page }).include('.discovery-modal').withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(axe.violations).toEqual([])
    await page.screenshot({ path: info.outputPath('discovery.png') })
  })
}
