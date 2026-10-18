import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

for (const width of [1000, 390]) for (const colorScheme of ['light', 'dark'] as const) test(`provider setup ${width} ${colorScheme}`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme })
  await page.setViewportSize({ width, height: 1000 })
  const requests: { url: string; key: string | undefined }[] = []
  await page.route('**/models*', async route => {
    const request = route.request()
    requests.push({ url: request.url(), key: request.headers()['authorization'] ?? request.headers()['x-api-key'] })
    await route.fulfill({ json: { data: [{ id: 'gpt-test-model' }] } })
  })
  await page.goto('/')
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI assistant', exact: true }).click()
  await settings.getByLabel('Enable the AI assistant', { exact: true }).check()
  const provider = settings.getByLabel('Provider', { exact: true })
  const key = settings.getByLabel('API key', { exact: true })
  for (const [id, host] of [['openai', 'api.openai.com'], ['anthropic', 'api.anthropic.com'], ['gemini', 'generativelanguage.googleapis.com'], ['xai', 'api.x.ai'], ['ollama', 'localhost:11434'], ['custom', 'provider.example']]) {
    await provider.selectOption(id)
    await expect(key).toHaveValue('')
    if (id === 'custom') {
      await settings.getByLabel('Endpoint', { exact: true }).fill('https://provider.example/v1')
      await settings.getByLabel('Endpoint', { exact: true }).press('Tab')
    }
    await key.fill(`test-${id}`)
    await key.press('Tab')
    await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-test-model')
    await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
    await expect(settings.getByRole('status').filter({ hasText: 'connected;' })).toContainText('AI requests and billing have not been tested')
    expect(requests.some(r => new URL(r.url).host === host && r.key?.endsWith(`test-${id}`))).toBe(true)
    expect(requests.filter(r => r.key?.endsWith(`test-${id}`)).every(r => new URL(r.url).host === host)).toBe(true)
  }
  await settings.getByLabel('Model', { exact: true }).selectOption('__custom__')
  await settings.getByLabel('Custom model name', { exact: true }).fill('my-explicit-model')
  await settings.getByLabel('Custom model name', { exact: true }).press('Tab')
  await settings.getByRole('button', { name: 'Refresh active models' }).click()
  await expect(settings.getByLabel('Custom model name', { exact: true })).toHaveValue('my-explicit-model')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  await settings.getByRole('button', { name: 'AI assistant', exact: true }).click()
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('my-explicit-model')
  await settings.getByLabel('Endpoint', { exact: true }).fill('https://another.example/v1')
  await settings.getByLabel('Endpoint', { exact: true }).press('Tab')
  await expect(key).toHaveValue('')
  expect(requests.filter(r => new URL(r.url).host === 'another.example').every(r => !r.key)).toBe(true)
  await provider.selectOption('gemini')
  await expect(key).toHaveValue('test-gemini')
  await expect(settings.getByRole('status').filter({ hasText: 'connected;' })).toHaveCount(0)
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await info.attach('provider-settings.png', { body: await page.screenshot({ path: info.outputPath('provider-settings.png') }), contentType: 'image/png' })
})


test('late verification cannot validate a newly selected provider', async ({ page }) => {
  let hold = false
  let release: (() => void) | undefined
  await page.route('**/models*', async route => {
    if (hold) await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ json: { data: [{ id: 'gpt-test-model' }] } })
  })
  await page.goto('/')
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI assistant', exact: true }).click()
  await settings.getByLabel('Enable the AI assistant', { exact: true }).check()
  await settings.getByLabel('Provider', { exact: true }).selectOption('openai')
  await settings.getByLabel('API key', { exact: true }).fill('fake-test-key')
  await settings.getByLabel('API key', { exact: true }).press('Tab')
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-test-model')
  hold = true
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect.poll(() => !!release).toBe(true)
  await settings.getByLabel('Provider', { exact: true }).selectOption('gemini')
  release!()
  await expect(settings.getByRole('status')).toContainText('Please enter an API key')
  await expect(settings.getByRole('status').filter({ hasText: 'connected;' })).toHaveCount(0)
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
})

test('provider profiles survive reload encrypted; disconnect and purge forget credentials', async ({ page }) => {
  await page.route('**/models*', route => route.fulfill({ json: { data: [{ id: 'gpt-test-model' }] } }))
  await page.goto('/')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const open = async () => {
    await page.locator('button[aria-label="Settings"]:visible').first().click()
    await settings.getByRole('button', { name: 'AI assistant', exact: true }).click()
    await settings.getByLabel('Enable the AI assistant', { exact: true }).check()
  }
  await open()
  const providers = ['anthropic', 'openai', 'gemini', 'xai', 'ollama', 'custom']
  for (const provider of providers) {
    await settings.getByLabel('Provider', { exact: true }).selectOption(provider)
    if (provider === 'custom') {
      await settings.getByLabel('Endpoint', { exact: true }).fill('https://profiles.example/v1')
      await settings.getByLabel('Endpoint', { exact: true }).press('Tab')
    }
    await settings.getByLabel('API key', { exact: true }).fill(`secret-${provider}`)
    await settings.getByLabel('API key', { exact: true }).press('Tab')
    await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-test-model')
  }
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('openquire.settings') ?? '{}'
    const saved = JSON.parse(raw)
    return saved.aiProvider === 'custom' && saved.aiModel === 'gpt-test-model' && saved.aiKey?.startsWith('enc:v1:') && saved.aiConnections?.startsWith('enc:v1:') && !raw.includes('secret-')
  })).toBe(true)
  // Endpoint remains in the legacy active fields; only the saved envelope hides it.
  await page.reload()
  await open()
  for (const provider of providers) {
    await settings.getByLabel('Provider', { exact: true }).selectOption(provider)
    await expect(settings.getByLabel('API key', { exact: true })).toHaveValue(`secret-${provider}`)
  }
  await settings.getByRole('button', { name: 'Disconnect this provider' }).click()
  await expect(settings.getByRole('status')).toContainText('disconnected')
  await expect(settings.getByLabel('Enable the AI assistant', { exact: true })).not.toBeChecked()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings')!).aiEnabled)).toBe(false)
  await page.reload()
  await open()
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
  await settings.getByLabel('Provider', { exact: true }).selectOption('gemini')
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('secret-gemini')
  await settings.getByRole('button', { name: 'Privacy & Security', exact: true }).click()
  page.on('dialog', dialog => dialog.accept())
  await settings.getByRole('button', { name: /Purge/ }).click()
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('openquire.settings') ?? '{}')
    return !saved.aiKey && !saved.aiConnections && !saved.aiEnabled
  })).toBe(true)
  await page.reload()
  await open()
  for (const provider of providers) {
    await settings.getByLabel('Provider', { exact: true }).selectOption(provider)
    await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
  }
})

test('diagnostics cancel pending checks and explain errors without echoing credentials', async ({ page }) => {
  let mode = 'ok'
  let release: (() => void) | undefined
  await page.route('**/models*', async route => {
    if (mode === 'hold') await new Promise<void>(resolve => { release = resolve })
    await route.fulfill(mode === 'denied' ? { status: 429, json: { error: { message: 'secret-echoed-by-provider' } } } : { json: { data: [{ id: 'gpt-test-model' }] } })
  })
  await page.goto('/')
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI assistant', exact: true }).click()
  await settings.getByLabel('Enable the AI assistant', { exact: true }).check()
  await settings.getByLabel('Provider', { exact: true }).selectOption('xai')
  await settings.getByLabel('API key', { exact: true }).fill('test-key')
  await settings.getByLabel('API key', { exact: true }).press('Tab')
  await expect(settings.getByLabel('Model', { exact: true })).toHaveValue('gpt-test-model')
  mode = 'hold'
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect.poll(() => !!release).toBe(true)
  await settings.getByRole('button', { name: 'Cancel connection check' }).click()
  await expect(settings.getByRole('status')).toContainText('cancelled')
  release!()
  mode = 'denied'
  await settings.getByRole('button', { name: 'Check connection', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Request limit reached')
  await expect(settings).not.toContainText('secret-echoed-by-provider')
})

test('unavailable encrypted storage is visible and never persists a plaintext profile', async ({ page }) => {
  await page.route('**/models*', route => route.fulfill({ json: { data: [] } }))
  await page.goto('/')
  await page.evaluate(() => { crypto.subtle.encrypt = async () => { throw new Error('encryption unavailable') } })
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI assistant', exact: true }).click()
  await settings.getByLabel('Enable the AI assistant', { exact: true }).check()
  await settings.getByLabel('API key', { exact: true }).fill('session-only-secret')
  await settings.getByLabel('API key', { exact: true }).press('Tab')
  await expect(settings.getByRole('alert')).toContainText('kept only for this session')
  await settings.getByLabel('Provider', { exact: true }).selectOption('gemini')
  await expect(settings.getByRole('alert')).toContainText('kept only for this session')
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('openquire.settings') ?? '{}'
    const saved = JSON.parse(raw)
    return saved.aiProvider === 'gemini' && !raw.includes('session-only-secret') && !saved.aiConnections && !saved.aiKey
  })).toBe(true)
  await settings.getByLabel('Provider', { exact: true }).selectOption('anthropic')
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('session-only-secret')
})
