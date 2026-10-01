import { useState } from 'react'
import { ExternalLink, Trash2, Upload } from 'lucide-react'
import { inspectPlugin } from '../plugins/host'
import type { InstalledPlugin, Manifest } from '../plugins/types'
import { m } from '../i18n'

interface Props {
  plugins: InstalledPlugin[]
  errors: Map<string, string>
  onChange: (plugins: InstalledPlugin[]) => void
}

/** The Plugins tab: install from a file after reviewing permissions, turn on and off, remove. */
export default function PluginsSettings({ plugins, errors, onChange }: Props) {
  const [pending, setPending] = useState<{ manifest: Manifest; source: string } | null>(null)
  const [error, setError] = useState('')
  const docs = new URL(`${import.meta.env.BASE_URL}docs/plugins.html`, location.href).href

  return (
    <>
      <h2>{m.settings.tabs.plugins}</h2>
      <p className="hint">{m.settings.pluginsIntro} <a href={docs} target="_blank" rel="noreferrer">{m.settings.pluginDocs}<ExternalLink size={12} /></a></p>
      <label className="file-button">
        <input type="file" hidden accept=".js,.mjs,text/javascript" onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          setError('')
          try {
            const source = await f.text()
            setPending({ manifest: await inspectPlugin(source), source })
          } catch (err) {
            setError(m.settings.pluginInvalid((err as Error).message))
          }
        }} />
        <span className="button-like"><Upload size={14} />{m.settings.installPlugin}</span>
      </label>
      {error && <p className="error small">{error}</p>}

      {pending && (
        <div className="plugin-review" role="group" aria-label={m.settings.reviewPlugin(pending.manifest.name)}>
          <div className="setting-name">{pending.manifest.name} <span className="muted">{pending.manifest.version}</span></div>
          {pending.manifest.author && <div className="muted small">{m.settings.pluginBy(pending.manifest.author)}</div>}
          {pending.manifest.description && <p>{pending.manifest.description}</p>}
          <div className="small">{m.settings.pluginWants}</div>
          <ul className="plugin-permissions">
            {pending.manifest.permissions.length ? pending.manifest.permissions.map((p) => <li key={p}>{m.settings.permissions[p]}</li>) : <li>{m.settings.noPermissions}</li>}
          </ul>
          <p className="hint">{m.settings.pluginTrust}</p>
          <div className="row end">
            <button onClick={() => setPending(null)}>{m.settings.cancelInstall}</button>
            <button className="cta" onClick={() => {
              onChange([...plugins.filter((p) => p.manifest.id !== pending.manifest.id), { manifest: pending.manifest, source: pending.source, enabled: true }])
              setPending(null)
            }}>{m.settings.confirmInstall}</button>
          </div>
        </div>
      )}

      {!plugins.length && !pending && <p className="empty-note">{m.settings.noPlugins}</p>}
      <ul className="plugin-installed">
        {plugins.map((p) => (
          <li key={p.manifest.id} className="setting-item">
            <div className="setting-info">
              <div className="setting-name">{p.manifest.name} <span className="muted small">{p.manifest.version}</span></div>
              {p.manifest.description && <div className="setting-desc">{p.manifest.description}</div>}
              <div className="setting-desc">{p.manifest.permissions.map((x) => m.settings.permissions[x]).join(', ') || m.settings.noPermissions}</div>
              {errors.get(p.manifest.id) && <div className="error small">{errors.get(p.manifest.id)}</div>}
            </div>
            <div className="setting-control">
              <button className="clickable-icon" aria-label={m.settings.removePlugin(p.manifest.name)} title={m.settings.removePlugin(p.manifest.name)}
                onClick={() => onChange(plugins.filter((x) => x !== p))}><Trash2 size={14} /></button>
              <input type="checkbox" className="toggle" checked={p.enabled} aria-label={m.settings.enablePlugin(p.manifest.name)}
                onChange={(e) => onChange(plugins.map((x) => (x === p ? { ...x, enabled: e.target.checked } : x)))} />
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
