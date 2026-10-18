import { expect, test, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const names = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google AI (Gemini)', xai: 'xAI (Grok)', ollama: 'Ollama', custom: 'Custom compatible provider' }
type Provider = keyof typeof names
const ids = Object.keys(names) as Provider[]
const card = (settings: Locator, id: Provider) => settings.getByRole('region', { name: names[id], exact: true })
async function open(page: Page) {
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  return settings
}
async function edit(settings: Locator, id: Provider) { await card(settings, id).getByRole('button', { name: /^(Edit|Set up)$/ }).click() }
async function setup(settings: Locator, id: Provider, key: string) {
  await edit(settings, id)
  if (id === 'custom') await settings.getByLabel('Endpoint', { exact: true }).fill('https://provider.example/v1')
  if (id === 'ollama') await settings.getByText('Authentication (optional)', { exact: true }).click()
  await settings.getByLabel('API key', { exact: true }).fill(key)
  await settings.getByRole('button', { name: 'Continue', exact: true }).click()
}
async function save(settings: Locator, model = 'gpt-test-model') {
  await expect(settings.getByRole('status')).toContainText('Connection checked. Models loaded.')
  await settings.getByLabel('Model', { exact: true }).fill(model)
  await settings.getByRole('button', { name: 'Save and enable AI', exact: true }).click()
}
async function mockModels(page: Page, data: { id: string }[] = [{ id: 'gpt-test-model' }]) {
  await page.route('**/models*', route => route.fulfill({ json: { data } }))
}
async function category(settings: Locator, name: string) {
  const back = settings.getByRole('button', { name: 'All settings', exact: true })
  if (await back.isVisible()) await back.click()
  await settings.getByRole('button', { name, exact: true }).click()
}

for (const width of [1000, 390]) for (const colorScheme of ['light', 'dark'] as const) test(`provider setup ${width} ${colorScheme}`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height: 1000 })
  const requests: { url: string; key?: string }[] = []
  await page.route('**/models*', async route => {
    requests.push({ url: route.request().url(), key: route.request().headers()['authorization'] ?? route.request().headers()['x-api-key'] })
    await route.fulfill({ json: { data: [{ id: 'gpt-test-model' }] } })
  })
  await page.goto('/'); const settings = await open(page)
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).not.toBeChecked()
  for (const id of ids) {
    await setup(settings, id, `test-${id}`)
    await expect(settings.getByRole('status')).toContainText('Connection checked. Models loaded.')
    await expect(settings.getByLabel('Enable AI when I finish', { exact: true })).toBeChecked()
    expect(requests.filter(r => r.key?.endsWith(`test-${id}`))).toHaveLength(1)
    await settings.getByRole('combobox', { name: 'Choose a listed model' }).selectOption('gpt-test-model')
    await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-test-model')
    await save(settings)
  }
  const hosts = ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.x.ai', 'localhost:11434', 'provider.example']
  ids.forEach((id, index) => expect(requests.filter(r => r.key?.endsWith(`test-${id}`)).map(r => new URL(r.url).host)).toEqual([hosts[index]]))
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).toBeChecked()
  await edit(settings, 'custom')
  await settings.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Connection checked. Models loaded.')
  await settings.getByLabel('Model', { exact: true }).fill('my-explicit-model')
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('my-explicit-model')
  await settings.getByRole('button', { name: 'Save and enable AI', exact: true }).click()
  await edit(settings, 'custom')
  await settings.getByLabel('Endpoint', { exact: true }).fill('https://another.example/v1')
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
  await settings.getByRole('button', { name: 'Cancel setup', exact: true }).click()
  await expect(card(settings, 'custom').getByRole('button', { name: 'Edit', exact: true })).toBeFocused()
  expect(requests.some(r => new URL(r.url).host === 'another.example')).toBe(false)
  await edit(settings, 'custom')
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('test-custom')
  await settings.getByRole('button', { name: 'Cancel setup', exact: true }).click()
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations).toEqual([])
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('provider-settings.png') })
  if (width === 390) {
    await settings.getByRole('button', { name: 'All settings' }).click()
    await expect(settings.getByRole('button', { name: 'AI & connections', exact: true })).toBeFocused()
    await expect(settings.getByRole('navigation', { name: 'Settings categories' })).toBeVisible()
  }
})

test('late or cancelled catalogue checks cannot change another provider draft', async ({ page }) => {
  let releaseFirst: (() => void) | undefined
  let mode: 'hold' | 'success' = 'hold'
  await page.route('**/models*', async route => {
    if (mode === 'hold') await new Promise<void>(resolve => { releaseFirst = resolve })
    await route.fulfill({ json: { data: [{ id: mode === 'hold' ? 'late-model' : 'gemini-model' }] } })
  })
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'openai', 'fake-key')
  await expect.poll(() => !!releaseFirst).toBe(true)
  await settings.getByRole('button', { name: 'Cancel setup' }).click()
  mode = 'success'
  await setup(settings, 'gemini', 'other-key')
  await expect(settings.getByRole('status')).toContainText('Connection checked. Models loaded.')
  releaseFirst!()
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gemini-model')
})

test('provider profiles survive reload encrypted; disconnect and purge forget credentials', async ({ page }) => {
  await mockModels(page)
  await page.goto('/'); let settings = await open(page)
  for (const id of ids) { await setup(settings, id, `secret-${id}`); await save(settings) }
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('openquire.settings') ?? '{}'; const value = JSON.parse(raw)
    return value.aiProvider === 'custom' && value.aiConnections?.startsWith('enc:v1:') && value.aiKey?.startsWith('enc:v1:') && !raw.includes('secret-')
  })).toBe(true)
  await page.reload(); settings = await open(page)
  for (const id of ids) { await edit(settings, id); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue(`secret-${id}`); await settings.getByRole('button', { name: 'Cancel setup' }).click() }
  await settings.getByText('Selected connection details', { exact: true }).click()
  await settings.getByRole('button', { name: 'Disconnect this provider' }).click()
  await expect(settings.getByRole('status')).toContainText('disconnected')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings') ?? '{}').aiKey)).toBe('')
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).not.toBeChecked()
  await page.reload(); settings = await open(page)
  await edit(settings, 'custom'); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue(''); await settings.getByRole('button', { name: 'Cancel setup' }).click()
  await edit(settings, 'gemini'); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('secret-gemini'); await settings.getByRole('button', { name: 'Cancel setup' }).click()
  await category(settings, 'Privacy & Security')
  page.on('dialog', dialog => dialog.accept())
  await settings.getByRole('button', { name: /Purge/ }).click()
  await expect.poll(() => page.evaluate(() => { const saved = JSON.parse(localStorage.getItem('openquire.settings') ?? '{}'); return !saved.aiKey && !saved.aiConnections && !saved.aiEnabled })).toBe(true)
  await category(settings, 'AI & connections')
  for (const id of ids) { await edit(settings, id); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue(''); await settings.getByRole('button', { name: 'Cancel setup' }).click() }
})

test('diagnostics cancel and safely explain errors without echoing credentials', async ({ page }) => {
  let mode = 'hold'; let release: (() => void) | undefined
  await page.route('**/models*', async route => { if (mode === 'hold') await new Promise<void>(resolve => { release = resolve }); await route.fulfill({ status: 429, json: { error: { message: 'secret-echoed-by-provider' } } }) })
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'xai', 'test-key')
  await expect.poll(() => !!release).toBe(true)
  await settings.getByRole('button', { name: 'Cancel connection check' }).click()
  await expect(settings.getByRole('status')).toContainText('cancelled')
  release!(); mode = 'denied'
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Request limit reached')
  await expect(settings).not.toContainText('secret-echoed-by-provider')
})

test('401 and 403 catalogue errors are redacted, retryable, and success prefills a sole model', async ({ page }) => {
  let status = 401
  await page.route('**/models*', route => status === 200
    ? route.fulfill({ json: { data: [{ id: 'gpt-verified-model' }] } })
    : route.fulfill({ status, json: { error: { message: 'private-provider-response' } } }))
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'openai', 'highly-sensitive-test-key')
  const authError = 'Access denied. Check this provider’s API key and account permissions.'
  await expect(settings.getByRole('status')).toContainText(authError)
  await expect(settings.getByRole('status')).not.toContainText('private-provider-response')
  await expect(settings.getByRole('status')).not.toContainText('highly-sensitive-test-key')
  await expect(settings.getByRole('button', { name: 'Save and enable AI', exact: true })).toBeDisabled()
  status = 403
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText(authError)
  await expect(settings.getByRole('status')).not.toContainText('private-provider-response')
  status = 200
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Connection checked. Models loaded.')
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-verified-model')
  await expect(settings.getByRole('button', { name: 'Save and enable AI', exact: true })).toBeEnabled()
})

test('Ollama checks without an API key, explains an empty catalogue, then refreshes and prefills one model', async ({ page }) => {
  let data: { id: string }[] = []
  const authorization: (string | undefined)[] = []
  await page.route('**/models*', route => {
    authorization.push(route.request().headers().authorization)
    return route.fulfill({ json: { data } })
  })
  await page.goto('/'); const settings = await open(page)
  await edit(settings, 'ollama')
  await settings.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Ollama is running, but no models are installed yet.')
  await settings.getByLabel('Model', { exact: true }).fill('not-installed')
  await expect(settings.getByRole('button', { name: 'Save and enable AI', exact: true })).toBeDisabled()
  await settings.getByLabel('Model', { exact: true }).fill('')
  expect(authorization[0]).toBeUndefined()
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('')
  await expect(settings.getByRole('button', { name: 'Save and enable AI', exact: true })).toBeDisabled()
  data = [{ id: 'llama3.2' }]
  await settings.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Connection checked. Models loaded.')
  expect(authorization[1]).toBeUndefined()
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('llama3.2')
  await settings.getByRole('button', { name: 'Save and enable AI', exact: true }).click()
  await expect(card(settings, 'ollama')).toContainText('llama3.2')
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).toBeChecked()
})

test('manual model entry is an explicit unverified fallback after a failed check', async ({ page }) => {
  await page.route('**/models*', route => route.fulfill({ status: 404, json: { error: { message: 'catalogue unavailable' } } }))
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'custom', 'optional-key')
  await expect(settings.getByRole('status')).toContainText('Model catalogue not found. Check the API endpoint, or enter a model ID manually.')
  await expect(settings.getByRole('button', { name: 'Save and enable AI', exact: true })).toBeDisabled()
  await settings.getByRole('button', { name: 'Enter model manually', exact: true }).click()
  await expect(settings.getByText('This connection has not been checked. Your first AI request may still fail.')).toBeVisible()
  await settings.getByLabel('Model', { exact: true }).fill('manual-only-model')
  await expect(settings.getByRole('button', { name: 'Save and enable AI', exact: true })).toBeEnabled()
  await settings.getByLabel('Enable AI when I finish', { exact: true }).uncheck()
  await settings.getByRole('button', { name: 'Save and select', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Custom compatible provider selected.')
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).not.toBeChecked()
})

test('unavailable encrypted storage keeps profiles session-only and reports it', async ({ page }) => {
  await mockModels(page)
  await page.goto('/'); await page.evaluate(() => { crypto.subtle.encrypt = async () => { throw new Error('encryption unavailable') } })
  const settings = await open(page)
  await setup(settings, 'anthropic', 'session-only-secret'); await save(settings)
  await expect(settings.getByRole('alert')).toContainText('kept only for this session')
  await setup(settings, 'gemini', 'another-secret'); await save(settings)
  await expect.poll(() => page.evaluate(() => { const raw = localStorage.getItem('openquire.settings') ?? '{}'; const saved = JSON.parse(raw); return saved.aiProvider === 'gemini' && !raw.includes('secret') && !saved.aiConnections && !saved.aiKey })).toBe(true)
  await edit(settings, 'anthropic'); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('session-only-secret')
})

test('purge from another tab invalidates even an unsaved first connection', async ({ page, context }) => {
  await mockModels(page)
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'openai', 'must-not-survive')
  const other = await context.newPage(); await other.goto('/')
  const privacy = await open(other); await category(privacy, 'Privacy & Security')
  other.on('dialog', dialog => dialog.accept()); await privacy.getByRole('button', { name: /Purge/ }).click()
  await expect(settings.getByRole('region', { name: 'Provider setup' })).toHaveCount(0)
  await edit(settings, 'openai'); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
})


test('short mobile Settings keeps category navigation reachable', async ({ page }, info) => {
  await mockModels(page)
  await page.setViewportSize({ width: 360, height: 540 })
  await page.goto('/')
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'About', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'About OpenQuire', exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'All settings' }).click()
  await expect(settings.getByRole('button', { name: 'About', exact: true })).toBeFocused()
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await setup(settings, 'openai', 'draft-only')
  await settings.getByLabel('Model', { exact: true }).fill('manual-model')
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations).toEqual([])
  // Scrolling the setup must never put its controls under the fixed Close button.
  const closeBox = await settings.getByRole('button', { name: 'Close', exact: true }).boundingBox()
  const contentBox = await settings.locator('.settings-content').boundingBox()
  expect(contentBox!.y).toBeGreaterThanOrEqual(closeBox!.y + closeBox!.height)
  await page.screenshot({ path: info.outputPath('provider-setup.png') })
  await settings.getByRole('button', { name: 'Cancel setup' }).click()
  expect(await page.evaluate(() => localStorage.getItem('openquire.settings')?.includes('draft-only') ?? false)).toBe(false)
})
