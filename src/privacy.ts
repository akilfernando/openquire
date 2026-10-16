/** Device-local encrypted storage and private-data lifecycle. */
const DB_NAME = 'openquire_vault'
const STORE_NAME = 'keys'
const MASTER_KEY_ID = 'device_master_key'
export const PRIVACY_REVISION_KEY = 'openquire.privacy-revision'
let generation = 0
let deleting = false

/** Detect a purge started by another tab before committing an async write. */
export function privacyRevision(): string {
  let shared = ''
  try { shared = localStorage.getItem(PRIVACY_REVISION_KEY) ?? '' } catch { /* storage may be unavailable */ }
  return `${generation}:${shared}`
}

function assertCurrent(revision: string): void {
  if (deleting || revision.endsWith(':purging') || revision !== privacyRevision()) {
    throw new Error('Private storage changed during this operation. Please try again.')
  }
}

export function openPrivateDb(revision: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Encrypted storage is unavailable.'))
    let blocked = false
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME)
      if (!req.result.objectStoreNames.contains('recovery')) req.result.createObjectStore('recovery')
    }
    req.onerror = () => reject(req.error ?? new Error('Cannot open encrypted storage.'))
    req.onblocked = () => {
      blocked = true
      reject(new Error('Encrypted storage is blocked. Close other OpenQuire tabs and retry.'))
    }
    req.onsuccess = () => {
      const db = req.result
      if (blocked) { db.close(); return }
      db.onversionchange = () => db.close()
      try {
        assertCurrent(revision)
        resolve(db)
      } catch (error) {
        db.close()
        reject(error)
      }
    }
  })
}

async function masterKey(create: boolean, revision: string): Promise<CryptoKey | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Encrypted storage requires Web Crypto.')
  assertCurrent(revision)
  // Generate outside the transaction, then atomically recheck and insert. No
  // asynchronous crypto may suspend the transaction between get and put.
  const candidate = create ? await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  ) : null
  assertCurrent(revision)
  const db = await openPrivateDb(revision)
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, create ? 'readwrite' : 'readonly')
      let key: CryptoKey | null = null
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(MASTER_KEY_ID)
      req.onsuccess = () => {
        if (req.result) key = req.result
        else if (candidate) {
          key = candidate
          store.add(candidate, MASTER_KEY_ID)
        }
      }
      tx.oncomplete = () => resolve(key)
      tx.onerror = () => reject(tx.error ?? new Error('Encrypted storage transaction failed.'))
      tx.onabort = () => reject(tx.error ?? new Error('Encrypted storage transaction was aborted.'))
    })
  } finally {
    db.close()
  }
}

/** New values require encryption; raw/plain values remain readable for migration. */
export async function encryptSensitive(plaintext: string): Promise<string> {
  if (!plaintext) return ''
  const revision = privacyRevision()
  const key = await masterKey(true, revision)
  assertCurrent(revision)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  try {
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, encoded))
    assertCurrent(revision)
    // Signatures can exceed the argument limit for String.fromCharCode.
    let binary = ''
    for (let offset = 0; offset < encrypted.length; offset += 8192) {
      binary += String.fromCharCode(...encrypted.subarray(offset, offset + 8192))
    }
    return `enc:v1:${btoa(String.fromCharCode(...iv))}:${btoa(binary)}`
  } finally {
    encoded.fill(0)
  }
}

export async function decryptSensitive(ciphertext: string): Promise<string> {
  if (!ciphertext) return ''
  if (ciphertext.startsWith('raw:')) return ciphertext.slice(4)
  if (!ciphertext.startsWith('enc:v1:')) return ciphertext
  const revision = privacyRevision()
  try {
    const parts = ciphertext.split(':')
    if (parts.length !== 4) return ''
    // Reading must not create a replacement for a missing encryption key.
    const key = await masterKey(false, revision)
    if (!key) return ''
    const iv = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0))
    const data = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0))
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data))
    try {
      assertCurrent(revision)
      return new TextDecoder().decode(plaintext)
    } finally {
      plaintext.fill(0)
    }
  } catch {
    return ''
  }
}

export function zeroizeBuffer(buf: Uint8Array | ArrayBuffer | null | undefined): void {
  if (buf instanceof Uint8Array) buf.fill(0)
  else if (buf instanceof ArrayBuffer) new Uint8Array(buf).fill(0)
}

export interface EncryptedBytes { iv: Uint8Array; data: Uint8Array }

/** Binary storage avoids base64 copies of document checkpoints. No plaintext fallback. */
export async function encryptPrivateBytes(bytes: Uint8Array, context: string, revision: string): Promise<EncryptedBytes> {
  const key = await masterKey(true, revision)
  assertCurrent(revision)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode(context)
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key!, bytes))
  assertCurrent(revision)
  return { iv, data }
}

export async function decryptPrivateBytes(value: EncryptedBytes, context: string, revision: string): Promise<Uint8Array> {
  const key = await masterKey(false, revision)
  if (!key) throw new Error('The device encryption key is unavailable. This checkpoint cannot be restored.')
  assertCurrent(revision)
  const additionalData = new TextEncoder().encode(context)
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv, additionalData }, key, value.data))
  try { assertCurrent(revision); return bytes }
  catch (error) { bytes.fill(0); throw error }
}

/** Resolves only after deletion; blocked/failed deletion is reported to the UI. */
export async function purgeAllPrivateData(): Promise<void> {
  generation++
  const marker = `${Date.now()}-${Math.random()}:purging`
  localStorage.setItem(PRIVACY_REVISION_KEY, marker)
  localStorage.setItem('openquire.recovery-consent', `disabled:${marker}`)
  for (const key of ['openquire.signature', 'openquire:signature', 'openquire.recent', 'openquire.pkcs11', 'openquire.author']) {
    localStorage.removeItem(key)
  }
  const raw = localStorage.getItem('openquire.settings')
  if (raw) {
    try {
      const settings = JSON.parse(raw)
      delete settings.aiKey
      delete settings.aiProfile
      settings.aiEnabled = false
      settings.recoveryEnabled = false
      settings.author = 'OpenQuire user'
      localStorage.setItem('openquire.settings', JSON.stringify(settings))
    } catch {
      localStorage.removeItem('openquire.settings')
    }
  }
  if (typeof indexedDB === 'undefined') {
    if (localStorage.getItem(PRIVACY_REVISION_KEY) === marker) localStorage.setItem(PRIVACY_REVISION_KEY, marker.replace(':purging', ':complete'))
    return
  }
  deleting = true
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onblocked = () => reject(new Error('Private-data deletion is blocked. Close other OpenQuire tabs and retry.'))
    req.onerror = () => {
      deleting = false
      reject(req.error ?? new Error('Private-data deletion failed. Please retry.'))
    }
    req.onsuccess = () => {
      deleting = false
      try {
        if (localStorage.getItem(PRIVACY_REVISION_KEY) === marker) localStorage.setItem(PRIVACY_REVISION_KEY, marker.replace(':purging', ':complete'))
        resolve()
      } catch (error) {
        reject(error)
      }
    }
  })
}
