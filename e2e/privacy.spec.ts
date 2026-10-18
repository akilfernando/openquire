import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Run the real storage module in a browser without adding test hooks to the app.
// The workspace suite serves a production preview, where source URLs do not exist.
const privacyCode = transformSync(readFileSync(new URL('../src/privacy.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'iife', globalName: 'privacyTest',
}).code

test('locked connections preserve credentials until hydration and allow later edits', async ({ page }) => {
  await page.route('**/models*', (route) => route.fulfill({ json: { data: [] } }))
  await page.goto('/')
  await page.evaluate(async (code) => {
    const { encryptSensitive } = new Function(`${code}; return privacyTest;`)()
    localStorage.setItem('openquire.settings', JSON.stringify({
      aiEnabled: true, aiProvider: 'anthropic', aiKey: await encryptSensitive('old-key'), aiProfile: '',
      aiConnections: await encryptSensitive(JSON.stringify({ xai: { apiKey: 'saved-xai-key', model: 'saved-model', baseUrl: '' } })),
    }))
  }, privacyCode)
  await page.addInitScript(() => {
    const state = globalThis as unknown as { releaseDecryption: () => void; decryptionFinished: boolean }
    const wait = new Promise<void>((resolve) => { state.releaseDecryption = resolve })
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    crypto.subtle.decrypt = async (...args: Parameters<typeof decrypt>) => {
      await wait
      const result = await decrypt(...args)
      state.decryptionFinished = true
      return result
    }
  })
  await page.reload()
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  const anthropic = settings.getByRole('region', { name: 'Anthropic (Claude)', exact: true })
  await expect(anthropic.getByRole('button', { name: /Edit|Set up/ })).toBeDisabled()
  await expect(settings.getByLabel('API key', { exact: true })).toHaveCount(0)
  await settings.getByLabel('Enable the AI assistant', { exact: true }).uncheck()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings')!).aiEnabled)).toBe(false)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings')!).aiKey.startsWith('enc:v1:'))).toBe(true)
  await page.evaluate(() => (globalThis as unknown as { releaseDecryption: () => void }).releaseDecryption())
  await expect(anthropic.getByRole('button', { name: /Edit|Set up/ })).toBeEnabled()
  await anthropic.getByRole('button', { name: /Edit|Set up/ }).click()
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('old-key')
  await settings.getByLabel('API key', { exact: true }).fill('new-key')
  await settings.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('Connection checked, but no models were listed.')
  await settings.getByLabel('Model', { exact: true }).fill('saved-model')
  const enableWhenDone = settings.getByLabel('Enable AI when I finish', { exact: true })
  if (await enableWhenDone.isChecked()) await enableWhenDone.uncheck()
  await settings.getByRole('button', { name: 'Save and select' }).click()
  await expect.poll(() => page.evaluate(async (code) => {
    const { decryptSensitive } = new Function(`${code}; return privacyTest;`)()
    return decryptSensitive(JSON.parse(localStorage.getItem('openquire.settings')!).aiKey)
  }, privacyCode)).toBe('new-key')
  await settings.getByRole('button', { name: 'Privacy & Security', exact: true }).click()
  await settings.getByRole('checkbox', { name: 'Disable all AI features', exact: true }).check()
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await expect(settings.getByText('AI features are hidden.', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Manage AI privacy' }).click()
  await settings.getByRole('checkbox', { name: 'Disable all AI features', exact: true }).uncheck()
  await settings.getByRole('button', { name: 'AI & connections', exact: true }).click()
  await settings.getByRole('region', { name: 'xAI (Grok)', exact: true }).getByRole('button', { name: 'Edit' }).click()
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('saved-xai-key')
  await settings.getByRole('button', { name: 'Cancel setup' }).click()
  await anthropic.getByRole('button', { name: 'Edit' }).click()
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('new-key')
})

test('concurrent tabs encrypt with one persisted, non-extractable device key', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([page.goto('/'), other.goto('/')])
  const values = await Promise.all([page, other].map((tab, index) => tab.evaluate(async ({ index, code }) => {
    const { encryptSensitive } = new Function(`${code}; return privacyTest;`)()
    return Promise.all(Array.from({ length: 5 }, (_, n) => encryptSensitive(`tab-${index}-${n}`)))
  }, { index, code: privacyCode })))
  const decoded = await page.evaluate(async ({ values, code }) => {
    const { decryptSensitive } = new Function(`${code}; return privacyTest;`)()
    return Promise.all(values.flat().map((value) => decryptSensitive(value)))
  }, { values, code: privacyCode })
  expect(decoded).toEqual(Array.from({ length: 2 }, (_, tab) => Array.from({ length: 5 }, (_, n) => `tab-${tab}-${n}`)).flat())
  const stored = await page.evaluate(() => new Promise<{ count: number; extractable: boolean }>((resolve, reject) => {
    const request = indexedDB.open('openquire_vault')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('keys', 'readonly')
      const keys = tx.objectStore('keys').getAll()
      tx.oncomplete = () => { db.close(); resolve({ count: keys.result.length, extractable: keys.result[0].extractable }) }
    }
  }))
  expect(stored).toEqual({ count: 1, extractable: false })
  // No connection leaked by either tab may block deletion.
  await page.evaluate(async (code) => {
    await new Function(`${code}; return privacyTest;`)().purgeAllPrivateData()
  }, privacyCode)
})

test('purge invalidates old ciphertext without generating a replacement key on read', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const privacy = new Function(`${code}; return privacyTest;`)()
    const encrypted = await privacy.encryptSensitive('private value')
    await privacy.purgeAllPrivateData()
    const decrypted = await privacy.decryptSensitive(encrypted)
    const count = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('keys', 'readonly')
        const keys = tx.objectStore('keys').count()
        tx.oncomplete = () => { db.close(); resolve(keys.result) }
      }
    })
    return { decrypted, count, legacy: await privacy.decryptSensitive('raw:legacy value') }
  }, privacyCode)
  expect(result).toEqual({ decrypted: '', count: 0, legacy: 'legacy value' })
})

test('transaction abort rejects encryption rather than hanging or returning plaintext', async ({ page }) => {
  await page.goto('/')
  const error = await page.evaluate(async (code) => {
    const { encryptSensitive } = new Function(`${code}; return privacyTest;`)()
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args)
      queueMicrotask(() => tx.abort())
      return tx
    }
    try {
      return await encryptSensitive('never store this raw').then(() => 'unexpected success', (error: Error) => error.message)
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
  }, privacyCode)
  expect(error).toBeTruthy()
  expect(error).not.toBe('unexpected success')
})

test('a pending encryption cannot restore secrets after purge', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { encryptSensitive, purgeAllPrivateData } = new Function(`${code}; return privacyTest;`)()
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    const original = crypto.subtle.generateKey.bind(crypto.subtle)
    crypto.subtle.generateKey = (async (...args: Parameters<typeof original>) => {
      started()
      await wait
      return original(...args)
    }) as typeof crypto.subtle.generateKey
    try {
      const pending = encryptSensitive('private').then(() => 'unexpected success', () => 'cancelled')
      await entered
      await purgeAllPrivateData()
      release()
      return await pending
    } finally {
      release()
      crypto.subtle.generateKey = original
    }
  }, privacyCode)
  expect(result).toBe('cancelled')
})

test('purge reports blocked deletion and only shows success after a completed retry', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async (code) => {
    const { encryptSensitive } = new Function(`${code}; return privacyTest;`)()
    localStorage.setItem('openquire.signature', await encryptSensitive('saved signature'))
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        // Deliberately emulate an old tab that does not close on versionchange.
        ;(globalThis as unknown as { blockedDb: IDBDatabase }).blockedDb = request.result
        resolve()
      }
    })
  }, privacyCode)
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Privacy & Security', exact: true }).click()
  page.on('dialog', (dialog) => dialog.accept())
  await settings.getByRole('button', { name: 'Purge Private Data Now', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('deletion is blocked')
  await expect(settings.getByText('All private data, credentials, and histories purged.')).toHaveCount(0)
  await page.evaluate(() => (globalThis as unknown as { blockedDb: IDBDatabase }).blockedDb.close())
  await expect.poll(() => page.evaluate(() => localStorage.getItem('openquire.privacy-revision'))).toMatch(/:complete$/)
  await settings.getByRole('button', { name: 'Purge Private Data Now', exact: true }).click()
  await expect(settings.getByText('All private data, credentials, and histories purged.')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('openquire.signature'))).toBeNull()
})
