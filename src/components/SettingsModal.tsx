import { useState } from 'react'
import { ExternalLink, X } from 'lucide-react'

export type ThemeSetting = 'dark' | 'light' | 'system'

export interface Settings {
  theme: ThemeSetting
  accentHue: number
  author: string
}

export const ACCENTS: { name: string; hue: number }[] = [
  { name: 'Amber', hue: 32 },
  { name: 'Violet', hue: 258 },
  { name: 'Blue', hue: 212 },
  { name: 'Teal', hue: 172 },
  { name: 'Green', hue: 140 },
  { name: 'Rose', hue: 340 },
]

type Tab = 'appearance' | 'comments' | 'about'

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
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

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('appearance')
  const set = (p: Partial<Settings>) => onChange({ ...settings, ...p })
  const tabs: [Tab, string][] = [['appearance', 'Appearance'], ['comments', 'Comments'], ['about', 'About']]

  return (
    <div className="modal-container" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal-bg" onPointerDown={onClose} />
      <div className="modal settings" role="dialog" aria-label="Settings">
        <button className="clickable-icon modal-close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        <nav className="settings-nav">
          <div className="pane-heading">Options</div>
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'appearance' && (
            <>
              <h2>Appearance</h2>
              <Item name="Base color scheme" desc="Choose a light or dark theme, or follow your system.">
                <select value={settings.theme} onChange={(e) => set({ theme: e.target.value as ThemeSetting })}>
                  <option value="system">Adapt to system</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Item>
              <Item name="Accent color" desc="Used for the active tool, selections, links and primary buttons.">
                <div className="accent-swatches">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.hue} title={a.name} aria-label={a.name}
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
              <h2>Comments</h2>
              <Item name="Author name" desc="Shown on the comments, markup and replies you add.">
                <input
                  defaultValue={settings.author} placeholder="OpenQuire user"
                  onBlur={(e) => e.target.value.trim() !== settings.author && set({ author: e.target.value.trim() })}
                />
              </Item>
            </>
          )}
          {tab === 'about' && (
            <>
              <h2>About OpenQuire</h2>
              <Item name="Version" desc="A free, open source PDF suite. Files are processed on this device and never uploaded.">
                <span className="muted tnum">0.1.0</span>
              </Item>
              <Item name="License" desc="GNU Affero General Public License v3.0 or later. Built on MuPDF, Tesseract and node-forge.">
                <span className="muted">AGPL-3.0</span>
              </Item>
              <Item name="Source code" desc="Report issues and contribute on GitHub.">
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
