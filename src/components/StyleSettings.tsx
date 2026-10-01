import { useState } from 'react'
import { Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { m } from '../i18n'

export interface UserCss {
  name: string
  css: string
}

export interface Snippet extends UserCss {
  enabled: boolean
}

interface Props {
  themes: UserCss[]
  activeTheme: string
  snippets: Snippet[]
  onChange: (p: { themes?: UserCss[]; activeTheme?: string; snippets?: Snippet[] }) => void
}

const readCss = (accept: (name: string, css: string) => void) => async (e: React.ChangeEvent<HTMLInputElement>) => {
  const f = e.target.files?.[0]
  e.target.value = ''
  if (f) accept(f.name.replace(/\.css$/i, ''), await f.text())
}

/** Community-style themes and CSS snippets, layered on the app's design tokens. */
export default function StyleSettings({ themes, activeTheme, snippets, onChange }: Props) {
  const [editing, setEditing] = useState<number | null>(null)
  return (
    <>
      <div className="setting-item">
        <div className="setting-info">
          <div className="setting-name">{m.settings.themes}</div>
          <div className="setting-desc">{m.settings.themesDesc}</div>
        </div>
        <div className="setting-control">
          <select aria-label={m.settings.themes} value={activeTheme} onChange={(e) => onChange({ activeTheme: e.target.value })}>
            <option value="">{m.settings.defaultTheme}</option>
            {themes.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
          <label className="file-button" title={m.settings.importTheme}>
            <input type="file" hidden accept=".css,text/css" onChange={readCss((name, css) => onChange({ themes: [...themes.filter((t) => t.name !== name), { name, css }], activeTheme: name }))} />
            <span className="button-like"><Upload size={14} />{m.settings.importTheme}</span>
          </label>
          {activeTheme && (
            <button className="clickable-icon" aria-label={m.settings.removeTheme(activeTheme)} title={m.settings.removeTheme(activeTheme)}
              onClick={() => onChange({ themes: themes.filter((t) => t.name !== activeTheme), activeTheme: '' })}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="setting-item">
        <div className="setting-info">
          <div className="setting-name">{m.settings.snippets}</div>
          <div className="setting-desc">{m.settings.snippetsDesc}</div>
        </div>
        <div className="setting-control">
          <label className="file-button">
            <input type="file" hidden accept=".css,text/css" onChange={readCss((name, css) => onChange({ snippets: [...snippets, { name, css, enabled: true }] }))} />
            <span className="button-like"><Upload size={14} />{m.settings.importSnippet}</span>
          </label>
          <button onClick={() => {
            onChange({ snippets: [...snippets, { name: m.settings.newSnippetName(snippets.length + 1), css: '', enabled: true }] })
            setEditing(snippets.length)
          }}>
            <Plus size={14} />{m.settings.newSnippet}
          </button>
        </div>
      </div>
      <ul className="snippet-list">
        {snippets.map((s, i) => {
          const update = (p: Partial<Snippet>) => onChange({ snippets: snippets.map((x, j) => (j === i ? { ...x, ...p } : x)) })
          return (
            <li key={i} className="snippet">
              <div className="snippet-head">
                <input className="snippet-name" value={s.name} aria-label={m.settings.snippetName} onChange={(e) => update({ name: e.target.value })} />
                <button className="clickable-icon" aria-label={m.settings.editSnippet(s.name)} title={m.settings.editSnippet(s.name)} aria-expanded={editing === i} onClick={() => setEditing(editing === i ? null : i)}><Pencil size={14} /></button>
                <button className="clickable-icon" aria-label={m.settings.deleteSnippet(s.name)} title={m.settings.deleteSnippet(s.name)} onClick={() => onChange({ snippets: snippets.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
                <input type="checkbox" className="toggle" checked={s.enabled} aria-label={m.settings.enableSnippet(s.name)} onChange={(e) => update({ enabled: e.target.checked })} />
              </div>
              {editing === i && (
                <textarea className="snippet-css" rows={8} spellCheck={false} value={s.css} placeholder=".dock { border-radius: 4px; }" aria-label={m.settings.snippetCss(s.name)}
                  onChange={(e) => update({ css: e.target.value })} />
              )}
            </li>
          )
        })}
      </ul>
      <p className="hint">{m.settings.cssTrust}</p>
    </>
  )
}
