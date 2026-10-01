import { useRef, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { useFocusTrap } from '../focus'
import { m } from '../i18n'
import { OCR_LANGUAGES } from '../ocr-languages'
import { DEFAULT_BASE_URL, DEFAULT_MODELS, type AiProvider } from '../ai'

export type ThemeSetting = 'dark' | 'light' | 'system'

export interface Settings {
  theme: ThemeSetting
  accentHue: number
  author: string
  /** Timestamp server URL; empty turns timestamps off. */
  tsa: string
  /** Certificates the user trusts, as PEM with a display name. */
  trusted: { pem: string; name: string; issuer: string; expires: string }[]
  /** OCR language code, or 'auto'. */
  ocrLang: string
  /** Whether OCR language packs other than English may be downloaded. */
  ocrDownload: boolean
  /** Whether skewed pages are straightened before text is recognized. */
  ocrStraighten: boolean
  /** The optional AI assistant: off unless turned on. */
  aiEnabled: boolean
  aiProvider: AiProvider
  /** Kept on this device only. */
  aiKey: string
  aiModel: string
  aiBaseUrl: string
  /** Facts about the user for filling forms, sent only when they ask. */
  aiProfile: string
}

export const ACCENTS: { key: string; hue: number }[] = [
  { key: 'amber', hue: 32 },
  { key: 'violet', hue: 258 },
  { key: 'blue', hue: 212 },
  { key: 'teal', hue: 172 },
  { key: 'green', hue: 140 },
  { key: 'rose', hue: 340 },
]

type Tab = 'appearance' | 'comments' | 'ocr' | 'signatures' | 'ai' | 'about'

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
  /** Reads certificate files into displayable entries. */
  readCertificates: (data: Uint8Array) => Promise<Settings['trusted']>
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

export default function SettingsModal({ settings, onChange, onClose, readCertificates }: Props) {
  const [certError, setCertError] = useState('')
  const [tab, setTab] = useState<Tab>('appearance')
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  const set = (p: Partial<Settings>) => onChange({ ...settings, ...p })
  const tabs = Object.entries(m.settings.tabs) as [Tab, string][]

  return (
    <div className="modal-container" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal-bg" onPointerDown={onClose} />
      <div ref={ref} className="modal settings" role="dialog" aria-modal="true" aria-label={m.settings.label}>
        <button className="clickable-icon modal-close" aria-label={m.actions.close} onClick={onClose}><X size={18} /></button>
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
          {tab === 'ai' && (
            <>
              <h2>{m.settings.tabs.ai}</h2>
              <Item name={m.settings.aiEnabled} desc={m.settings.aiEnabledDesc}>
                <input type="checkbox" className="toggle" checked={settings.aiEnabled} aria-label={m.settings.aiEnabled} onChange={(e) => set({ aiEnabled: e.target.checked })} />
              </Item>
              {settings.aiEnabled && (
                <>
                  <Item name={m.settings.aiProvider} desc={m.settings.aiProviderDesc}>
                    <select value={settings.aiProvider} aria-label={m.settings.aiProvider} onChange={(e) => set({ aiProvider: e.target.value as AiProvider, aiModel: '' })}>
                      <option value="anthropic">{m.settings.aiProviders.anthropic}</option>
                      <option value="openai">{m.settings.aiProviders.openai}</option>
                    </select>
                  </Item>
                  {settings.aiProvider === 'openai' && (
                    <Item name={m.settings.aiBaseUrl} desc={m.settings.aiBaseUrlDesc}>
                      <input defaultValue={settings.aiBaseUrl} placeholder={DEFAULT_BASE_URL} aria-label={m.settings.aiBaseUrl} style={{ width: 240 }}
                        onBlur={(e) => e.target.value.trim() !== settings.aiBaseUrl && set({ aiBaseUrl: e.target.value.trim() })} />
                    </Item>
                  )}
                  <Item name={m.settings.aiKey} desc={settings.aiProvider === 'anthropic' ? m.settings.aiKeyDesc : m.settings.aiKeyOptional}>
                    <input type="password" autoComplete="off" defaultValue={settings.aiKey} aria-label={m.settings.aiKey} style={{ width: 240 }}
                      onBlur={(e) => e.target.value.trim() !== settings.aiKey && set({ aiKey: e.target.value.trim() })} />
                  </Item>
                  <Item name={m.settings.aiModel} desc={m.settings.aiModelDesc}>
                    <input key={settings.aiProvider} defaultValue={settings.aiModel} placeholder={DEFAULT_MODELS[settings.aiProvider]} aria-label={m.settings.aiModel} style={{ width: 240 }}
                      onBlur={(e) => e.target.value.trim() !== settings.aiModel && set({ aiModel: e.target.value.trim() })} />
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
            </>
          )}
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
