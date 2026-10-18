import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { SettingsWriter } from '../src/settings-storage'

interface Settings {
  aiKey: string
  aiProfile: string
  theme: string
  aiConnections?: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const settings = (aiKey: string, aiProfile: string, theme: string): Settings => ({ aiKey, aiProfile, theme })

describe('SettingsWriter', () => {
  it('encrypts the whole profile envelope and clears it on storage failure', async () => {
    const writes: Settings[] = []
    const raw = { ...settings('key', 'bio', 'dark'), aiConnections: JSON.stringify({ openai: { apiKey: 'secret', model: 'private-model', baseUrl: 'private-endpoint' } }) }
    const writer = new SettingsWriter<Settings>({ encrypt: async () => 'enc:v1:cipher', write: value => writes.push(value), privacyRevision: () => 'same' })
    await writer.save(raw)
    assert.equal(writes[0].aiConnections, 'enc:v1:cipher')
    assert.equal(JSON.stringify(writes).includes('secret'), false)
    const failing = new SettingsWriter<Settings>({ encrypt: async () => { throw Error('unavailable') }, write: value => writes.push(value), privacyRevision: () => 'same' })
    await assert.rejects(failing.save(raw))
    assert.equal(writes[1].aiConnections, '')
  })
  it('preserves a locked envelope and prevents its delayed save after purge', async () => {
    const pending = deferred<string>()
    const writes: Settings[] = []
    const initial = { ...settings('', '', 'dark'), aiConnections: 'enc:v1:profiles' }
    const writer = new SettingsWriter<Settings>({ initial, encrypt: () => pending.promise, write: value => writes.push(value), privacyRevision: () => 'same' })
    await writer.save(initial)
    assert.equal(writes[0].aiConnections, initial.aiConnections)
    const saving = writer.save({ ...initial, aiConnections: 'new-profile-json' })
    writer.invalidate()
    pending.resolve('enc:v1:new-profiles')
    await saving
    assert.equal(writes.length, 1)
  })
  it('initializes with full preferences that contain non-string fields', async () => {
    const initial = { aiKey: 'enc:v1:stored-key', aiProfile: '', theme: 'dark', accentHue: 32, aiEnabled: true, trusted: [] }
    const writes: typeof initial[] = []
    const writer = new SettingsWriter<typeof initial>({
      initial,
      encrypt: async () => { throw new Error('Stored credentials must not be re-encrypted') },
      write: (value) => writes.push(value),
      privacyRevision: () => 'same',
    })
    await writer.save(initial)
    assert.deepEqual(writes, [initial])
  })
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
