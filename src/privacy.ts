/**
 * Privacy & Security utilities for OpenQuire.
 *
 * Implements hardware-grade and Web Crypto protections:
 * 1. AES-GCM (256-bit) encryption for sensitive stored credentials (API keys, personal form autofill profiles, handwritten signatures).
 * 2. In-memory zeroization of sensitive byte buffers.
 * 3. One-click data purge for total client-side privacy hygiene.
 */

const DB_NAME = 'openquire_vault'
const STORE_NAME = 'keys'
const MASTER_KEY_ID = 'device_master_key'

// Open or initialize IndexedDB for non-extractable CryptoKey storage
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB not supported'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getOrGenerateMasterKey(): Promise<CryptoKey | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const getReq = store.get(MASTER_KEY_ID)
      getReq.onsuccess = async () => {
        if (getReq.result instanceof CryptoKey) {
          resolve(getReq.result)
        } else {
          // Generate new non-extractable 256-bit AES-GCM key
          const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false, // non-extractable for memory safety
            ['encrypt', 'decrypt']
          )
          const putTx = db.transaction(STORE_NAME, 'readwrite')
          putTx.objectStore(STORE_NAME).put(key, MASTER_KEY_ID)
          putTx.oncomplete = () => resolve(key)
          putTx.onerror = () => reject(putTx.error)
        }
      }
      getReq.onerror = () => reject(getReq.error)
    })
  } catch (err) {
    console.warn('OpenQuire: Web Crypto storage unavailable, falling back to basic storage', err)
    return null
  }
}

/**
 * Encrypts a sensitive string using AES-GCM with a random 12-byte IV.
 * Returns a prefixed ciphertext string: "enc:v1:<base64-iv>:<base64-data>".
 */
export async function encryptSensitive(plaintext: string): Promise<string> {
  if (!plaintext) return ''
  const key = await getOrGenerateMasterKey()
  if (!key || typeof crypto === 'undefined' || !crypto.subtle) {
    // Fallback if Web Crypto is absent (e.g. insecure HTTP context)
    return `raw:${plaintext}`
  }

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  )

  const ivB64 = btoa(String.fromCharCode(...iv))
  const dataB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
  return `enc:v1:${ivB64}:${dataB64}`
}

/**
 * Decrypts a sensitive string previously encrypted with encryptSensitive.
 */
export async function decryptSensitive(ciphertext: string): Promise<string> {
  if (!ciphertext) return ''
  if (ciphertext.startsWith('raw:')) {
    return ciphertext.slice(4)
  }
  if (!ciphertext.startsWith('enc:v1:')) {
    // Legacy unencrypted plaintext fallback
    return ciphertext
  }

  const [, , ivB64, dataB64] = ciphertext.split(':')
  if (!ivB64 || !dataB64) return ''

  const key = await getOrGenerateMasterKey()
  if (!key || typeof crypto === 'undefined' || !crypto.subtle) {
    return ''
  }

  try {
    const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0))
    const data = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0))
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    )
    return new TextDecoder().decode(decrypted)
  } catch (err) {
    console.warn('OpenQuire: Failed to decrypt sensitive data with device key', err)
    return ''
  }
}

/**
 * Securely overwrites a typed array's memory with zeros.
 */
export function zeroizeBuffer(buf: Uint8Array | ArrayBuffer | null | undefined): void {
  if (!buf) return
  if (buf instanceof Uint8Array) {
    buf.fill(0)
  } else if (buf instanceof ArrayBuffer) {
    new Uint8Array(buf).fill(0)
  }
}

/**
 * Purges all private data stored in the browser:
 * - Saved handwritten signatures
 * - Recent files list
 * - AI credentials and autofill profiles
 * - PKCS#11 module paths
 * - Master encryption key
 */
export async function purgeAllPrivateData(): Promise<void> {
  try {
    localStorage.removeItem('openquire.signature')
    localStorage.removeItem('openquire:signature')
    localStorage.removeItem('openquire.recent')
    localStorage.removeItem('openquire.pkcs11')

    // Clean sensitive fields in openquire.settings
    const rawSettings = localStorage.getItem('openquire.settings')
    if (rawSettings) {
      try {
        const s = JSON.parse(rawSettings)
        delete s.aiKey
        delete s.aiProfile
        s.author = 'OpenQuire user'
        localStorage.setItem('openquire.settings', JSON.stringify(s))
      } catch {
        localStorage.removeItem('openquire.settings')
      }
    }

    // Delete IndexedDB vault
    if (typeof indexedDB !== 'undefined') {
      indexedDB.deleteDatabase(DB_NAME)
    }
  } catch (err) {
    console.error('Error during private data purge:', err)
  }
}
