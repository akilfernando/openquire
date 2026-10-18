import { encryptSensitive, privacyRevision } from './privacy'

interface Credentials { aiKey: string; aiProfile: string; aiConnections?: string }
interface WriterOptions<T> {
  encrypt: (value: string) => Promise<string>
  write: (settings: T) => void
  privacyRevision: () => string
}

/** Only the latest requested settings may commit, including across a purge. */
export class SettingsWriter<T extends Credentials> {
  private revision = 0
  private options: WriterOptions<T>
  private originalCiphertexts: Set<string>

  constructor(options: Partial<WriterOptions<T>> & { initial?: Credentials } = {}) {
    this.originalCiphertexts = new Set([options.initial?.aiKey, options.initial?.aiProfile, options.initial?.aiConnections]
      .filter((value): value is string => typeof value === 'string' && value.startsWith('enc:v1:')))
    this.options = {
      encrypt: encryptSensitive,
      write: (settings) => localStorage.setItem('openquire.settings', JSON.stringify(settings)),
      privacyRevision,
      ...options,
    }
  }

  invalidate(): void { this.revision++ }

  async save(settings: T): Promise<void> {
    const revision = ++this.revision
    const privacy = this.options.privacyRevision()
    const current = () => revision === this.revision && privacy === this.options.privacyRevision()
    const encode = (value: string) => {
      // An unrelated edit can occur before initial credential hydration finishes.
      if (!value || this.originalCiphertexts.has(value)) return Promise.resolve(value)
      return this.options.encrypt(value.startsWith('raw:') ? value.slice(4) : value)
    }
    let encrypted: T
    try {
      const [aiKey, aiProfile, aiConnections] = await Promise.all([encode(settings.aiKey), encode(settings.aiProfile), encode(settings.aiConnections ?? '')])
      encrypted = { ...settings, aiKey, aiProfile, ...(settings.aiConnections !== undefined ? { aiConnections } : {}) }
    } catch {
      if (!current()) return
      this.options.write({ ...settings, aiKey: '', aiProfile: '', ...(settings.aiConnections !== undefined ? { aiConnections: '' } : {}) })
      throw new Error('Encrypted storage is unavailable. Credentials and profile are kept only for this session.')
    }
    if (current()) this.options.write(encrypted)
  }
}
