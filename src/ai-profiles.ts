import { PROVIDERS, type AiProvider } from './ai'

export interface ProviderProfile { apiKey: string; model: string; baseUrl: string }
export type ProviderProfiles = Partial<Record<AiProvider, ProviderProfile>>
export interface ProfileSettings {
  aiProvider: AiProvider; aiKey: string; aiModel: string; aiBaseUrl: string
  /** JSON in memory, encrypted as one envelope by SettingsWriter on disk. */
  aiConnections?: string
}

export function readProviderProfiles(value = ''): ProviderProfiles {
  try {
    const parsed = JSON.parse(value)
    const profiles: ProviderProfiles = {}
    for (const provider of Object.keys(PROVIDERS) as AiProvider[]) {
      const entry = parsed?.[provider]
      if (entry && typeof entry.apiKey === 'string' && typeof entry.model === 'string' && typeof entry.baseUrl === 'string') {
        profiles[provider] = { apiKey: entry.apiKey, model: entry.model, baseUrl: entry.baseUrl }
      }
    }
    return profiles
  } catch { return {} }
}

/** Snapshot the departing connection; never carry its key to a different provider. */
export function selectProvider<T extends ProfileSettings>(settings: T, provider: AiProvider): T {
  if (provider === settings.aiProvider) return settings
  const profiles = readProviderProfiles(settings.aiConnections)
  profiles[settings.aiProvider] = { apiKey: settings.aiKey, model: settings.aiModel, baseUrl: settings.aiBaseUrl }
  const next = profiles[provider]
  return { ...settings, aiProvider: provider, aiKey: next?.apiKey ?? '', aiModel: next?.model ?? '', aiBaseUrl: next?.baseUrl ?? '', aiConnections: JSON.stringify(profiles) }
}

/** Forget only this provider. Other encrypted connections remain available. */
export function forgetProvider<T extends ProfileSettings>(settings: T): T {
  const profiles = readProviderProfiles(settings.aiConnections)
  delete profiles[settings.aiProvider]
  return { ...settings, aiKey: '', aiModel: '', aiBaseUrl: '', aiConnections: JSON.stringify(profiles) }
}

export function rememberProvider<T extends ProfileSettings>(settings: T): T {
  const profiles = readProviderProfiles(settings.aiConnections)
  profiles[settings.aiProvider] = { apiKey: settings.aiKey, model: settings.aiModel, baseUrl: settings.aiBaseUrl }
  return { ...settings, aiConnections: JSON.stringify(profiles) }
}
