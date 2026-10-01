import { useState } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import { DEFAULT_HOTKEYS, assign, comboOf, commandFor, displayCombo, effectiveHotkeys, resetHotkey, unassign } from '../hotkeys'
import { m } from '../i18n'

interface Props {
  commands: { id: string; name: string }[]
  overrides: Record<string, string[]>
  onChange: (overrides: Record<string, string[]>) => void
}

/** The Hotkeys tab: every command with its shortcuts, editable. */
export default function HotkeySettings({ commands, overrides, onChange }: Props) {
  const [filter, setFilter] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const map = effectiveHotkeys(overrides)
  const shown = commands.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
  const nameOf = (id: string) => commands.find((c) => c.id === id)?.name ?? id

  const record = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return setRecording(null)
    const combo = comboOf(e.nativeEvent)
    if (!combo) return
    const owner = commandFor(combo, map)
    onChange(assign(overrides, id, combo))
    setNote(owner && owner !== id ? m.settings.takenBy(displayCombo(combo), nameOf(owner)) : '')
    setRecording(null)
  }

  return (
    <>
      <h2>{m.settings.tabs.hotkeys}</h2>
      <p className="hint">{m.settings.hotkeysIntro}</p>
      <input className="hotkey-filter" placeholder={m.settings.hotkeysFilter} aria-label={m.settings.hotkeysFilter} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {note && <p className="hint" role="status">{note}</p>}
      <ul className="hotkey-list">
        {shown.map((c) => {
          const combos = map[c.id] ?? []
          const changed = c.id in overrides
          return (
            <li key={c.id} className="setting-item hotkey-row">
              <div className="setting-name">{c.name}</div>
              <div className="setting-control hotkey-keys">
                {combos.map((k) => (
                  <span key={k} className="hotkey-chip">
                    <kbd>{displayCombo(k)}</kbd>
                    <button className="clickable-icon" aria-label={m.settings.removeHotkey(displayCombo(k))} title={m.settings.removeHotkey(displayCombo(k))} onClick={() => onChange(unassign(overrides, c.id, k))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {!combos.length && recording !== c.id && <span className="faint small">{m.settings.noHotkey}</span>}
                {recording === c.id ? (
                  <button className="hotkey-recording" data-recording-hotkey autoFocus onKeyDown={(e) => record(c.id, e)} onBlur={() => setRecording(null)}>
                    {m.settings.pressKeys}
                  </button>
                ) : (
                  <button className="clickable-icon" aria-label={m.settings.addHotkey(c.name)} title={m.settings.addHotkey(c.name)} onClick={() => setRecording(c.id)}>
                    <Plus size={14} />
                  </button>
                )}
                {changed && (
                  <button className="clickable-icon" aria-label={m.settings.resetHotkey(c.name)} title={m.settings.resetHotkey(c.name)} onClick={() => onChange(resetHotkey(overrides, c.id))}>
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export { DEFAULT_HOTKEYS }
