/**
 * Running workflows in the app: on the open document, or on a batch of files, each opened in its
 * own engine in the worker. OCR steps run here, where the OCR engine lives.
 */
import { zipSync } from 'fflate'
import { closeDocument, engineFor, newDocument } from './engine/client'
import type { DocState } from './engine/types'
import { newWorkflow, parseWorkflow, type Workflow } from './engine/workflow'
import type { OcrOptions } from './ocr'

const STORE = 'openquire.workflows'

export function loadWorkflows(): Workflow[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown[]
    return list.flatMap((w) => {
      try {
        return [parseWorkflow(JSON.stringify(w))]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function saveWorkflows(list: Workflow[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list))
  } catch {
    // Stored on this device only; the workflows still work for this session.
  }
}

export const workflowJson = (wf: Workflow) => JSON.stringify(newWorkflow(wf.name, wf.steps), null, 2)

export interface RunResult {
  state: DocState | null
  /** The finished file, when the workflow ends with a save or PDF/A step. */
  bytes?: Uint8Array
  bates?: number
  notes: string[]
}

/** Runs a workflow's steps on an open document. */
/** Runs a plugin command on a given document, for workflow steps from plugins. */
export type PluginRunner = (plugin: string, command: string, doc: number) => Promise<unknown>

export async function runOnDocument(doc: number, wf: Workflow, bates: number | undefined, ocr: OcrOptions, plugins?: PluginRunner): Promise<RunResult> {
  const engine = engineFor(doc)
  const result: RunResult = { state: null, bates, notes: [] }
  for (const step of wf.steps) {
    if (step.action === 'ocr') {
      const ids = await engine.pagesWithoutText()
      if (!ids.length) continue
      if (step.straighten) await engine.straighten(ids)
      const { recognizePages } = await import('./ocr')
      result.state = (await recognizePages(ids, () => {}, doc, { ...ocr, lang: step.lang ?? ocr.lang })).state ?? result.state
      continue
    }
    if (step.action === 'plugin') {
      if (!plugins) throw new Error(`This workflow needs the plugin ${step.plugin}.`)
      await plugins(step.plugin, step.command, doc)
      result.state = await engine.state()
      continue
    }
    const r = await engine.runStep(step, { bates: result.bates })
    result.state = r.state
    result.bates = r.bates ?? result.bates
    if (r.bytes) result.bytes = r.bytes
    if (r.notes) result.notes.push(...r.notes)
  }
  return result
}

export interface BatchResult {
  zip: Uint8Array
  done: number
  failed: { name: string; error: string }[]
}

/**
 * Runs a workflow on each file in turn and collects the results in a zip, with a report of any
 * files that failed. Bates numbering continues from one file to the next.
 */
export async function runBatch(files: File[], wf: Workflow, ocr: OcrOptions, onProgress: (done: number, total: number, name: string) => void, plugins?: PluginRunner): Promise<BatchResult> {
  const out: Record<string, Uint8Array> = {}
  const failed: BatchResult['failed'] = []
  let bates: number | undefined
  const used = new Set<string>()
  for (const [i, file] of files.entries()) {
    onProgress(i, files.length, file.name)
    const doc = newDocument()
    try {
      const engine = engineFor(doc)
      const state = await engine.open(file.name, new Uint8Array(await file.arrayBuffer()))
      const r = await runOnDocument(doc, wf, bates, ocr, plugins)
      bates = r.bates
      const bytes = r.bytes ?? (await engine.save({ compress: 'standard', security: { mode: 'keep' } }))
      // Two inputs with the same name would otherwise overwrite each other in the zip.
      let name = `${state.name}.pdf`
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${state.name} (${n}).pdf`
      used.add(name.toLowerCase())
      out[name] = bytes
    } catch (e) {
      const err = e as Error
      failed.push({ name: file.name, error: err.name === 'PasswordError' ? 'The file is password protected.' : err.message })
    } finally {
      void closeDocument(doc)
    }
  }
  onProgress(files.length, files.length, '')
  if (failed.length) out['failed.txt'] = new TextEncoder().encode(failed.map((f) => `${f.name}: ${f.error}`).join('\n') + '\n')
  return { zip: zipSync(out, { level: 0 }), done: files.length - failed.length, failed }
}
