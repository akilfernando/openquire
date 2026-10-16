import { expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'

// Bundle the real modules into the test process. The suite uses the production
// preview, where TypeScript source URLs are not available.
const recoveryCode = buildSync({
  entryPoints: [new URL('../src/recovery.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'recoveryTest',
  write: false,
}).outputFiles[0].text

const privacyCode = buildSync({
  entryPoints: [new URL('../src/privacy.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'privacyTest',
  write: false,
}).outputFiles[0].text

test('round trips a checkpoint and stores only encrypted document content', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, listRecovery, readRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    const bytes = new Uint8Array([11, 22, 33, 44, 55])
    await writeRecovery('doc-1', { name: 'Quarterly report', revision: 'revision-7', bytes }, () => true)
    const entries = await listRecovery()
    const snapshot = await readRecovery('doc-1')
    const stored = await new Promise<{ fields: string[]; encryptedFields: string[]; containsPlainName: boolean; encryptedDiffers: boolean }>((resolve, reject) => {
      // Deliberately omit a version so this works with the production DB version.
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('recovery', 'readonly')
        const get = tx.objectStore('recovery').get('doc-1')
        get.onerror = () => reject(get.error)
        get.onsuccess = () => {
          const record = get.result
          const data = Array.from(record.encrypted.data as Uint8Array)
          resolve({
            fields: Object.keys(record).sort(),
            encryptedFields: Object.keys(record.encrypted).sort(),
            containsPlainName: JSON.stringify(record).includes('Quarterly report'),
            encryptedDiffers: data.length !== bytes.length || data.some((value, index) => value !== bytes[index]),
          })
        }
        tx.oncomplete = () => db.close()
      }
    })
    return {
      entries: entries.map((entry: { id: string; name: string; unavailable?: boolean }) => ({ id: entry.id, name: entry.name, unavailable: entry.unavailable ?? false })),
      snapshot: { name: snapshot.name, revision: snapshot.revision, bytes: Array.from(snapshot.bytes) },
      stored,
    }
  }, recoveryCode)

  expect(result.entries).toEqual([{ id: 'doc-1', name: 'Quarterly report', unavailable: false }])
  expect(result.snapshot).toEqual({ name: 'Quarterly report', revision: 'revision-7', bytes: [11, 22, 33, 44, 55] })
  expect(result.stored.fields).toEqual(['encrypted', 'id', 'updated'])
  expect(result.stored.encryptedFields.sort()).toEqual(['data', 'iv'])
  expect(result.stored.containsPlainName).toBe(false)
  expect(result.stored.encryptedDiffers).toBe(true)
})

test('a failed replacement encryption preserves the previous checkpoint', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, readRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    await writeRecovery('doc-1', { name: 'Original', revision: 'r1', bytes: new Uint8Array([1, 2, 3]) }, () => true)
    const original = crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt = (async (...args: Parameters<typeof original>) => {
      throw new Error('Injected encryption failure')
    }) as typeof crypto.subtle.encrypt
    let error = ''
    try {
      await writeRecovery('doc-1', { name: 'Replacement', revision: 'r2', bytes: new Uint8Array([9, 8, 7]) }, () => true)
    } catch (caught) {
      error = (caught as Error).message
    } finally {
      crypto.subtle.encrypt = original
    }
    const previous = await readRecovery('doc-1')
    return { error, name: previous.name, revision: previous.revision, bytes: Array.from(previous.bytes) }
  }, recoveryCode)

  expect(result.error).toContain('Injected encryption failure')
  expect(result).toMatchObject({ name: 'Original', revision: 'r1', bytes: [1, 2, 3] })
})

test('stale snapshots and opting out prevent pending or future writes', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, listRecovery, readRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    await writeRecovery('doc-1', { name: 'Saved checkpoint', revision: 'r1', bytes: new Uint8Array([1]) }, () => true)

    const original = crypto.subtle.encrypt.bind(crypto.subtle)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    crypto.subtle.encrypt = (async (...args: Parameters<typeof original>) => {
      started()
      await gate
      return original(...args)
    }) as typeof crypto.subtle.encrypt
    let optedOutWrite = false
    try {
      const pending = writeRecovery('doc-1', { name: 'Stale checkpoint', revision: 'r2', bytes: new Uint8Array([2]) }, () => true)
      await entered
      setRecoveryConsent(false)
      release()
      optedOutWrite = await pending
    } finally {
      release()
      crypto.subtle.encrypt = original
    }

    setRecoveryConsent(true)
    const staleWrite = await writeRecovery('doc-1', { name: 'Invalid checkpoint', revision: 'r3', bytes: new Uint8Array([3]) }, () => false)
    setRecoveryConsent(false)
    const futureWrite = await writeRecovery('doc-2', { name: 'Opted out', revision: 'r4', bytes: new Uint8Array([4]) }, () => true)
    const previous = await readRecovery('doc-1')
    return {
      optedOutWrite,
      staleWrite,
      futureWrite,
      entries: (await listRecovery()).map((entry: { id: string }) => entry.id),
      previous: { name: previous.name, revision: previous.revision, bytes: Array.from(previous.bytes) },
    }
  }, recoveryCode)

  expect(result).toEqual({
    optedOutWrite: false,
    staleWrite: false,
    futureWrite: false,
    entries: ['doc-1'],
    previous: { name: 'Saved checkpoint', revision: 'r1', bytes: [1] },
  })
})

test('missing encryption keys make checkpoints unavailable without creating a replacement', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, listRecovery, readRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    await writeRecovery('doc-1', { name: 'Secret', revision: 'r1', bytes: new Uint8Array([1, 2]) }, () => true)
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('keys', 'readwrite')
        tx.objectStore('keys').clear()
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
    const entries = await listRecovery()
    let readError = ''
    try { await readRecovery('doc-1') } catch (error) { readError = (error as Error).message }
    const keyCount = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('keys', 'readonly')
        const count = tx.objectStore('keys').count()
        tx.oncomplete = () => { db.close(); resolve(count.result) }
      }
    })
    return { entries: entries.map((entry: { name: string; unavailable?: boolean }) => ({ name: entry.name, unavailable: entry.unavailable ?? false })), readError, keyCount }
  }, recoveryCode)

  expect(result.entries).toEqual([{ name: 'Unavailable checkpoint', unavailable: true }])
  expect(result.readError).toContain('encryption key is unavailable')
  expect(result.keyCount).toBe(0)
})

test('discard removes one checkpoint and clear removes every checkpoint', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, listRecovery, discardRecovery, clearRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    await writeRecovery('doc-1', { name: 'First', revision: 'r1', bytes: new Uint8Array([1]) }, () => true)
    await writeRecovery('doc-2', { name: 'Second', revision: 'r2', bytes: new Uint8Array([2]) }, () => true)
    await discardRecovery('doc-1')
    const afterDiscard = (await listRecovery()).map((entry: { id: string }) => entry.id)
    await writeRecovery('doc-3', { name: 'Third', revision: 'r3', bytes: new Uint8Array([3]) }, () => true)
    await clearRecovery()
    return { afterDiscard, afterClear: await listRecovery() }
  }, recoveryCode)

  expect(result.afterDiscard).toEqual(['doc-2'])
  expect(result.afterClear).toEqual([])
})

test('keeps at most three checkpoints and rejects oversized replacements without losing the old one', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { RECOVERY_LIMITS, setRecoveryConsent, writeRecovery, listRecovery, readRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    const realNow = Date.now
    let tick = 1_800_000_000_000
    Date.now = () => tick++
    try {
      for (const [id, name] of [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]) {
        await writeRecovery(id, { name, revision: `r-${name}`, bytes: new Uint8Array([name.charCodeAt(0)]) }, () => true)
      }
    } finally {
      Date.now = realNow
    }
    let oversizedError = ''
    try {
      await writeRecovery('c', { name: 'Too large', revision: 'r-large', bytes: new Uint8Array(RECOVERY_LIMITS.documentBytes + 1) }, () => true)
    } catch (error) {
      oversizedError = (error as Error).message
    }
    const entries = await listRecovery()
    const previous = await readRecovery('c')
    return { ids: entries.map((entry: { id: string }) => entry.id), oversizedError, previous: { name: previous.name, revision: previous.revision, bytes: Array.from(previous.bytes) } }
  }, recoveryCode)

  expect(result.ids).toEqual(['d', 'c', 'b'])
  expect(result.oversizedError).toContain('16 MiB checkpoint limit')
  expect(result.previous).toEqual({ name: 'C', revision: 'r-C', bytes: [67] })
})

test('purging through the privacy module deletes both key and recovery stores', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async ({ recovery, privacy }) => {
    const recoveryApi = new Function(`${recovery}; return recoveryTest;`)()
    const privacyApi = new Function(`${privacy}; return privacyTest;`)()
    recoveryApi.setRecoveryConsent(true)
    await recoveryApi.writeRecovery('doc-1', { name: 'Private report', revision: 'r1', bytes: new Uint8Array([7, 8, 9]) }, () => true)
    const before = await new Promise<{ stores: string[]; keys: number; checkpoints: number }>((resolve, reject) => {
      // Open without a version to follow the current vault schema.
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['keys', 'recovery'], 'readonly')
        const keys = tx.objectStore('keys').count()
        const checkpoints = tx.objectStore('recovery').count()
        tx.oncomplete = () => { db.close(); resolve({ stores: Array.from(db.objectStoreNames), keys: keys.result, checkpoints: checkpoints.result }) }
      }
    })
    await privacyApi.purgeAllPrivateData()
    const storesAfter = await new Promise<string[]>((resolve, reject) => {
      // A fresh versionless open after deletion creates an empty database.
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => { /* No schema means the old database was deleted. */ }
      request.onsuccess = () => { const db = request.result; const names = Array.from(db.objectStoreNames); db.close(); resolve(names) }
    })
    return { before, storesAfter }
  }, { recovery: recoveryCode, privacy: privacyCode })

  expect(result.before).toMatchObject({ keys: 1, checkpoints: 1 })
  expect(result.before.stores).toEqual(['keys', 'recovery'])
  expect(result.storesAfter).toEqual([])
})

test('listing removes expired checkpoints from the IndexedDB store', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, listRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    await writeRecovery('doc-1', { name: 'Expired report', revision: 'r1', bytes: new Uint8Array([1, 2]) }, () => true)

    await new Promise<void>((resolve, reject) => {
      // Open without a version to match the production vault schema.
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('recovery', 'readwrite')
        const store = tx.objectStore('recovery')
        const get = store.get('doc-1')
        get.onerror = () => reject(get.error)
        get.onsuccess = () => {
          const record = get.result
          record.updated = Date.now() - 8 * 24 * 60 * 60 * 1000
          store.put(record, 'doc-1')
        }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })

    const entries = await listRecovery()
    const remaining = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('openquire_vault')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('recovery', 'readonly')
        const count = tx.objectStore('recovery').count()
        tx.oncomplete = () => { db.close(); resolve(count.result) }
        tx.onerror = () => reject(tx.error)
      }
    })
    return { entries, remaining }
  }, recoveryCode)

  expect(result.entries).toEqual([])
  expect(result.remaining).toBe(0)
})

test('a quota error during replacement rejects and preserves the previous checkpoint', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async (code) => {
    const { setRecoveryConsent, writeRecovery, readRecovery } = new Function(`${code}; return recoveryTest;`)()
    setRecoveryConsent(true)
    await writeRecovery('doc-1', { name: 'Original', revision: 'r1', bytes: new Uint8Array([3, 4, 5]) }, () => true)

    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
      throw new DOMException('Injected quota failure', 'QuotaExceededError')
    } as typeof originalPut
    let error = ''
    let errorName = ''
    try {
      await writeRecovery('doc-1', { name: 'Replacement', revision: 'r2', bytes: new Uint8Array([8, 9]) }, () => true)
    } catch (caught) {
      error = (caught as Error).message
      errorName = (caught as DOMException).name
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }

    const previous = await readRecovery('doc-1')
    return { error, errorName, name: previous.name, revision: previous.revision, bytes: Array.from(previous.bytes) }
  }, recoveryCode)

  expect(result.error).toContain('Injected quota failure')
  expect(result.errorName).toBe('QuotaExceededError')
  expect(result).toMatchObject({ name: 'Original', revision: 'r1', bytes: [3, 4, 5] })
})
