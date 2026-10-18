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
  await settings.getByLabel('API key', { exact: true }).fill(key)
  await settings.getByRole('button', { name: 'Continue', exact: true }).click()
}
async function save(settings: Locator, model = 'gpt-test-model') {
  await settings.getByLabel('Model', { exact: true }).fill(model)
  await settings.getByRole('button', { name: 'Save and select', exact: true }).click()
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
    expect(requests.filter(r => r.key?.endsWith(`test-${id}`))).toHaveLength(0)
    await settings.getByRole('button', { name: 'Load models', exact: true }).click()
    await expect(settings.getByRole('status')).toContainText('Models loaded')
    await settings.getByRole('combobox', { name: 'Choose a listed model' }).selectOption('gpt-test-model')
    await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-test-model')
    await save(settings)
  }
  const hosts = ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.x.ai', 'localhost:11434', 'provider.example']
  ids.forEach((id, index) => expect(requests.filter(r => r.key?.endsWith(`test-${id}`)).map(r => new URL(r.url).host)).toEqual([hosts[index]]))
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).not.toBeChecked()
  await edit(settings, 'custom')
  await settings.getByRole('button', { name: 'Continue', exact: true }).click()
  await settings.getByLabel('Model', { exact: true }).fill('my-explicit-model')
  await settings.getByRole('button', { name: 'Load models', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Models loaded')
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('my-explicit-model')
  await settings.getByRole('button', { name: 'Save and select', exact: true }).click()
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
  let release: (() => void) | undefined
  await page.route('**/models*', async route => { await new Promise<void>(resolve => { release = resolve }); await route.fulfill({ json: { data: [{ id: 'late-model' }] } }) })
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'openai', 'fake-key')
  await settings.getByRole('button', { name: 'Load models' }).click()
  await expect.poll(() => !!release).toBe(true)
  await settings.getByRole('button', { name: 'Cancel setup' }).click()
  await setup(settings, 'gemini', 'other-key')
  release!()
  await expect(settings.getByRole('status')).toHaveCount(0)
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('')
})

test('provider profiles survive reload encrypted; disconnect and purge forget credentials', async ({ page }) => {
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
  await settings.getByRole('button', { name: 'Load models' }).click(); await expect.poll(() => !!release).toBe(true)
  await settings.getByRole('button', { name: 'Cancel connection check' }).click()
  await expect(settings.getByRole('status')).toContainText('cancelled')
  release!(); mode = 'denied'
  await settings.getByRole('button', { name: 'Load models' }).click()
  await expect(settings.getByRole('status')).toContainText('Request limit reached')
  await expect(settings).not.toContainText('secret-echoed-by-provider')
})

test('unavailable encrypted storage keeps profiles session-only and reports it', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => { crypto.subtle.encrypt = async () => { throw new Error('encryption unavailable') } })
  const settings = await open(page)
  await setup(settings, 'anthropic', 'session-only-secret'); await save(settings)
  await expect(settings.getByRole('alert')).toContainText('kept only for this session')
  await setup(settings, 'gemini', 'another-secret'); await save(settings)
  await expect.poll(() => page.evaluate(() => { const raw = localStorage.getItem('openquire.settings') ?? '{}'; const saved = JSON.parse(raw); return saved.aiProvider === 'gemini' && !raw.includes('secret') && !saved.aiConnections && !saved.aiKey })).toBe(true)
  await edit(settings, 'anthropic'); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('session-only-secret')
})

test('purge from another tab invalidates even an unsaved first connection', async ({ page, context }) => {
  await page.goto('/'); const settings = await open(page)
  await setup(settings, 'openai', 'must-not-survive')
  const other = await context.newPage(); await other.goto('/')
  const privacy = await open(other); await category(privacy, 'Privacy & Security')
  other.on('dialog', dialog => dialog.accept()); await privacy.getByRole('button', { name: /Purge/ }).click()
  await expect(settings.getByRole('region', { name: 'Provider setup' })).toHaveCount(0)
  await edit(settings, 'openai'); await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
})


test('short mobile Settings keeps category navigation reachable', async ({ page }, info) => {
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
  await page.screenshot({ path: info.outputPath('provider-setup.png') })
  await settings.getByRole('button', { name: 'Cancel setup' }).click()
  expect(await page.evaluate(() => localStorage.getItem('openquire.settings')?.includes('draft-only') ?? false)).toBe(false)
})
