import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { SettingsWriter } from '../src/settings-storage'

interface Settings {
  aiKey: string
  aiProfile: string
  theme: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const settings = (aiKey: string, aiProfile: string, theme: string): Settings => ({ aiKey, aiProfile, theme })

describe('SettingsWriter', () => {
  it('commits only the latest save when encryption finishes out of order', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>()
    const writes: Settings[] = []
    const writer = new SettingsWriter<Settings>({
      encrypt: (value) => {
        const job = deferred<string>()
        pending.set(value, job)
        return job.promise
      },
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })

    const older = writer.save(settings('raw:old-key', 'raw:old-profile', 'old'))
    const newer = writer.save(settings('raw:new-key', 'raw:new-profile', 'new'))
    pending.get('new-key')!.resolve('enc:v1:new-key')
    pending.get('new-profile')!.resolve('enc:v1:new-profile')
    await newer
    pending.get('old-key')!.resolve('enc:v1:old-key')
    pending.get('old-profile')!.resolve('enc:v1:old-profile')
    await older

    assert.deepEqual(writes, [settings('enc:v1:new-key', 'enc:v1:new-profile', 'new')])
  })

  it('does not commit a pending save after invalidation', async () => {
    const key = deferred<string>()
    const profile = deferred<string>()
    const writes: Settings[] = []
    const writer = new SettingsWriter<Settings>({
      encrypt: (value) => value === 'key' ? key.promise : profile.promise,
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })

    const save = writer.save(settings('raw:key', 'raw:profile', 'before-purge'))
    writer.invalidate()
    key.resolve('enc:v1:key')
    profile.resolve('enc:v1:profile')
    await save

    assert.deepEqual(writes, [])
  })

  it('does not commit when the privacy revision changes during encryption', async () => {
    const key = deferred<string>()
    const profile = deferred<string>()
    const writes: Settings[] = []
    let privacy = 'revision-1'
    const writer = new SettingsWriter<Settings>({
      encrypt: (value) => value === 'key' ? key.promise : profile.promise,
      write: (value) => writes.push(value),
      privacyRevision: () => privacy,
    })

    const save = writer.save(settings('raw:key', 'raw:profile', 'private'))
    privacy = 'revision-2'
    key.resolve('enc:v1:key')
    profile.resolve('enc:v1:profile')
    await save

    assert.deepEqual(writes, [])
  })

  it('clears credentials before rejecting when encryption fails', async () => {
    const writes: Settings[] = []
    const writer = new SettingsWriter<Settings>({
      encrypt: async () => { throw new Error('crypto failed') },
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })
    const raw = settings('raw:secret-key', 'raw:private-profile', 'dark')

    await assert.rejects(writer.save(raw), {
      message: 'Encrypted storage is unavailable. Credentials and profile are kept only for this session.',
    })
    assert.deepEqual(writes, [settings('', '', 'dark')])
    assert.equal(JSON.stringify(writes).includes('secret-key'), false)
    assert.equal(JSON.stringify(writes).includes('private-profile'), false)
  })

  it('ignores an encryption failure from a superseded save', async () => {
    const oldKey = deferred<string>()
    const oldProfile = deferred<string>()
    const writes: Settings[] = []
    const writer = new SettingsWriter<Settings>({
      encrypt: (value) => value.startsWith('old-')
        ? (value === 'old-key' ? oldKey.promise : oldProfile.promise)
        : Promise.resolve(`enc:v1:${value}`),
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })

    const stale = writer.save(settings('raw:old-key', 'raw:old-profile', 'stale'))
    const latest = writer.save(settings('raw:new-key', 'raw:new-profile', 'latest'))
    await latest
    oldKey.reject(new Error('old encryption failed'))
    oldProfile.resolve('enc:v1:old-profile')
    await assert.doesNotReject(stale)

    assert.deepEqual(writes, [settings('enc:v1:new-key', 'enc:v1:new-profile', 'latest')])
  })

  it('preserves initial ciphertexts during an unrelated preference edit', async () => {
    const original = settings('enc:v1:stored-key', 'enc:v1:stored-profile', 'light')
    const writes: Settings[] = []
    const encryptCalls: string[] = []
    const writer = new SettingsWriter<Settings>({
      initial: original,
      encrypt: async (value) => { encryptCalls.push(value); return `enc:v1:${value}` },
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })

    await writer.save({ ...original, theme: 'dark' })

    assert.deepEqual(encryptCalls, [])
    assert.deepEqual(writes, [{ ...original, theme: 'dark' }])
  })

  it('encrypts a new user value that looks like ciphertext but is not whitelisted', async () => {
    const writes: Settings[] = []
    const encryptCalls: string[] = []
    const writer = new SettingsWriter<Settings>({
      initial: settings('enc:v1:existing-key', '', 'light'),
      encrypt: async (value) => { encryptCalls.push(value); return 'enc:v1:encrypted-user-value' },
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })

    await writer.save(settings('enc:v1:user-entered-value', '', 'light'))

    assert.deepEqual(encryptCalls, ['enc:v1:user-entered-value'])
    assert.deepEqual(writes, [settings('enc:v1:encrypted-user-value', '', 'light')])
  })
})
