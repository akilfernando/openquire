import { describe, expect, it } from 'vitest'
import { forgetProvider, readProviderProfiles, rememberProvider, selectProvider, type ProfileSettings } from '../src/ai-profiles'
import { PROVIDERS, type AiProvider } from '../src/ai'

const initial: ProfileSettings = { aiProvider: 'openai', aiKey: 'legacy-key', aiModel: 'chosen-model', aiBaseUrl: 'https://custom.example/v1' }
describe('provider profiles', () => {
  it('preserves legacy active settings while separating every provider connection', () => {
    let settings = initial
    for (const provider of Object.keys(PROVIDERS) as AiProvider[]) {
      settings = selectProvider(settings, provider)
      settings = rememberProvider({ ...settings, aiKey: `${provider}-key`, aiModel: `${provider}-model`, aiBaseUrl: `${provider}-endpoint` })
    }
    for (const provider of Object.keys(PROVIDERS) as AiProvider[]) {
      settings = selectProvider(settings, provider)
      expect([settings.aiKey, settings.aiModel, settings.aiBaseUrl]).toEqual([`${provider}-key`, `${provider}-model`, `${provider}-endpoint`])
    }
    const switched = selectProvider(initial, 'gemini')
    expect(switched.aiKey).toBe('')
    expect(selectProvider(switched, 'openai')).toMatchObject(initial)
  })
  it('disconnect does not resurrect a key on later switches', () => {
    const other = { ...selectProvider(initial, 'gemini'), aiKey: 'gemini-key' }
    const disconnected = forgetProvider(selectProvider(other, 'openai'))
    expect(disconnected.aiKey).toBe('')
    expect(readProviderProfiles(disconnected.aiConnections).openai).toBeUndefined()
    const restored = selectProvider(disconnected, 'gemini')
    expect(restored.aiKey).toBe('gemini-key')
    expect(selectProvider(restored, 'openai').aiKey).toBe('')
  })
  it('ignores malformed, encrypted and unknown profile data', () => {
    for (const value of ['enc:v1:locked', 'null', '{', '{"openai":{"apiKey":42},"unknown":{"apiKey":"key"}}']) expect(readProviderProfiles(value)).toEqual({})
  })
})
