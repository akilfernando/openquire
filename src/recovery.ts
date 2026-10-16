import { decryptPrivateBytes, encryptPrivateBytes, openPrivateDb, privacyRevision, type EncryptedBytes } from './privacy'

export const RECOVERY_LIMITS = { documents: 3, bytes: 32 * 1024 * 1024, documentBytes: 16 * 1024 * 1024, days: 7 }
const STORE = 'recovery'
export const RECOVERY_CONSENT_KEY = 'openquire.recovery-consent'
let generation = 0
export interface RecoverySnapshot { name: string; revision: string; bytes: Uint8Array }
interface Record { id: string; updated: number; encrypted: EncryptedBytes }
export interface RecoveryEntry { id: string; updated: number; name: string; unavailable?: boolean }

/** Immediately fences asynchronous work when opting out or clearing private state. */
export function invalidateRecovery(): void { generation++ }

export function setRecoveryConsent(enabled: boolean): void {
  invalidateRecovery()
  localStorage.setItem(RECOVERY_CONSENT_KEY, `${enabled ? 'enabled' : 'disabled'}:${crypto.randomUUID()}`)
}

function consent(): string {
  try { return localStorage.getItem(RECOVERY_CONSENT_KEY) ?? '' } catch { return '' }
}

async function transaction<T>(mode: IDBTransactionMode, revision: string, work: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await openPrivateDb(revision)
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      let value: T
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => reject(tx.error ?? new Error('Recovery storage failed.'))
      tx.onabort = () => reject(tx.error ?? new Error('Recovery storage was interrupted.'))
      const fail = (error: unknown) => { tx.abort(); reject(error) }
      try { work(tx.objectStore(STORE), (result) => { value = result }, fail) }
      catch (error) { fail(error) }
    })
  } finally { db.close() }
}

const expired = (record: Record) => record.updated < Date.now() - RECOVERY_LIMITS.days * 86400_000
const current = (epoch: number, revision: string) => epoch === generation && revision === privacyRevision() && !revision.endsWith(':purging')

function unpack(bytes: Uint8Array): RecoverySnapshot {
  if (bytes.length < 4) throw new Error('The recovery checkpoint is damaged.')
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (length > bytes.length - 4 || length > 65536) throw new Error('The recovery checkpoint is damaged.')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))
  if (typeof header.name !== 'string' || typeof header.revision !== 'string') throw new Error('The recovery checkpoint is damaged.')
  return { name: header.name, revision: header.revision, bytes: bytes.slice(4 + length) }
}

/** A failed replacement leaves the previous checkpoint intact. */
export async function writeRecovery(id: string, snapshot: RecoverySnapshot, valid: () => boolean, revision = privacyRevision()): Promise<boolean> {
  const permission = consent()
  if (!permission.startsWith('enabled:')) return false
  if (snapshot.bytes.length > RECOVERY_LIMITS.documentBytes) throw new Error('Recovery skipped: this document exceeds the 16 MiB checkpoint limit. Save a copy yourself.')
  const epoch = generation
  const header = new TextEncoder().encode(JSON.stringify({ name: snapshot.name, revision: snapshot.revision }))
  if (header.length > 65536) throw new Error('Recovery skipped: document metadata is too large.')
  const packed = new Uint8Array(4 + header.length + snapshot.bytes.length)
  new DataView(packed.buffer).setUint32(0, header.length)
  packed.set(header, 4)
  packed.set(snapshot.bytes, 4 + header.length)
  let encrypted: EncryptedBytes
  try { encrypted = await encryptPrivateBytes(packed, `openquire-recovery:${id}`, revision) }
  finally { packed.fill(0) }
  if (!current(epoch, revision) || consent() !== permission || !valid()) return false
  return transaction<boolean>('readwrite', revision, (store, done, fail) => {
    const request = store.getAll()
    request.onsuccess = () => {
      try {
        if (!current(epoch, revision) || consent() !== permission || !valid()) { done(false); return }
        const replacement: Record = { id, updated: Date.now(), encrypted }
        const remaining = (request.result as Record[]).filter((record) => record.id !== id && !expired(record)).sort((a, b) => b.updated - a.updated)
        const keep: Record[] = [replacement]
        let total = encrypted.data.byteLength
        for (const record of remaining) {
          if (keep.length >= RECOVERY_LIMITS.documents || total + record.encrypted.data.byteLength > RECOVERY_LIMITS.bytes) continue
          keep.push(record)
          total += record.encrypted.data.byteLength
        }
        const ids = new Set(keep.map((record) => record.id))
        for (const record of request.result as Record[]) if (!ids.has(record.id)) store.delete(record.id)
        store.put(replacement, id)
        done(true)
      } catch (error) { fail(error) }
    }
  })
}

async function records(): Promise<Record[]> {
  const revision = privacyRevision()
  return transaction<Record[]>('readwrite', revision, (store, done) => {
    const request = store.getAll()
    request.onsuccess = () => {
      for (const record of request.result as Record[]) if (expired(record)) store.delete(record.id)
      done((request.result as Record[]).filter((record) => !expired(record)))
    }
  })
}

export async function listRecovery(): Promise<RecoveryEntry[]> {
  const revision = privacyRevision(), epoch = generation
  const entries: RecoveryEntry[] = []
  for (const record of (await records()).sort((a, b) => b.updated - a.updated)) {
    try {
      const bytes = await decryptPrivateBytes(record.encrypted, `openquire-recovery:${record.id}`, revision)
      try {
        const snapshot = unpack(bytes)
        entries.push({ id: record.id, updated: record.updated, name: snapshot.name })
        snapshot.bytes.fill(0)
      } finally { bytes.fill(0) }
    } catch {
      entries.push({ id: record.id, updated: record.updated, name: 'Unavailable checkpoint', unavailable: true })
    }
  }
  return current(epoch, revision) ? entries : []
}

export async function readRecovery(id: string): Promise<RecoverySnapshot> {
  const revision = privacyRevision(), epoch = generation
  const record = (await records()).find((item) => item.id === id)
  if (!record) throw new Error('This checkpoint has expired or was removed.')
  const bytes = await decryptPrivateBytes(record.encrypted, `openquire-recovery:${id}`, revision)
  try {
    if (!current(epoch, revision)) throw new Error('Private storage changed. Please retry.')
    return unpack(bytes)
  } finally { bytes.fill(0) }
}

export async function discardRecovery(id: string): Promise<void> {
  // Invalidate in-flight snapshots before removing their previous checkpoint.
  invalidateRecovery()
  await transaction<void>('readwrite', privacyRevision(), (store, done) => { store.delete(id); done() })
}

export async function clearRecovery(): Promise<void> {
  invalidateRecovery()
  await transaction<void>('readwrite', privacyRevision(), (store, done) => { store.clear(); done() })
}
