import { useState, type ReactNode } from 'react'
import { ChevronRight, RotateCcw, RotateCw, Wrench } from 'lucide-react'
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
  ocr: (scope: 'notext' | 'selected' | 'all') => void
  pagesWithoutText: () => Promise<number>
  digitalSign: () => void
}

interface Props {
  doc: DocState
  selectedCount: number
  saveOpts: SaveOptions
  onSaveOpts: (o: SaveOptions) => void
  actions: PanelActions
}

function Section({ title, count, open, onOpen, children }: { title: string; count?: number | string; open?: boolean; onOpen?: () => void; children: ReactNode }) {
  return (
    <details className="section" open={open} onToggle={(e) => e.currentTarget.open && onOpen?.()}>
      <summary>
        <ChevronRight size={14} className="chev" />
        {title}
        {count !== undefined && count !== 0 && <span className="count tnum">{count}</span>}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  )
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field"><span>{label}</span>{children}</label>
)

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

const toHex = ([r, g, b]: number[]) => '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')

function Stamps({ actions, scope }: { actions: PanelActions; scope: string }) {
  const [s, set] = useState(PRESETS['Page numbers'])
  const patch = (p: Partial<typeof s>) => set({ ...s, ...p })
  return (
    <Section title="Headers, footers & watermarks">
      <div className="chips">
        {Object.keys(PRESETS).map((k) => <button key={k} onClick={() => set(PRESETS[k])}>{k}</button>)}
      </div>
      <Field label="Text: {page} {pages} {date} {name} {bates}">
        <textarea rows={2} value={s.template} onChange={(e) => patch({ template: e.target.value })} />
      </Field>
      <div className="row">
        <Field label="Position">
          <select value={s.position} onChange={(e) => patch({ position: e.target.value as StampPosition })}>
            <option value="tl">Top left</option><option value="tc">Top centre</option><option value="tr">Top right</option>
            <option value="center">Centre</option>
            <option value="bl">Bottom left</option><option value="bc">Bottom centre</option><option value="br">Bottom right</option>
          </select>
        </Field>
        <Field label="Size">
          <input type="number" min={4} max={300} placeholder="Fit" value={s.size === 'fit' ? '' : s.size}
            onChange={(e) => patch({ size: e.target.value ? Number(e.target.value) : 'fit' })} />
        </Field>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Color"><input className="color-input" type="color" value={toHex(s.color)} onChange={(e) => patch({ color: rgbOf(e.target.value) })} /></Field>
        <Field label="Opacity"><input type="number" min={0.05} max={1} step={0.05} value={s.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} /></Field>
        <Field label="Angle"><input type="number" min={-90} max={90} value={s.angle} onChange={(e) => patch({ angle: Number(e.target.value) })} /></Field>
      </div>
      {s.template.includes('{bates}') && (
        <div className="row">
          <Field label="Start at"><input type="number" min={0} value={s.batesStart ?? 1} onChange={(e) => patch({ batesStart: Number(e.target.value) })} /></Field>
          <Field label="Digits"><input type="number" min={1} max={12} value={s.batesDigits ?? 6} onChange={(e) => patch({ batesDigits: Number(e.target.value) })} /></Field>
        </div>
      )}
      <button disabled={!s.template.trim()} onClick={() => actions.stamp(s)}>Add to {scope}</button>
      <p className="hint">Written into the page itself. Undo removes it.</p>
    </Section>
  )
}

function Redaction({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  const [terms, setTerms] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const pending = doc.pages.reduce((n, p) => n + p.annots.filter((a) => a.type === 'Redact').length, 0)
  return (
    <Section title="Redact" count={pending ? `${pending} marked` : undefined}>
      <p className="hint">Mark content with the redact tool, by search, or by pattern. Check the marks, then apply them.</p>
      <Field label="Words or phrases, one per line"><textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
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
      >Find and mark</button>
      <button className="warning" disabled={!pending} onClick={actions.applyRedactions}>
        Apply {pending || ''} redaction{pending === 1 ? '' : 's'}
      </button>
      <p className="hint">Applying permanently removes the text, images and graphics under each mark.</p>
    </Section>
  )
}

function Ocr({ doc, selectedCount, actions }: Pick<Props, 'doc' | 'selectedCount' | 'actions'>) {
  const [noText, setNoText] = useState<number | null>(null)
  return (
    <Section title="Recognize text (OCR)" onOpen={() => void actions.pagesWithoutText().then(setNoText)}>
      <p className="hint">
        Makes scanned pages searchable and selectable with an invisible text layer. The pages look the same. English, processed on this
        device. The first run loads the 15 MB OCR engine.
      </p>
      <button disabled={!noText} onClick={() => { actions.ocr('notext'); setNoText(0) }}>
        Pages without text{noText === null ? '' : ` (${noText})`}
      </button>
      <div className="row">
        <button disabled={!selectedCount} onClick={() => actions.ocr('selected')}>Selected pages</button>
        <button onClick={() => actions.ocr('all')}>All {doc.pages.length} pages</button>
      </div>
    </Section>
  )
}

function SaveSettings({ doc, saveOpts, onSaveOpts }: Pick<Props, 'doc' | 'saveOpts' | 'onSaveOpts'>) {
  const sec = saveOpts.security
  const set = (p: Partial<SaveOptions>) => onSaveOpts({ ...saveOpts, ...p })
  const perms: [Permission, string][] = [['print', 'Printing'], ['copy', 'Copying text'], ['edit', 'Editing'], ['annotate', 'Commenting'], ['form', 'Filling forms'], ['assemble', 'Page changes']]
  return (
    <Section title="Compression & security" count={doc.encrypted ? 'Protected' : undefined}>
      {doc.signatures.length > 0 && (
        <p className="hint">
          This document is digitally signed. Saving appends your changes so the signatures stay valid, so compression and password changes
          aren't applied.
        </p>
      )}
      <Field label="Compression when saving">
        <select value={saveOpts.compress} onChange={(e) => set({ compress: e.target.value as CompressLevel })}>
          <option value="none">None</option>
          <option value="standard">Standard (lossless)</option>
          <option value="medium">Reduce images (up to 2000 px)</option>
          <option value="strong">Smallest (up to 1200 px, lower quality)</option>
        </select>
      </Field>
      <Field label="Password protection">
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
      </Field>
      {sec.mode === 'set' && (
        <>
          <Field label="Password to open (optional)">
            <input type="password" autoComplete="new-password" value={sec.userPassword} onChange={(e) => set({ security: { ...sec, userPassword: e.target.value } })} />
          </Field>
          <Field label="Permissions password">
            <input type="password" autoComplete="new-password" value={sec.ownerPassword} onChange={(e) => set({ security: { ...sec, ownerPassword: e.target.value } })} />
          </Field>
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
          <p className="hint">AES-256 encryption, applied when you save.</p>
        </>
      )}
    </Section>
  )
}

export default function ToolsPanel({ doc, selectedCount, saveOpts, onSaveOpts, actions }: Props) {
  const [ranges, setRanges] = useState('')
  const scope = selectedCount ? `${selectedCount} selected page${selectedCount > 1 ? 's' : ''}` : 'all pages'
  const widgets = doc.pages.reduce((n, p) => n + p.widgets.length, 0)
  const annots = doc.pages.reduce((n, p) => n + p.annots.length, 0)

  return (
    <aside className="sidebar right">
      <div className="sidebar-header">
        <Wrench size={16} className="faint" />
        <span className="sidebar-title">Tools</span>
      </div>
      <div className="pane" style={{ gap: 0, padding: '4px 6px 60px' }}>
        <Section title="Organize pages" open count={selectedCount ? `${selectedCount} selected` : undefined}>
          <div className="row">
            <button onClick={() => actions.rotate(270)}><RotateCcw size={16} />Left</button>
            <button onClick={() => actions.rotate(90)}><RotateCw size={16} />Right</button>
          </div>
          <p className="hint">Rotates {scope}. Drag thumbnails to reorder; Ctrl- or Shift-click to select several.</p>
          <div className="row">
            <button disabled={!selectedCount} onClick={actions.remove}>Delete</button>
            <button disabled={!selectedCount} onClick={actions.extract}>Extract</button>
          </div>
          <button onClick={actions.insertBlank}>Insert blank page</button>
        </Section>

        <Section title="Split">
          <input placeholder="For example 1-3, 4-6, 7-" value={ranges} onChange={(e) => setRanges(e.target.value)} />
          <div className="row">
            <button disabled={!ranges.trim()} onClick={() => actions.split(ranges)}>By ranges</button>
            <button onClick={() => actions.split(null)}>Every page</button>
          </div>
          <p className="hint">Each part keeps its links, form fields and bookmarks. Downloads as a zip.</p>
        </Section>

        <Ocr doc={doc} selectedCount={selectedCount} actions={actions} />
        <Stamps actions={actions} scope={scope} />
        <Redaction doc={doc} actions={actions} />

        <Section title="Digital signature" count={doc.signatures.length || undefined}>
          <p className="hint">
            Sign with a certificate (.p12 or .pfx), or create your own ID. Unlike a signature image, this proves who signed and reveals any
            later tampering.
          </p>
          <button onClick={actions.digitalSign}>Sign with a digital ID</button>
        </Section>

        <Section title="Forms & flattening" count={widgets || undefined}>
          <p className="hint">{widgets ? `${widgets} form field${widgets > 1 ? 's' : ''}. Click them on the page to fill them in.` : 'This document has no form fields.'}</p>
          <div className="row">
            <button disabled={!widgets} onClick={() => actions.flatten(false, true)}>Flatten form</button>
            <button disabled={!annots} onClick={() => actions.flatten(true, false)}>Flatten comments</button>
          </div>
          <p className="hint">Flattening makes field values and markup a permanent part of the page.</p>
        </Section>

        <SaveSettings doc={doc} saveOpts={saveOpts} onSaveOpts={onSaveOpts} />

        <Section title="Export">
          <div className="row">
            <button onClick={actions.exportImages}>PNG images</button>
            <button onClick={actions.exportText}>Text</button>
            <button onClick={actions.exportHtml}>HTML</button>
          </div>
        </Section>

        <Section title="Properties">
          {(['title', 'author', 'subject', 'keywords'] as const).map((k) => (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
              <input key={doc.meta[k]} defaultValue={doc.meta[k]} onBlur={(e) => e.target.value !== doc.meta[k] && actions.setMeta({ ...doc.meta, [k]: e.target.value })} />
            </Field>
          ))}
        </Section>
      </div>
    </aside>
  )
}
