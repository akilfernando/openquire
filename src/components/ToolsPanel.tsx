import { useState } from 'react'
import { rgbOf, type CompressLevel, type DocState, type Metadata, type Permission, type SaveOptions, type StampPosition, type StampSpec } from '../engine/types'

export interface PanelActions {
  rotate: (delta: 90 | 270) => void
  remove: () => void
  extract: () => void
  insertBlank: () => void
  split: (spec: string | null) => void
  stamp: (spec: Omit<StampSpec, 'pageIds'>) => void
  markTerms: (terms: string[]) => void
  markPatterns: (patterns: string[]) => void
  applyRedactions: () => void
  flatten: (annots: boolean, widgets: boolean) => void
  exportImages: () => void
  exportText: () => void
  exportHtml: () => void
  setMeta: (m: Metadata) => void
  setAuthor: (name: string) => void
}

interface Props {
  doc: DocState
  selectedCount: number
  author: string
  saveOpts: SaveOptions
  onSaveOpts: (o: SaveOptions) => void
  actions: PanelActions
}

const PATTERNS: { label: string; source: string }[] = [
  { label: 'Email addresses', source: '[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+' },
  { label: 'Phone numbers', source: '\\+?\\d[\\d ()-]{7,}\\d' },
  { label: 'Card numbers', source: '\\b(?:\\d[ -]?){13,19}\\b' },
  { label: 'Dates', source: '\\b\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}\\b' },
  { label: 'URLs', source: 'https?://\\S+' },
]

const PRESETS: Record<string, Omit<StampSpec, 'pageIds'>> = {
  'Page numbers': { template: 'Page {page} of {pages}', position: 'bc', size: 10, color: [0.2, 0.2, 0.2], opacity: 1, angle: 0 },
  Watermark: { template: 'CONFIDENTIAL', position: 'center', size: 'fit', color: [0.85, 0.1, 0.1], opacity: 0.2, angle: 45 },
  'Bates numbers': { template: '{name}-{bates}', position: 'br', size: 9, color: [0, 0, 0], opacity: 1, angle: 0, batesStart: 1, batesDigits: 6 },
  Header: { template: '{name}    {date}', position: 'tl', size: 9, color: [0.3, 0.3, 0.3], opacity: 1, angle: 0 },
}

function Stamps({ actions, scope }: { actions: PanelActions; scope: string }) {
  const [s, set] = useState(PRESETS['Page numbers'])
  const [hex, setHex] = useState('#333333')
  const patch = (p: Partial<typeof s>) => set({ ...s, ...p })
  return (
    <details>
      <summary>Headers, footers &amp; watermarks</summary>
      <div className="chips">
        {Object.keys(PRESETS).map((k) => (
          <button key={k} onClick={() => {
            set(PRESETS[k])
            const [r, g, b] = PRESETS[k].color
            setHex('#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''))
          }}>{k}</button>
        ))}
      </div>
      <label><span>Text — {'{page} {pages} {date} {name} {bates}'}</span>
        <textarea rows={2} value={s.template} onChange={(e) => patch({ template: e.target.value })} />
      </label>
      <div className="row">
        <label><span>Position</span>
          <select value={s.position} onChange={(e) => patch({ position: e.target.value as StampPosition })}>
            <option value="tl">Top left</option><option value="tc">Top centre</option><option value="tr">Top right</option>
            <option value="center">Centre</option>
            <option value="bl">Bottom left</option><option value="bc">Bottom centre</option><option value="br">Bottom right</option>
          </select>
        </label>
        <label><span>Size</span>
          <input type="number" min={4} max={300} placeholder="fit" value={s.size === 'fit' ? '' : s.size}
            onChange={(e) => patch({ size: e.target.value ? Number(e.target.value) : 'fit' })} />
        </label>
      </div>
      <div className="row">
        <label><span>Colour</span><input type="color" value={hex} onChange={(e) => { setHex(e.target.value); patch({ color: rgbOf(e.target.value) }) }} /></label>
        <label><span>Opacity</span><input type="number" min={0.05} max={1} step={0.05} value={s.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} /></label>
        <label><span>Angle</span><input type="number" min={-90} max={90} value={s.angle} onChange={(e) => patch({ angle: Number(e.target.value) })} /></label>
      </div>
      {s.template.includes('{bates}') && (
        <div className="row">
          <label><span>Start at</span><input type="number" min={0} value={s.batesStart ?? 1} onChange={(e) => patch({ batesStart: Number(e.target.value) })} /></label>
          <label><span>Digits</span><input type="number" min={1} max={12} value={s.batesDigits ?? 6} onChange={(e) => patch({ batesDigits: Number(e.target.value) })} /></label>
        </div>
      )}
      <button disabled={!s.template.trim()} onClick={() => actions.stamp(s)}>Add to {scope}</button>
      <p className="hint">Written into the page itself, like Acrobat's headers and footers. Undo removes it.</p>
    </details>
  )
}

function Redaction({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  const [terms, setTerms] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const pending = doc.pages.reduce((n, p) => n + p.annots.filter((a) => a.type === 'Redact').length, 0)
  return (
    <details>
      <summary>Redact{pending ? ` (${pending} marked)` : ''}</summary>
      <p className="hint">Mark content with the Redact tool, by search, or by pattern, check the marks, then apply.</p>
      <label><span>Words or phrases, one per line</span>
        <textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} />
      </label>
      <div className="chips">
        {PATTERNS.map((p) => (
          <label key={p.label} className="check">
            <input type="checkbox" checked={picked.has(p.source)}
              onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(p.source) : n.delete(p.source); setPicked(n) }} />
            <span>{p.label}</span>
          </label>
        ))}
      </div>
      <button
        disabled={!terms.trim() && !picked.size}
        onClick={() => {
          const list = terms.split('\n').map((t) => t.trim()).filter(Boolean)
          if (list.length) actions.markTerms(list)
          if (picked.size) actions.markPatterns([...picked])
        }}
      >Find &amp; mark</button>
      <button className="danger" disabled={!pending} onClick={actions.applyRedactions}>Apply {pending || ''} redaction{pending === 1 ? '' : 's'}</button>
      <p className="hint">Applying permanently removes the text, images and graphics under each mark.</p>
    </details>
  )
}

function SaveSettings({ doc, saveOpts, onSaveOpts }: Pick<Props, 'doc' | 'saveOpts' | 'onSaveOpts'>) {
  const sec = saveOpts.security
  const set = (p: Partial<SaveOptions>) => onSaveOpts({ ...saveOpts, ...p })
  const perms: [Permission, string][] = [['print', 'Printing'], ['copy', 'Copying text'], ['edit', 'Editing'], ['annotate', 'Commenting'], ['form', 'Filling forms'], ['assemble', 'Page changes']]
  return (
    <details>
      <summary>Compression &amp; security</summary>
      <label><span>Compression when saving</span>
        <select value={saveOpts.compress} onChange={(e) => set({ compress: e.target.value as CompressLevel })}>
          <option value="none">None</option>
          <option value="standard">Standard (lossless)</option>
          <option value="medium">Reduce images (≤ 2000 px)</option>
          <option value="strong">Smallest (≤ 1200 px, lower quality)</option>
        </select>
      </label>
      <label><span>Password protection</span>
        <select
          value={sec.mode}
          onChange={(e) => {
            const mode = e.target.value as SaveOptions['security']['mode']
            set({ security: mode === 'set' ? { mode, userPassword: '', ownerPassword: '', allow: ['print', 'copy', 'form', 'annotate'] } : { mode } })
          }}
        >
          <option value="keep">{doc.encrypted ? 'Keep current password' : 'None'}</option>
          {doc.encrypted && <option value="none">Remove password</option>}
          <option value="set">{doc.encrypted ? 'Change password' : 'Add password'}</option>
        </select>
      </label>
      {sec.mode === 'set' && (
        <>
          <label><span>Password to open (optional)</span>
            <input type="password" autoComplete="new-password" value={sec.userPassword} onChange={(e) => set({ security: { ...sec, userPassword: e.target.value } })} />
          </label>
          <label><span>Permissions password</span>
            <input type="password" autoComplete="new-password" value={sec.ownerPassword} onChange={(e) => set({ security: { ...sec, ownerPassword: e.target.value } })} />
          </label>
          <span className="hint">Allow without the permissions password:</span>
          <div className="chips">
            {perms.map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={sec.allow.includes(k)}
                  onChange={(e) => set({ security: { ...sec, allow: e.target.checked ? [...sec.allow, k] : sec.allow.filter((x) => x !== k) } })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p className="hint">AES-256 encryption. Applied when you save.</p>
        </>
      )}
    </details>
  )
}

export default function ToolsPanel({ doc, selectedCount, author, saveOpts, onSaveOpts, actions }: Props) {
  const [ranges, setRanges] = useState('')
  const scope = selectedCount ? `${selectedCount} selected page${selectedCount > 1 ? 's' : ''}` : 'all pages'
  const widgets = doc.pages.reduce((n, p) => n + p.widgets.length, 0)
  const annots = doc.pages.reduce((n, p) => n + p.annots.length, 0)

  return (
    <aside className="panel">
      <details open>
        <summary>Organize pages</summary>
        <div className="row">
          <button onClick={() => actions.rotate(270)}>⟲ Left</button>
          <button onClick={() => actions.rotate(90)}>⟳ Right</button>
        </div>
        <p className="hint">Rotates {scope}. Drag thumbnails to reorder; Ctrl/Shift-click to select several.</p>
        <div className="row">
          <button disabled={!selectedCount} onClick={actions.remove}>Delete</button>
          <button disabled={!selectedCount} onClick={actions.extract}>Extract</button>
        </div>
        <button onClick={actions.insertBlank}>Insert blank page</button>
      </details>

      <details>
        <summary>Split</summary>
        <input placeholder="e.g. 1-3, 4-6, 7-" value={ranges} onChange={(e) => setRanges(e.target.value)} />
        <div className="row">
          <button disabled={!ranges.trim()} onClick={() => actions.split(ranges)}>By ranges</button>
          <button onClick={() => actions.split(null)}>Every page</button>
        </div>
        <p className="hint">Each part keeps its links, form fields and bookmarks. Downloads as a zip.</p>
      </details>

      <Stamps actions={actions} scope={scope} />
      <Redaction doc={doc} actions={actions} />

      <details>
        <summary>Forms &amp; flattening</summary>
        <p className="hint">{widgets ? `${widgets} form field${widgets > 1 ? 's' : ''}: click them on the page to fill in.` : 'This document has no form fields.'}</p>
        <div className="row">
          <button disabled={!widgets} onClick={() => actions.flatten(false, true)}>Flatten form</button>
          <button disabled={!annots} onClick={() => actions.flatten(true, false)}>Flatten comments</button>
        </div>
        <p className="hint">Flattening makes field values and markup a permanent part of the page.</p>
      </details>

      <SaveSettings doc={doc} saveOpts={saveOpts} onSaveOpts={onSaveOpts} />

      <details>
        <summary>Export</summary>
        <div className="row">
          <button onClick={actions.exportImages}>PNG images</button>
          <button onClick={actions.exportText}>Text</button>
          <button onClick={actions.exportHtml}>HTML</button>
        </div>
      </details>

      <details>
        <summary>Properties</summary>
        {(['title', 'author', 'subject', 'keywords'] as const).map((k) => (
          <label key={k}><span>{k[0].toUpperCase() + k.slice(1)}</span>
            <input key={doc.meta[k]} defaultValue={doc.meta[k]} onBlur={(e) => e.target.value !== doc.meta[k] && actions.setMeta({ ...doc.meta, [k]: e.target.value })} />
          </label>
        ))}
        <label><span>Your name (shown on comments)</span>
          <input defaultValue={author} onBlur={(e) => actions.setAuthor(e.target.value.trim())} />
        </label>
      </details>
    </aside>
  )
}
