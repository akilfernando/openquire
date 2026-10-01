import { useState, type ReactNode } from 'react'
import { ChevronRight, RotateCcw, RotateCw, Wrench } from 'lucide-react'
import { rgbOf, type CompressLevel, type DocState, type Metadata, type PageLabelStyle, type Permission, type SaveOptions, type StampPosition, type StampSpec } from '../engine/types'
import { m } from '../i18n'

export interface PanelActions {
  rotate: (delta: 90 | 270) => void
  remove: () => void
  extract: () => void
  insertBlank: () => void
  straighten: () => void
  split: (spec: string | null) => void
  stamp: (spec: Omit<StampSpec, 'pageIds'>) => void
  markTerms: (terms: string[]) => void
  markPatterns: (patterns: string[]) => void
  applyRedactions: () => void
  flatten: (annots: boolean, widgets: boolean) => void
  exportImages: () => void
  exportText: () => void
  exportHtml: () => void
  setMeta: (meta: Metadata) => void
  ocr: (scope: 'notext' | 'selected' | 'all') => void
  pagesWithoutText: () => Promise<number>
  digitalSign: () => void
  setLabels: (style: PageLabelStyle, prefix: string, start: number) => void
  designForm: () => void
  savePdfA: (part: 2 | 3) => void
  checkPdfA: () => void
  sanitize: () => void
  detectFields: () => void
  removeLabels: () => void
}

interface Props {
  doc: DocState
  selectedCount: number
  /** Label of the page that page-level actions start from (the first selected, or current, page). */
  labelPage: string
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

const PATTERNS: { key: keyof typeof m.panel.patterns; source: string }[] = [
  { key: 'email', source: '[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+' },
  { key: 'phone', source: '\\+?\\d[\\d ()-]{7,}\\d' },
  { key: 'card', source: '\\b(?:\\d[ -]?){13,19}\\b' },
  { key: 'date', source: '\\b\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4}\\b' },
  { key: 'url', source: 'https?://\\S+' },
]

const PRESETS: Record<keyof typeof m.panel.presets, Omit<StampSpec, 'pageIds'>> = {
  pageNumbers: { template: 'Page {page} of {pages}', position: 'bc', size: 10, color: [0.2, 0.2, 0.2], opacity: 1, angle: 0 },
  watermark: { template: 'CONFIDENTIAL', position: 'center', size: 'fit', color: [0.85, 0.1, 0.1], opacity: 0.2, angle: 45 },
  bates: { template: '{name}-{bates}', position: 'br', size: 9, color: [0, 0, 0], opacity: 1, angle: 0, batesStart: 1, batesDigits: 6 },
  header: { template: '{name}    {date}', position: 'tl', size: 9, color: [0.3, 0.3, 0.3], opacity: 1, angle: 0 },
}

const toHex = ([r, g, b]: number[]) => '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')

function Stamps({ actions, scope }: { actions: PanelActions; scope: string }) {
  const [s, set] = useState(PRESETS.pageNumbers)
  const patch = (p: Partial<typeof s>) => set({ ...s, ...p })
  const positions = Object.entries(m.panel.positions) as [StampPosition, string][]
  return (
    <Section title={m.panel.stamps}>
      <div className="chips">
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => <button key={k} onClick={() => set(PRESETS[k])}>{m.panel.presets[k]}</button>)}
      </div>
      <Field label={m.panel.stampText}>
        <textarea rows={2} value={s.template} onChange={(e) => patch({ template: e.target.value })} />
      </Field>
      <div className="row">
        <Field label={m.panel.position}>
          <select value={s.position} onChange={(e) => patch({ position: e.target.value as StampPosition })}>
            {positions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        <Field label={m.panel.size}>
          <input type="number" min={4} max={300} placeholder={m.panel.fit} value={s.size === 'fit' ? '' : s.size}
            onChange={(e) => patch({ size: e.target.value ? Number(e.target.value) : 'fit' })} />
        </Field>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label={m.panel.color}><input className="color-input" type="color" value={toHex(s.color)} onChange={(e) => patch({ color: rgbOf(e.target.value) })} /></Field>
        <Field label={m.panel.opacity}><input type="number" min={0.05} max={1} step={0.05} value={s.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} /></Field>
        <Field label={m.panel.angle}><input type="number" min={-90} max={90} value={s.angle} onChange={(e) => patch({ angle: Number(e.target.value) })} /></Field>
      </div>
      {s.template.includes('{bates}') && (
        <div className="row">
          <Field label={m.panel.startAt}><input type="number" min={0} value={s.batesStart ?? 1} onChange={(e) => patch({ batesStart: Number(e.target.value) })} /></Field>
          <Field label={m.panel.digits}><input type="number" min={1} max={12} value={s.batesDigits ?? 6} onChange={(e) => patch({ batesDigits: Number(e.target.value) })} /></Field>
        </div>
      )}
      <button disabled={!s.template.trim()} onClick={() => actions.stamp(s)}>{m.panel.addTo(scope)}</button>
      <p className="hint">{m.panel.stampHint}</p>
    </Section>
  )
}

function Redaction({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  const [terms, setTerms] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const pending = doc.pages.reduce((n, p) => n + p.annots.filter((a) => a.type === 'Redact').length, 0)
  return (
    <Section title={m.panel.redact} count={pending ? m.panel.marked(pending) : undefined}>
      <p className="hint">{m.panel.redactHint}</p>
      <Field label={m.panel.redactTerms}><textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
      <div className="chips">
        {PATTERNS.map((p) => (
          <label key={p.key} className="check">
            <input type="checkbox" checked={picked.has(p.source)}
              onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(p.source) : n.delete(p.source); setPicked(n) }} />
            <span>{m.panel.patterns[p.key]}</span>
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
      >{m.panel.findAndMark}</button>
      <button className="warning" disabled={!pending} onClick={actions.applyRedactions}>{m.panel.applyRedactions(pending)}</button>
      <p className="hint">{m.panel.redactWarning}</p>
    </Section>
  )
}

function Ocr({ doc, selectedCount, actions }: Pick<Props, 'doc' | 'selectedCount' | 'actions'>) {
  const [noText, setNoText] = useState<number | null>(null)
  return (
    <Section title={m.panel.ocr} onOpen={() => void actions.pagesWithoutText().then(setNoText)}>
      <p className="hint">{m.panel.ocrHint}</p>
      <button disabled={!noText} onClick={() => { actions.ocr('notext'); setNoText(0) }}>{m.panel.pagesWithoutText(noText)}</button>
      <div className="row">
        <button disabled={!selectedCount} onClick={() => actions.ocr('selected')}>{m.panel.selectedPages}</button>
        <button onClick={() => actions.ocr('all')}>{m.panel.allPages(doc.pages.length)}</button>
      </div>
    </Section>
  )
}

function SaveSettings({ doc, saveOpts, onSaveOpts }: Pick<Props, 'doc' | 'saveOpts' | 'onSaveOpts'>) {
  const sec = saveOpts.security
  const set = (p: Partial<SaveOptions>) => onSaveOpts({ ...saveOpts, ...p })
  const perms = Object.entries(m.panel.permissions) as [Permission, string][]
  const levels = Object.entries(m.panel.compress) as [CompressLevel, string][]
  return (
    <Section title={m.panel.security} count={doc.encrypted ? m.status.protected : undefined}>
      {doc.signatures.length > 0 && <p className="hint">{m.panel.signedNote}</p>}
      <Field label={m.panel.compression}>
        <select value={saveOpts.compress} onChange={(e) => set({ compress: e.target.value as CompressLevel })}>
          {levels.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </Field>
      <Field label={m.panel.passwordProtection}>
        <select
          value={sec.mode}
          onChange={(e) => {
            const mode = e.target.value as SaveOptions['security']['mode']
            set({ security: mode === 'set' ? { mode, userPassword: '', ownerPassword: '', allow: ['print', 'copy', 'form', 'annotate'] } : { mode } })
          }}
        >
          <option value="keep">{doc.encrypted ? m.panel.keepPassword : m.panel.noPassword}</option>
          {doc.encrypted && <option value="none">{m.panel.removePassword}</option>}
          <option value="set">{doc.encrypted ? m.panel.changePassword : m.panel.addPassword}</option>
        </select>
      </Field>
      {sec.mode === 'set' && (
        <>
          <Field label={m.panel.openPassword}>
            <input type="password" autoComplete="new-password" value={sec.userPassword} onChange={(e) => set({ security: { ...sec, userPassword: e.target.value } })} />
          </Field>
          <Field label={m.panel.ownerPassword}>
            <input type="password" autoComplete="new-password" value={sec.ownerPassword} onChange={(e) => set({ security: { ...sec, ownerPassword: e.target.value } })} />
          </Field>
          <span className="hint">{m.panel.allowWithout}</span>
          <div className="chips">
            {perms.map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={sec.allow.includes(k)}
                  onChange={(e) => set({ security: { ...sec, allow: e.target.checked ? [...sec.allow, k] : sec.allow.filter((x) => x !== k) } })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p className="hint">{m.panel.encryptionNote}</p>
        </>
      )}
    </Section>
  )
}

function Labels({ labelPage, actions }: Pick<Props, 'labelPage' | 'actions'>) {
  const [style, setStyle] = useState<PageLabelStyle>('r')
  const [prefix, setPrefix] = useState('')
  const [start, setStart] = useState(1)
  const styles = Object.entries(m.panel.labelStyles) as [PageLabelStyle, string][]
  return (
    <Section title={m.panel.labels}>
      <p className="hint">{m.panel.labelsHint(labelPage)}</p>
      <div className="row">
        <Field label={m.panel.labelStyle}>
          <select value={style} onChange={(e) => setStyle(e.target.value as PageLabelStyle)}>
            {styles.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        <Field label={m.panel.labelPrefix}><input value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
        <Field label={m.panel.labelStart}><input type="number" min={1} value={start} onChange={(e) => setStart(Number(e.target.value) || 1)} /></Field>
      </div>
      <div className="row">
        <button onClick={() => actions.setLabels(style, prefix, start)}>{m.panel.applyLabels}</button>
        <button onClick={actions.removeLabels}>{m.panel.removeLabels}</button>
      </div>
    </Section>
  )
}

export default function ToolsPanel({ doc, selectedCount, labelPage, saveOpts, onSaveOpts, actions }: Props) {
  const [ranges, setRanges] = useState('')
  const [pdfaPart, setPdfaPart] = useState<2 | 3>(doc.attachments.length ? 3 : 2)
  const scope = selectedCount ? m.panel.scopeSelected(selectedCount) : m.panel.scopeAll
  const widgets = doc.pages.reduce((n, p) => n + p.widgets.length, 0)
  const annots = doc.pages.reduce((n, p) => n + p.annots.length, 0)
  const metaKeys = Object.entries(m.panel.meta) as [keyof Metadata, string][]

  return (
    <aside className="sidebar right">
      <div className="sidebar-header">
        <Wrench size={16} className="faint" />
        <span className="sidebar-title">{m.panel.title}</span>
      </div>
      <div className="pane" style={{ gap: 0, padding: '4px 6px 60px' }}>
        <Section title={m.panel.organize} open count={selectedCount ? m.panel.selected(selectedCount) : undefined}>
          <div className="row">
            <button onClick={() => actions.rotate(270)}><RotateCcw size={16} />{m.panel.left}</button>
            <button onClick={() => actions.rotate(90)}><RotateCw size={16} />{m.panel.right}</button>
          </div>
          <p className="hint">{m.panel.rotateScope(scope)}</p>
          <div className="row">
            <button disabled={!selectedCount} onClick={actions.remove}>{m.panel.delete}</button>
            <button disabled={!selectedCount} onClick={actions.extract}>{m.panel.extract}</button>
          </div>
          <button onClick={actions.insertBlank}>{m.panel.insertBlank}</button>
          <button onClick={actions.straighten}>{m.panel.straighten}</button>
        </Section>

        <Labels labelPage={labelPage} actions={actions} />

        <Section title={m.panel.split}>
          <input placeholder={m.panel.splitPlaceholder} aria-label={m.panel.split} value={ranges} onChange={(e) => setRanges(e.target.value)} />
          <div className="row">
            <button disabled={!ranges.trim()} onClick={() => actions.split(ranges)}>{m.panel.byRanges}</button>
            <button onClick={() => actions.split(null)}>{m.panel.everyPage}</button>
          </div>
          <p className="hint">{m.panel.splitHint}</p>
        </Section>

        <Ocr doc={doc} selectedCount={selectedCount} actions={actions} />
        <Stamps actions={actions} scope={scope} />
        <Redaction doc={doc} actions={actions} />

        <Section title={m.panel.sanitize}>
          <p className="hint">{m.panel.sanitizeHint}</p>
          <button onClick={actions.sanitize}>{m.panel.sanitizeButton}</button>
        </Section>

        <Section title={m.panel.digitalSignature} count={doc.signatures.length || undefined}>
          <p className="hint">{m.panel.digitalSignatureHint}</p>
          <button onClick={actions.digitalSign}>{m.panel.signWithId}</button>
        </Section>

        <Section title={m.panel.forms} count={widgets || undefined}>
          <p className="hint">{m.panel.formFields(widgets)}</p>
          <div className="row">
            <button onClick={actions.designForm}>{m.panel.designForm}</button>
            <button onClick={actions.detectFields}>{m.panel.detectFields}</button>
          </div>
          <p className="hint">{m.panel.designHint}</p>
          <div className="row">
            <button disabled={!widgets} onClick={() => actions.flatten(false, true)}>{m.panel.flattenForm}</button>
            <button disabled={!annots} onClick={() => actions.flatten(true, false)}>{m.panel.flattenComments}</button>
          </div>
          <p className="hint">{m.panel.flattenHint}</p>
        </Section>

        <SaveSettings doc={doc} saveOpts={saveOpts} onSaveOpts={onSaveOpts} />

        <Section title={m.panel.export}>
          <div className="row">
            <button onClick={actions.exportImages}>{m.panel.exportPng}</button>
            <button onClick={actions.exportText}>{m.panel.exportText}</button>
            <button onClick={actions.exportHtml}>{m.panel.exportHtml}</button>
          </div>
        </Section>

        <Section title={m.panel.archive}>
          <select value={pdfaPart} aria-label={m.panel.archive} onChange={(e) => setPdfaPart(Number(e.target.value) as 2 | 3)}>
            {([2, 3] as const).map((p) => <option key={p} value={p}>{m.panel.pdfaParts[p]}</option>)}
          </select>
          <div className="row">
            <button onClick={() => actions.savePdfA(pdfaPart)}>{m.panel.savePdfA}</button>
            <button onClick={actions.checkPdfA}>{m.panel.checkPdfA}</button>
          </div>
          <p className="hint">{m.panel.pdfaHint}</p>
        </Section>

        <Section title={m.panel.properties}>
          {metaKeys.map(([k, label]) => (
            <Field key={k} label={label}>
              <input key={doc.meta[k]} defaultValue={doc.meta[k]} onBlur={(e) => e.target.value !== doc.meta[k] && actions.setMeta({ ...doc.meta, [k]: e.target.value })} />
            </Field>
          ))}
        </Section>
      </div>
    </aside>
  )
}
