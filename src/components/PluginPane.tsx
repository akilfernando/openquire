import { useState } from 'react'
import type { PaneElement } from '../plugins/types'

interface Props {
  content: PaneElement[]
  onEvent: (element: string, values: Record<string, string>) => void
}

/** Draws a plugin's pane from its declared elements, in the app's own style. */
export default function PluginPane({ content, onEvent }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})
  const valueOf = (id: string, fallback = '') => values[id] ?? fallback
  const allValues = () => Object.fromEntries(content.flatMap((e) => (e.type === 'input' ? [[e.id, valueOf(e.id, e.value)]] : [])))
  return (
    <div className="pane plugin-pane">
      {content.map((e, i) => {
        switch (e.type) {
          case 'heading':
            return <div key={i} className="pane-heading">{String(e.text)}</div>
          case 'text':
            return <p key={i} className={e.muted ? 'hint' : 'plugin-text'}>{String(e.text)}</p>
          case 'list':
            return <ul key={i} className="plugin-list">{(e.items ?? []).map((it, j) => <li key={j}>{String(it)}</li>)}</ul>
          case 'input':
            return (
              <label key={i} className="field">
                <span>{String(e.label)}</span>
                <input value={valueOf(e.id, e.value)} placeholder={e.placeholder} onChange={(ev) => setValues({ ...values, [e.id]: ev.target.value })} />
              </label>
            )
          case 'button':
            return <button key={i} className={e.primary ? 'cta' : ''} onClick={() => onEvent(e.id, allValues())}>{String(e.label)}</button>
          default:
            return null
        }
      })}
    </div>
  )
}
