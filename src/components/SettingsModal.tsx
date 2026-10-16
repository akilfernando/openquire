import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, X } from 'lucide-react'
import { useFocusTrap } from '../focus'
import { m } from '../i18n'
import { OCR_LANGUAGES } from '../ocr-languages'
import { isDesktop, nativeTools, type NativeTools } from '../native'
import HotkeySettings from './HotkeySettings'
import PluginsSettings from './PluginsSettings'
import type { InstalledPlugin } from '../plugins/types'
import StyleSettings, { type Snippet, type UserCss } from './StyleSettings'
import { DEFAULT_BASE_URL, DEFAULT_MODELS, detectProviderFromKey, fetchAvailableModels, formatAndRankModels, pickOptimalModel, verifyApiKey, type AiProvider, type ApiKeyVerification } from '../ai'

export type ThemeSetting = 'dark' | 'light' | 'system'

export interface Settings {
  theme: ThemeSetting
  accentHue: number
  author: string
  /** Timestamp server URL; empty turns timestamps off. */
  tsa: string
  /** Whether to strictly enforce air-gapped signing (blocking external TSA/OCSP). */
  airGappedSign?: boolean
  /** Certificates the user trusts, as PEM with a display name. */
  trusted: { pem: string; name: string; issuer: string; expires: string }[]
  /** OCR language code, or 'auto'. */
  ocrLang: string
  /** Whether OCR language packs other than English may be downloaded. */
  ocrDownload: boolean
  /** Whether skewed pages are straightened before text is recognized. */
  ocrStraighten: boolean
  /** Desktop app: use installed LibreOffice and Tesseract when present. */
  nativeTools: boolean
  /** Shortcut changes by command id, on top of the defaults. */
  hotkeys: Record<string, string[]>
  /** Imported themes, the one in use ('' for the built-in look), and CSS snippets. */
  themes: UserCss[]
  activeTheme: string
  snippets: Snippet[]
  /** The optional AI assistant: off unless turned on. */
  aiEnabled: boolean
  aiProvider: AiProvider
  /** Kept on this device only. */
  aiKey: string
  aiModel: string
  aiBaseUrl: string
  /** Facts about the user for filling forms, sent only when they ask. */
  aiProfile: string
  /** Air-gapped privacy mode: completely disables/hides all AI features and settings. */
  aiDisabled?: boolean
  /** Explicit consent to encrypted document checkpoints on this device. Default off. */
  recoveryEnabled?: boolean
}

export const ACCENTS: { key: string; hue: number }[] = [
  { key: 'amber', hue: 32 },
  { key: 'violet', hue: 258 },
  { key: 'blue', hue: 212 },
  { key: 'teal', hue: 172 },
  { key: 'green', hue: 140 },
  { key: 'rose', hue: 340 },
]

type Tab = 'appearance' | 'comments' | 'ocr' | 'signatures' | 'privacy' | 'ai' | 'hotkeys' | 'plugins' | 'about'

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
  onPurge: () => Promise<void>
  onClose: () => void
  /** Commands that can have shortcuts. */
  commands: { id: string; name: string }[]
  plugins: InstalledPlugin[]
  pluginErrors: Map<string, string>
  onPlugins: (list: InstalledPlugin[]) => void
  /** Reads certificate files into displayable entries. */
  readCertificates: (data: Uint8Array) => Promise<Settings['trusted']>
  onOpenWizard?: () => void
}

function Item({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-item">
      <div className="setting-info">
        <div className="setting-name">{name}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export default function SettingsModal({ settings, onChange, onPurge, onClose, readCertificates, commands, plugins, pluginErrors, onPlugins, onOpenWizard }: Props) {
  const set = (p: Partial<Settings>) => onChange({ ...settings, ...p })
  const [certError, setCertError] = useState('')
  const [purgeFeedback, setPurgeFeedback] = useState('')
  const [purgeError, setPurgeError] = useState('')
  const [purging, setPurging] = useState(false)
  const [copiedMcp, setCopiedMcp] = useState(false)
  const [tab, setTab] = useState<Tab>('appearance')
  const [installed, setInstalled] = useState<NativeTools | null>(null)
  const [modelList, setModelList] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [detectedNotice, setDetectedNotice] = useState('')
  const [keyVerification, setKeyVerification] = useState<ApiKeyVerification | null>(null)
  const [verifyingKey, setVerifyingKey] = useState(false)

  const handleVerify = useCallback(async (provider: AiProvider, apiKey: string, baseUrl: string) => {
    setVerifyingKey(true)
    try {
      const res = await verifyApiKey({ provider, apiKey, baseUrl })
      setKeyVerification(res)
    } finally {
      setVerifyingKey(false)
    }
  }, [])

  // Read current settings when a request completes without making renders re-trigger it.
  const latestAi = useRef({ settings, onChange, isCustomModel })
  latestAi.current = { settings, onChange, isCustomModel }
  const modelRequest = useRef(0)
  const refreshModels = useCallback(async (provider: AiProvider, apiKey: string, baseUrl: string) => {
    const request = ++modelRequest.current
    setLoadingModels(true)
    try {
      const list = await fetchAvailableModels({ provider, apiKey, baseUrl })
      const latest = latestAi.current
      if (request !== modelRequest.current || !latest.settings.aiEnabled || latest.settings.aiDisabled ||
          provider !== latest.settings.aiProvider || apiKey !== latest.settings.aiKey || baseUrl !== latest.settings.aiBaseUrl) return
      setModelList(list)
      const optimal = pickOptimalModel(provider, list)
      if ((!latest.settings.aiModel || (!list.includes(latest.settings.aiModel) && !latest.isCustomModel)) &&
          optimal !== latest.settings.aiModel) {
        latest.onChange({ ...latest.settings, aiModel: optimal })
      }
    } finally {
      if (request === modelRequest.current) setLoadingModels(false)
    }
  }, [])

  useEffect(() => () => { modelRequest.current++ }, [])
  useEffect(() => {
    if (tab === 'ai' && settings.aiEnabled && !settings.aiDisabled) {
      void refreshModels(settings.aiProvider, settings.aiKey, settings.aiBaseUrl)
    }
  }, [tab, settings.aiEnabled, settings.aiDisabled, settings.aiProvider, settings.aiKey, settings.aiBaseUrl, refreshModels])
  // Escape closes Settings wherever focus is, even after the focused control went away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a shortcut is being recorded, Escape cancels the recording instead.
      if (e.key !== 'Escape' || e.defaultPrevented || (e.target as Element).closest?.('[data-recording-hotkey]')) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  useEffect(() => {
    if (isDesktop) void nativeTools().then(setInstalled)
  }, [])
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  const tabs = Object.entries(m.settings.tabs) as [Tab, string][]

  return (
    <div className="modal-container">
      <div className="modal-bg" onPointerDown={onClose} />
      <div ref={ref} className="modal settings" role="dialog" aria-modal="true" aria-label={m.settings.label}>
        <button className="clickable-icon modal-close" aria-label={m.actions.close} onClick={onClose}><X size={20} /></button>
        <nav className="settings-nav">
          <div className="pane-heading">{m.settings.options}</div>
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'appearance' && (
            <>
              <h2>{m.settings.tabs.appearance}</h2>
              <Item name={m.settings.scheme} desc={m.settings.schemeDesc}>
                <select aria-label={m.settings.scheme} value={settings.theme} onChange={(e) => set({ theme: e.target.value as ThemeSetting })}>
                  <option value="system">{m.settings.schemes.system}</option>
                  <option value="dark">{m.settings.schemes.dark}</option>
                  <option value="light">{m.settings.schemes.light}</option>
                </select>
              </Item>
              <Item name={m.settings.accent} desc={m.settings.accentDesc}>
                <div className="accent-swatches">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.hue} title={m.settings.accents[a.key]} aria-label={m.settings.accents[a.key]} aria-pressed={settings.accentHue === a.hue}
                      className={settings.accentHue === a.hue ? 'is-active' : ''}
                      style={{ background: `hsl(${a.hue}, 88%, 60%)` }}
                      onClick={() => set({ accentHue: a.hue })}
                    />
                  ))}
                </div>
              </Item>
              <StyleSettings themes={settings.themes} activeTheme={settings.activeTheme} snippets={settings.snippets} onChange={set} />
            </>
          )}
          {tab === 'comments' && (
            <>
              <h2>{m.settings.tabs.comments}</h2>
              <Item name={m.settings.author} desc={m.settings.authorDesc}>
                <input
                  defaultValue={settings.author} placeholder={m.settings.authorPlaceholder} aria-label={m.settings.author}
                  onBlur={(e) => e.target.value.trim() !== settings.author && set({ author: e.target.value.trim() })}
                />
              </Item>
            </>
          )}
          {tab === 'ocr' && (
            <>
              <h2>{m.settings.tabs.ocr}</h2>
              <Item name={m.settings.ocrLang} desc={m.settings.ocrLangDesc}>
                <select value={settings.ocrLang} aria-label={m.settings.ocrLang} onChange={(e) => set({ ocrLang: e.target.value })}>
                  <option value="auto">{m.settings.ocrAuto}</option>
                  {OCR_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{m.settings.languages[l.code] ?? l.code}</option>)}
                </select>
              </Item>
              <Item name={m.settings.ocrDownload} desc={m.settings.ocrDownloadDesc}>
                <input type="checkbox" className="toggle" checked={settings.ocrDownload} aria-label={m.settings.ocrDownload} onChange={(e) => set({ ocrDownload: e.target.checked })} />
              </Item>
              {isDesktop && (
                <Item name={m.settings.nativeTools} desc={m.settings.nativeToolsDesc(installed)}>
                  <input type="checkbox" className="toggle" checked={settings.nativeTools} aria-label={m.settings.nativeTools} onChange={(e) => set({ nativeTools: e.target.checked })} />
                </Item>
              )}
              <Item name={m.settings.ocrStraighten} desc={m.settings.ocrStraightenDesc}>
                <input type="checkbox" className="toggle" checked={settings.ocrStraighten} aria-label={m.settings.ocrStraighten} onChange={(e) => set({ ocrStraighten: e.target.checked })} />
              </Item>
            </>
          )}
          {tab === 'signatures' && (
            <>
              <h2>{m.settings.tabs.signatures}</h2>
              <Item name={m.settings.tsa} desc={m.settings.tsaDesc}>
                <input defaultValue={settings.tsa} placeholder="https://rfc3161.ai.moda" aria-label={m.settings.tsa} style={{ width: 240 }}
                  onBlur={(e) => e.target.value.trim() !== settings.tsa && set({ tsa: e.target.value.trim() })} />
              </Item>
              <Item name={m.settings.trusted} desc={m.settings.trustedDesc}>
                <label className="file-button">
                  <input type="file" hidden accept=".cer,.crt,.pem,.der,application/x-x509-ca-cert,application/pkix-cert"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (!f) return
                      try {
                        setCertError('')
                        const certs = await readCertificates(new Uint8Array(await f.arrayBuffer()))
                        const known = new Set(settings.trusted.map((c) => c.pem))
                        set({ trusted: [...settings.trusted, ...certs.filter((c) => !known.has(c.pem))] })
                      } catch (err) {
                        setCertError((err as Error).message)
                      }
                    }} />
                  <span className="button-like">{m.settings.importCert}</span>
                </label>
              </Item>
              {certError && <p className="error small">{certError}</p>}
              {!settings.trusted.length && <p className="hint">{m.settings.noTrusted}</p>}
              {settings.trusted.map((c) => (
                <div key={c.pem} className="setting-item">
                  <div className="setting-info">
                    <div className="setting-name">{c.name}</div>
                    <div className="setting-desc">{c.issuer} · {m.settings.expires(new Date(c.expires).toLocaleDateString())}</div>
                  </div>
                  <button onClick={() => set({ trusted: settings.trusted.filter((x) => x.pem !== c.pem) })}>{m.settings.removeCert}</button>
                </div>
              ))}
            </>
          )}
          {tab === 'privacy' && (
            <>
              <h2>{m.settings.tabs.privacy}</h2>
              <p className="hint">{m.settings.privacyIntro}</p>

              <Item name="Encrypted document recovery" desc="Off by default. Keep the newest 3 unsaved document checkpoints on this device for up to 7 days (16 MiB per document, 32 MiB total). Checkpoints may lag your edits. Password-protected documents are skipped. Turning this off removes checkpoints; it does not save your files.">
                <input type="checkbox" className="toggle" checked={!!settings.recoveryEnabled}
                  aria-label="Encrypted document recovery" onChange={(e) => set({ recoveryEnabled: e.target.checked })} />
              </Item>

              <Item name={m.settings.airGapped} desc={m.settings.airGappedDesc}>
                <input
                  type="checkbox"
                  className="toggle"
                  checked={!!settings.airGappedSign}
                  aria-label={m.settings.airGapped}
                  onChange={(e) => set({ airGappedSign: e.target.checked })}
                />
              </Item>

              <Item name={m.settings.storageEncryption} desc={m.settings.storageEncryptionDesc}>
                <span className="badge" style={{ padding: '3px 8px', borderRadius: 4, background: 'var(--panel)', fontSize: '0.85rem', color: 'var(--accent)', border: '1px solid var(--border)' }}>
                  Required for saved credentials
                </span>
              </Item>

              <Item name={m.settings.memoryZeroize} desc={m.settings.memoryZeroizeDesc}>
                <span className="badge" style={{ padding: '3px 8px', borderRadius: 4, background: 'var(--panel)', fontSize: '0.85rem', color: 'var(--accent)', border: '1px solid var(--border)' }}>
                  Active (RAM &amp; Key Zeroization)
                </span>
              </Item>

              <div className="setting-item stacked" style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }}>
                <div className="setting-info">
                  <div className="setting-name" style={{ color: '#e53935' }}>{m.settings.purgeData}</div>
                  <div className="setting-desc">{m.settings.purgeDataDesc}</div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={purging}
                    style={{ background: '#e53935', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', cursor: 'pointer', fontWeight: 500 }}
                    onClick={async () => {
                      if (window.confirm('Are you sure you want to purge all stored signatures, recent files, saved AI keys, and recovery checkpoints from this browser?')) {
                        setPurging(true)
                        setPurgeFeedback('')
                        setPurgeError('')
                        try {
                          await onPurge()
                          setPurgeFeedback(m.settings.purgedSuccess)
                        } catch (error) {
                          setPurgeError(error instanceof Error ? error.message : 'Private data could not be deleted. Please retry.')
                        } finally {
                          setPurging(false)
                        }
                      }
                    }}
                  >
                    {m.settings.purgeDataBtn}
                  </button>
                  {purgeFeedback && <p className="success small" style={{ marginTop: 8, color: 'var(--accent)', fontWeight: 500 }}>{purgeFeedback}</p>}
                  {purgeError && <p role="alert" className="error small">{purgeError}</p>}
                </div>
              </div>
            </>
          )}
          {tab === 'ai' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <h2 style={{ margin: 0 }}>{m.settings.tabs.ai}</h2>
                {onOpenWizard && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onOpenWizard()
                    }}
                    style={{ padding: '4px 10px', fontSize: '0.8rem', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)' }}
                  >
                    {m.settings.openOnboardingWizard}
                  </button>
                )}
              </div>

              <Item name={m.settings.aiDisabled} desc={m.settings.aiDisabledDesc}>
                <input
                  type="checkbox"
                  className="toggle"
                  checked={settings.aiDisabled ?? false}
                  aria-label={m.settings.aiDisabled}
                  onChange={(e) => set({ aiDisabled: e.target.checked, aiEnabled: e.target.checked ? false : settings.aiEnabled })}
                />
              </Item>

              {settings.aiDisabled ? (
                <div className="hint" style={{ padding: '12px 14px', background: 'var(--panel)', borderRadius: 6, margin: '14px 0', border: '1px solid var(--border)', lineHeight: 1.45 }}>
                  <strong>Air-Gapped Mode Active:</strong> All AI features (sidebars, form suggestions, and network LLM prompts) are completely disabled. Uncheck above to re-enable.
                </div>
              ) : (
                <>
                  <Item name={m.settings.aiEnabled} desc={m.settings.aiEnabledDesc}>
                    <input type="checkbox" className="toggle" checked={settings.aiEnabled} aria-label={m.settings.aiEnabled} onChange={(e) => set({ aiEnabled: e.target.checked })} />
                  </Item>
              {settings.aiEnabled && (
                <>
                  <Item name={m.settings.aiProvider} desc={m.settings.aiProviderDesc}>
                    <select value={settings.aiProvider} aria-label={m.settings.aiProvider} onChange={(e) => set({ aiProvider: e.target.value as AiProvider, aiModel: '' })}>
                      <option value="anthropic">{m.settings.aiProviders.anthropic}</option>
                      <option value="openai">{m.settings.aiProviders.openai}</option>
                      <option value="ollama">{m.settings.aiProviders.ollama}</option>
                    </select>
                  </Item>
                  {settings.aiProvider === 'ollama' && (
                    <div className="hint" style={{ padding: '8px 12px', background: 'var(--panel)', borderRadius: 6, margin: '8px 0', border: '1px solid var(--border)' }}>
                      <strong>100% Offline &amp; Private:</strong> Runs against your local Ollama instance ({DEFAULT_BASE_URL}). Zero data is sent to external servers.
                    </div>
                  )}
                  {settings.aiProvider !== 'ollama' && (
                    <div className="hint" style={{ padding: '8px 12px', background: 'var(--panel)', borderRadius: 6, margin: '8px 0', border: '1px solid var(--border)' }}>
                      <strong>Data in flight:</strong> OpenQuire sends form fields or document text over HTTPS only when you explicitly trigger an AI action.
                    </div>
                  )}
                  {(settings.aiProvider === 'openai' || settings.aiProvider === 'ollama') && (
                    <Item name={m.settings.aiBaseUrl} desc={m.settings.aiBaseUrlDesc}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 260 }}>
                        <input
                          defaultValue={settings.aiBaseUrl}
                          placeholder={DEFAULT_BASE_URL}
                          aria-label={m.settings.aiBaseUrl}
                          style={{ flex: 1 }}
                          onBlur={(e) => {
                            const val = e.target.value.trim()
                            if (val !== settings.aiBaseUrl) {
                              set({ aiBaseUrl: val })
                              setKeyVerification(null)
                            }
                          }}
                        />
                        {settings.aiProvider === 'ollama' && (
                          <button
                            type="button"
                            disabled={verifyingKey}
                            style={{ padding: '5px 10px', fontSize: '0.8rem', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', whiteSpace: 'nowrap' }}
                            onClick={() => void handleVerify('ollama', '', settings.aiBaseUrl)}
                          >
                            {verifyingKey ? '...' : 'Test'}
                          </button>
                        )}
                      </div>
                    </Item>
                  )}
                  <Item name={m.settings.aiKey} desc={settings.aiProvider === 'anthropic' ? m.settings.aiKeyDesc : m.settings.aiKeyOptional}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 260 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="password"
                          autoComplete="off"
                          defaultValue={settings.aiKey}
                          aria-label={m.settings.aiKey}
                          style={{ flex: 1 }}
                          onChange={(e) => {
                            const val = e.target.value.trim()
                            setKeyVerification(null)
                            const detected = detectProviderFromKey(val)
                            if (detected && detected !== settings.aiProvider) {
                              const optimal = DEFAULT_MODELS[detected]
                              set({ aiKey: val, aiProvider: detected, aiModel: optimal })
                              setDetectedNotice(`Auto-detected ${detected === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'} from key prefix!`)
                            }
                          }}
                          onBlur={(e) => {
                            const val = e.target.value.trim()
                            if (val !== settings.aiKey) {
                              set({ aiKey: val })
                              setKeyVerification(null)
                            }
                          }}
                        />
                        <button
                          type="button"
                          disabled={verifyingKey || (!settings.aiKey && settings.aiProvider !== 'ollama')}
                          style={{ padding: '5px 10px', fontSize: '0.8rem', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', whiteSpace: 'nowrap' }}
                          onClick={() => void handleVerify(settings.aiProvider, settings.aiKey, settings.aiBaseUrl)}
                        >
                          {verifyingKey ? '...' : 'Verify'}
                        </button>
                      </div>
                      {detectedNotice && (
                        <span style={{ fontSize: '0.78rem', color: 'var(--accent)', fontWeight: 500 }}>
                          {detectedNotice}
                        </span>
                      )}
                      {keyVerification && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            fontSize: '0.78rem',
                            color: keyVerification.ok ? '#2e7d32' : '#d32f2f',
                            fontWeight: 500,
                            lineHeight: 1.3,
                            marginTop: 2,
                          }}
                        >
                          {keyVerification.ok ? <CheckCircle2 size={13} style={{ flexShrink: 0 }} /> : <AlertCircle size={13} style={{ flexShrink: 0 }} />}
                          <span>{keyVerification.message}</span>
                        </div>
                      )}
                    </div>
                  </Item>
                  <Item name={m.settings.aiModel} desc={m.settings.aiModelDesc}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 240 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <select
                          value={isCustomModel ? '__custom__' : (settings.aiModel || DEFAULT_MODELS[settings.aiProvider])}
                          aria-label={m.settings.aiModel}
                          style={{ flex: 1 }}
                          onChange={(e) => {
                            if (e.target.value === '__custom__') {
                              setIsCustomModel(true)
                            } else {
                              setIsCustomModel(false)
                              set({ aiModel: e.target.value })
                            }
                          }}
                        >
                          {formatAndRankModels(settings.aiProvider, modelList).map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                          <option value="__custom__">Custom model name...</option>
                        </select>
                        <button
                          type="button"
                          title="Refresh active models"
                          disabled={loadingModels}
                          style={{ padding: '4px 8px', fontSize: '0.85rem', cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)' }}
                          onClick={() => void refreshModels(settings.aiProvider, settings.aiKey, settings.aiBaseUrl)}
                        >
                          {loadingModels ? '...' : '↻'}
                        </button>
                      </div>
                      {isCustomModel && (
                        <input
                          defaultValue={settings.aiModel}
                          placeholder="e.g. gpt-4o, claude-3-5-sonnet-latest"
                          aria-label="Custom model name"
                          onBlur={(e) => set({ aiModel: e.target.value.trim() })}
                        />
                      )}
                    </div>
                  </Item>
                  <div className="setting-item stacked">
                    <div className="setting-info">
                      <div className="setting-name">{m.settings.aiProfile}</div>
                      <div className="setting-desc">{m.settings.aiProfileDesc}</div>
                    </div>
                    <textarea rows={5} defaultValue={settings.aiProfile} placeholder={m.settings.aiProfilePlaceholder} aria-label={m.settings.aiProfile}
                      onBlur={(e) => e.target.value !== settings.aiProfile && set({ aiProfile: e.target.value })} />
                  </div>
                </>
              )}

              <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>{m.settings.claudeDesktopTitle}</h3>
                  <span className="badge" style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--panel)', fontSize: '0.75rem', color: 'var(--accent)', border: '1px solid var(--border)' }}>
                    Model Context Protocol
                  </span>
                </div>
                <p className="hint" style={{ margin: '4px 0 12px 0' }}>{m.settings.claudeDesktopDesc}</p>
                <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 8 }}>
                    {m.settings.claudeDesktopCommandHint}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ flex: 1, padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: '0.82rem', fontFamily: 'monospace', overflowX: 'auto', whiteSpace: 'nowrap' }}>
                      npx -y openquire mcp setup
                    </code>
                    <button
                      type="button"
                      style={{ padding: '6px 14px', fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
                      onClick={() => {
                        void navigator.clipboard.writeText('npx -y openquire mcp setup')
                        setCopiedMcp(true)
                        setTimeout(() => setCopiedMcp(false), 3000)
                      }}
                    >
                      {copiedMcp ? '✔ Copied!' : m.settings.claudeDesktopCopyCmd}
                    </button>
                  </div>
                  {copiedMcp && <p className="success small" style={{ margin: '8px 0 0 0', color: 'var(--accent)', fontSize: '0.8rem', fontWeight: 500 }}>{m.settings.claudeDesktopCopied}</p>}
                </div>
              </div>
                </>
              )}
            </>
          )}
          {tab === 'hotkeys' && <HotkeySettings commands={commands} overrides={settings.hotkeys} onChange={(hotkeys) => set({ hotkeys })} />}
          {tab === 'plugins' && <PluginsSettings plugins={plugins} errors={pluginErrors} onChange={onPlugins} />}
          {tab === 'about' && (
            <>
              <h2>{m.settings.about}</h2>
              <Item name={m.settings.version} desc={m.app.tagline}>
                <span className="muted tnum">0.1.0</span>
              </Item>
              <Item name={m.settings.license} desc={m.settings.licenseDesc}>
                <span className="muted">AGPL-3.0</span>
              </Item>
              <Item name={m.settings.source} desc={m.settings.sourceDesc}>
                <a href="https://github.com/akilfernando/openquire" target="_blank" rel="noreferrer" className="row" style={{ alignItems: 'center', gap: 4 }}>
                  akilfernando/openquire <ExternalLink size={14} />
                </a>
              </Item>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

