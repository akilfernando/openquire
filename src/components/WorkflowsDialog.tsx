import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Circle, Download, FilePlus2, Play, Trash2, Upload, X } from 'lucide-react'
import { parseWorkflow, type Workflow } from '../engine/workflow'
import { m } from '../i18n'
import Modal from './Modal'

interface Props {
  workflows: Workflow[]
  onChange: (list: Workflow[]) => void
  /** Whether a document is open to run on. */
  hasDocument: boolean
  initial?: number
  onRecord: () => void
  onRunHere: (wf: Workflow) => void
  onRunFiles: (wf: Workflow, files: File[]) => void
  onExport: (wf: Workflow) => void
  onClose: () => void
}

/** Lists saved workflows, edits their steps, and runs them on this document or on many files. */
export default function WorkflowsDialog({ workflows, onChange, hasDocument, initial = 0, onRecord, onRunHere, onRunFiles, onExport, onClose }: Props) {
  const [index, setIndex] = useState(Math.min(initial, Math.max(0, workflows.length - 1)))
  const [error, setError] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const wf = workflows[index] as Workflow | undefined

  const update = (next: Workflow) => onChange(workflows.map((w, i) => (i === index ? next : w)))
  const moveStep = (i: number, d: number) => {
    if (!wf) return
    const steps = [...wf.steps]
    const [s] = steps.splice(i, 1)
    steps.splice(i + d, 0, s)
    // An output step must stay last.
    try {
      update(parseWorkflow(JSON.stringify({ ...wf, steps })))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Modal title={m.workflows.title} onClose={onClose} className="mod-workflows">
      <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        try {
          const imported = parseWorkflow(await f.text())
          onChange([...workflows, imported])
          setIndex(workflows.length)
          setError('')
        } catch (err) {
          setError(m.workflows.importError((err as Error).message))
        }
      }} />
      <input ref={filesRef} type="file" accept=".pdf,application/pdf" multiple hidden onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ''
        if (wf && files.length) onRunFiles(wf, files)
      }} />

      <div className="workflows">
        <nav className="workflow-list" aria-label={m.workflows.title}>
          {workflows.map((w, i) => (
            <button key={i} className={`workflow-item${i === index ? ' is-active' : ''}`} aria-current={i === index ? 'true' : undefined} onClick={() => setIndex(i)}>
              <span className="label">{w.name}</span>
              <span className="muted small tnum">{m.workflows.stepCount(w.steps.length)}</span>
            </button>
          ))}
          {!workflows.length && <div className="empty-note">{m.workflows.empty}</div>}
          <div className="workflow-list-actions">
            <button onClick={onRecord}><Circle size={14} className="rec-dot" />{m.workflows.record}</button>
            <button onClick={() => importRef.current!.click()}><Upload size={14} />{m.workflows.import}</button>
          </div>
        </nav>

        <section className="workflow-detail">
          {wf ? (
            <>
              <label className="field">
                <span>{m.workflows.name}</span>
                <input key={index} defaultValue={wf.name} onBlur={(e) => e.target.value.trim() && e.target.value !== wf.name && update({ ...wf, name: e.target.value.trim() })} />
              </label>
              <div className="pane-heading">{m.workflows.steps}</div>
              {!wf.steps.length && <div className="empty-note">{m.workflows.noSteps}</div>}
              <ol className="workflow-steps">
                {wf.steps.map((s, i) => (
                  <li key={i} className="workflow-step">
                    <span className="tnum muted">{i + 1}</span>
                    <span className="label">{m.workflows.describe(s)}</span>
                    <button className="clickable-icon" aria-label={m.workflows.earlier} title={m.workflows.earlier} disabled={i === 0} onClick={() => moveStep(i, -1)}><ArrowUp size={14} /></button>
                    <button className="clickable-icon" aria-label={m.workflows.later} title={m.workflows.later} disabled={i === wf.steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown size={14} /></button>
                    <button className="clickable-icon" aria-label={m.workflows.removeStep} title={m.workflows.removeStep} onClick={() => update({ ...wf, steps: wf.steps.filter((_, j) => j !== i) })}><X size={14} /></button>
                  </li>
                ))}
              </ol>
              {!['save', 'pdfa'].includes(wf.steps.at(-1)?.action ?? '') && <p className="hint">{m.workflows.outputNote}</p>}
              {error && <p className="error small">{error}</p>}
              <div className="row workflow-actions">
                <button className="cta" disabled={!wf.steps.length} onClick={() => filesRef.current!.click()}><Play size={14} />{m.workflows.runFiles}</button>
                <button disabled={!wf.steps.length || !hasDocument} onClick={() => onRunHere(wf)}><FilePlus2 size={14} />{m.workflows.runHere}</button>
                <button onClick={() => onExport(wf)}><Download size={14} />{m.workflows.export}</button>
                <button className="mod-warning" onClick={() => { onChange(workflows.filter((_, i) => i !== index)); setIndex(Math.max(0, index - 1)) }}>
                  <Trash2 size={14} />{m.workflows.delete}
                </button>
              </div>
            </>
          ) : (
            error && <p className="error small">{error}</p>
          )}
        </section>
      </div>
    </Modal>
  )
}
