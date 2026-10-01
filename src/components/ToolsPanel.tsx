import { useState } from 'react'
import { readFields, type FormField } from '../lib/forms'
import { pageText } from '../lib/render'
import { getSource } from '../lib/sources'
import type { Metadata, PageEntry } from '../lib/types'

export type CompressLevel = 'light' | 'medium' | 'strong'

export interface Actions {
  rotate: (delta: 90 | 270) => void
  remove: () => void
  extract: () => void
  insertBlank: () => void
  split: (spec: string | null) => void
  watermark: (text: string) => void
  pageNumbers: () => void
  compress: (level: CompressLevel) => void
  exportImages: () => void
  exportText: () => void
  applyForm: (sourceId: string, fields: FormField[], flatten: boolean) => void
  goTo: (pageId: string) => void
}

interface Props {
  pages: PageEntry[]
  selectedCount: number
  meta: Metadata
  onMeta: (m: Metadata) => void
  actions: Actions
}

function Forms({ pages, actions }: Pick<Props, 'pages' | 'actions'>) {
  const [forms, setForms] = useState<{ sourceId: string; name: string; fields: FormField[] }[] | null>(null)
  const [flatten, setFlatten] = useState(true)

  const detect = async () => {
    const found = []
    for (const sourceId of new Set(pages.map((p) => p.sourceId))) {
      const src = getSource(sourceId)
      const fields = await readFields(src.bytes).catch(() => [])
      if (fields.length) found.push({ sourceId, name: src.name, fields })
    }
    setForms(found)
  }

  const set = (fi: number, i: number, value: string | boolean) =>
    setForms((fs) => fs!.map((f, a) => (a !== fi ? f : { ...f, fields: f.fields.map((x, b) => (b === i ? { ...x, value } : x)) })))

  return (
    <details onToggle={(e) => e.currentTarget.open && void detect()}>
      <summary>Fill forms</summary>
      {forms?.length === 0 && <p className="hint">No form fields found in this document.</p>}
      {forms?.map((form, fi) => (
        <div key={form.sourceId} className="form">
          <p className="hint">{form.name}</p>
          {form.fields.map((f, i) => (
            <label key={f.name} className={f.kind === 'check' ? 'check' : undefined}>
              {f.kind === 'check' ? (
                <input type="checkbox" checked={f.value as boolean} onChange={(e) => set(fi, i, e.target.checked)} />
              ) : null}
              <span>{f.name}</span>
              {f.kind === 'text' && <input value={f.value as string} onChange={(e) => set(fi, i, e.target.value)} />}
              {f.kind === 'choice' && (
                <select value={f.value as string} onChange={(e) => set(fi, i, e.target.value)}>
                  <option value="">—</option>
                  {f.options!.map((o) => <option key={o}>{o}</option>)}
                </select>
              )}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
            <span>Flatten (make answers permanent)</span>
          </label>
          <button
            onClick={() => {
              actions.applyForm(form.sourceId, form.fields, flatten)
              if (flatten) setForms(null)
            }}
          >
            Apply to document
          </button>
        </div>
      ))}
    </details>
  )
}

function Find({ pages, actions }: Pick<Props, 'pages' | 'actions'>) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ id: string; n: number; snippet: string }[] | null>(null)

  const search = async () => {
    const q = query.trim().toLowerCase()
    if (!q) return setHits(null)
    const found = []
    for (const [i, p] of pages.entries()) {
      const text = await pageText(p)
      const at = text.toLowerCase().indexOf(q)
      if (at >= 0) found.push({ id: p.id, n: i + 1, snippet: text.slice(Math.max(0, at - 20), at + q.length + 30).replace(/\s+/g, ' ') })
    }
    setHits(found)
  }

  return (
    <details>
      <summary>Find text</summary>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void search() }}>
        <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button>Find</button>
      </form>
      {hits && <p className="hint">{hits.length ? `Found on ${hits.length} page${hits.length > 1 ? 's' : ''}` : 'No matches'}</p>}
      {hits?.map((h) => (
        <button key={h.id} className="hit" onClick={() => actions.goTo(h.id)}>
          <b>p.{h.n}</b> …{h.snippet}…
        </button>
      ))}
    </details>
  )
}

export default function ToolsPanel({ pages, selectedCount, meta, onMeta, actions }: Props) {
  const [ranges, setRanges] = useState('')
  const [mark, setMark] = useState('CONFIDENTIAL')
  const [level, setLevel] = useState<CompressLevel>('medium')
  const scope = selectedCount ? `${selectedCount} selected` : 'all pages'

  return (
    <aside className="panel">
      <details open>
        <summary>Organize pages</summary>
        <p className="hint">Drag thumbnails to reorder. Ctrl/Shift-click to select several.</p>
        <div className="row">
          <button onClick={() => actions.rotate(270)}>⟲ Rotate left</button>
          <button onClick={() => actions.rotate(90)}>⟳ Rotate right</button>
        </div>
        <p className="hint">Rotation applies to {scope}.</p>
        <div className="row">
          <button disabled={!selectedCount} onClick={actions.remove}>Delete</button>
          <button disabled={!selectedCount} onClick={actions.extract}>Extract to new PDF</button>
        </div>
        <button onClick={actions.insertBlank}>Insert blank page</button>
      </details>

      <details>
        <summary>Split</summary>
        <input placeholder="e.g. 1-3, 4-6, 7-" value={ranges} onChange={(e) => setRanges(e.target.value)} />
        <div className="row">
          <button disabled={!ranges.trim()} onClick={() => actions.split(ranges)}>Split by ranges</button>
          <button onClick={() => actions.split(null)}>One file per page</button>
        </div>
        <p className="hint">Each range becomes its own PDF, downloaded together as a zip.</p>
      </details>

      <details>
        <summary>Watermark &amp; page numbers</summary>
        <input value={mark} onChange={(e) => setMark(e.target.value)} />
        <div className="row">
          <button disabled={!mark.trim()} onClick={() => actions.watermark(mark.trim())}>Add watermark</button>
          <button onClick={actions.pageNumbers}>Add page numbers</button>
        </div>
        <p className="hint">Added to {scope} as editable text.</p>
      </details>

      <Forms pages={pages} actions={actions} />
      <Find pages={pages} actions={actions} />

      <details>
        <summary>Compress &amp; convert</summary>
        <div className="row">
          <select value={level} onChange={(e) => setLevel(e.target.value as CompressLevel)}>
            <option value="light">Light (best quality)</option>
            <option value="medium">Medium</option>
            <option value="strong">Strong (smallest)</option>
          </select>
          <button onClick={() => actions.compress(level)}>Compress</button>
        </div>
        <p className="hint">Compression converts pages to images: ideal for scans, but text stops being selectable.</p>
        <div className="row">
          <button onClick={actions.exportImages}>Export as PNG images</button>
          <button onClick={actions.exportText}>Export text</button>
        </div>
      </details>

      <details>
        <summary>Document properties</summary>
        {(['title', 'author', 'subject', 'keywords'] as const).map((k) => (
          <label key={k}>
            <span>{k[0].toUpperCase() + k.slice(1)}</span>
            <input value={meta[k] ?? ''} onChange={(e) => onMeta({ ...meta, [k]: e.target.value })} />
          </label>
        ))}
        <p className="hint">Written to the file when you save.</p>
      </details>
    </aside>
  )
}
