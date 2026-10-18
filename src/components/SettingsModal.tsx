import type { DiscoveredConnection } from '../ai-discovery'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { useFocusTrap } from '../focus'
import { m } from '../i18n'
import { OCR_LANGUAGES } from '../ocr-languages'
import { isDesktop, nativeTools, type NativeTools } from '../native'
import HotkeySettings from './HotkeySettings'
import PluginsSettings from './PluginsSettings'
import type { InstalledPlugin } from '../plugins/types'
import StyleSettings, { type Snippet, type UserCss } from './StyleSettings'
import type { AiProvider } from '../ai'
import { rememberProvider } from '../ai-profiles'
import AiConnections from './AiConnections'

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
  /** Encrypted provider-profile envelope on disk; JSON only in memory. */
  aiConnections?: string
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
  credentialsReady: boolean
  credentialStorageError: string
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
  discoveredConnection?: DiscoveredConnection
  initialTab?: Tab
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

export default function SettingsModal({ settings, credentialsReady, credentialStorageError, onChange, onPurge, onClose, readCertificates, commands, plugins, pluginErrors, onPlugins, onOpenWizard, discoveredConnection, initialTab = 'appearance' }: Props) {
  const set = (p: Partial<Settings>) => {
    const next = { ...settings, ...p }
    onChange(credentialsReady && ('aiKey' in p || 'aiModel' in p || 'aiBaseUrl' in p) ? rememberProvider(next) : next)
  }
  const [certError, setCertError] = useState('')
  const [purgeFeedback, setPurgeFeedback] = useState('')
  const [purgeError, setPurgeError] = useState('')
  const [purging, setPurging] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [detail, setDetail] = useState(initialTab === 'ai')
  const content = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const navScroll = useRef(0)
  const navigate = (next: Tab) => {
    navScroll.current = navigation.current?.scrollTop ?? 0
    setTab(next); setDetail(true)
    requestAnimationFrame(() => { content.current?.scrollTo(0, 0); content.current?.focus() })
  }
  const back = () => {
    setDetail(false)
    requestAnimationFrame(() => {
      navigation.current?.querySelector<HTMLButtonElement>(`[data-category="${tab}"]`)?.focus()
      if (navigation.current) navigation.current.scrollTop = navScroll.current
    })
  }
  const [installed, setInstalled] = useState<NativeTools | null>(null)
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
      <div ref={ref} className="modal settings" data-detail={detail} role="dialog" aria-modal="true" aria-label={m.settings.label}>
        <button className="clickable-icon modal-close" aria-label={m.actions.close} onClick={onClose}><X size={20} /></button>
        <nav ref={navigation} className="settings-nav" aria-label="Settings categories">
          <div className="settings-nav-heading">{m.settings.label}</div>
          {tabs.map(([k, label]) => (
            <button key={k} data-category={k} aria-current={tab === k ? 'page' : undefined} className={tab === k ? 'is-active' : ''} onClick={() => navigate(k)}><span>{label}</span><ChevronRight size={16} /></button>
          ))}
        </nav>
        <div ref={content} className="settings-content" tabIndex={-1} aria-label={m.settings.tabs[tab]}>
          <button className="settings-back quiet-action" onClick={back}><ArrowLeft size={16} />All settings</button>
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
              <details className="connection-details"><summary>Custom themes & CSS</summary>
                <StyleSettings themes={settings.themes} activeTheme={settings.activeTheme} snippets={settings.snippets} onChange={set} />
              </details>
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
              <Item name={m.settings.aiDisabled} desc="Hide AI features and prevent AI requests. Your saved connections are kept.">
                <input type="checkbox" className="toggle" checked={!!settings.aiDisabled} aria-label={m.settings.aiDisabled}
                  onChange={e => set({ aiDisabled: e.target.checked, aiEnabled: e.target.checked ? false : settings.aiEnabled })} />
              </Item>

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
          {tab === 'ai' && <AiConnections discoveredConnection={discoveredConnection} settings={settings} credentialsReady={credentialsReady}
            credentialStorageError={credentialStorageError} onChange={onChange}
            onPrivacy={() => navigate('privacy')}
            onAssistants={onOpenWizard ? () => { onClose(); onOpenWizard() } : undefined} />}
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

