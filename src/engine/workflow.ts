/**
 * Workflows: recorded sequences of document operations, saved as JSON so they can be shared and
 * replayed on any number of files.
 */
import type { Metadata, SanitizeOptions, SaveOptions, StampSpec } from './types'
import { parseRanges } from './ranges'

/** Pages a step applies to: "all", "odd", "even", or 1-based ranges such as "1-3, 5, 8-". */
export type PageSet = string

export type WorkflowStep =
  | { action: 'rotate'; pages: PageSet; delta: 90 | 180 | 270 }
  | { action: 'deletePages'; pages: PageSet }
  /** Bates numbers continue from one file to the next when a workflow runs on several files. */
  | { action: 'stamp'; pages: PageSet; stamp: Omit<StampSpec, 'pageIds'> }
  | { action: 'markTerms'; terms: string[] }
  | { action: 'markPatterns'; patterns: string[] }
  | { action: 'applyRedactions' }
  | { action: 'flatten'; annots: boolean; widgets: boolean }
  | { action: 'sanitize'; options: SanitizeOptions }
  | { action: 'setMeta'; meta: Partial<Metadata> }
  | { action: 'detectFields' }
  | { action: 'tag'; lang: string }
  /** Recognizes text on pages that have none. Runs in the app, where the OCR engine lives. */
  | { action: 'ocr'; lang?: string; straighten?: boolean }
  /** Output steps: only the last step may be one of these. */
  | { action: 'save'; options: SaveOptions }
  | { action: 'pdfa'; part: 2 | 3 }

export type StepAction = WorkflowStep['action']

export interface Workflow {
  format: 'openquire-workflow'
  version: 1
  name: string
  steps: WorkflowStep[]
}

export const OUTPUT_ACTIONS: StepAction[] = ['save', 'pdfa']
const ACTIONS: StepAction[] = ['rotate', 'deletePages', 'stamp', 'markTerms', 'markPatterns', 'applyRedactions', 'flatten', 'sanitize', 'setMeta', 'detectFields', 'tag', 'ocr', 'save', 'pdfa']

/** The 0-based page indexes a page set selects in a document of `count` pages. */
export function resolvePages(set: PageSet, count: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i)
  const s = set.trim().toLowerCase()
  if (!s || s === 'all') return all
  if (s === 'odd') return all.filter((i) => i % 2 === 0)
  if (s === 'even') return all.filter((i) => i % 2 === 1)
  // Ranges past the end of a shorter document are clipped rather than failing the whole batch.
  const clipped = s.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part)
    if (m) return `${m[1] || 1}-${Math.min(Number(m[2] || count), count)}`
    return part
  }).filter((part) => Number(part.split('-')[0]) <= count)
  if (!clipped.length) return []
  return [...new Set(parseRanges(clipped.join(','), count).flat())].sort((a, b) => a - b)
}

/** Turns page indexes into the shortest range list, e.g. [0, 1, 2, 4] -> "1-3, 5". */
export function pageSetOf(indexes: number[], count: number): PageSet {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b)
  if (sorted.length === count) return 'all'
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i] + 1}-${sorted[j] + 1}` : `${sorted[i] + 1}`)
    i = j
  }
  return parts.join(', ')
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Checks one step's shape, so imported workflows fail early with a clear message. */
function checkStep(step: unknown, i: number): WorkflowStep {
  const where = `Step ${i + 1}`
  if (!isObj(step) || typeof step.action !== 'string' || !ACTIONS.includes(step.action as StepAction)) throw new Error(`${where} has an unknown action.`)
  const pages = () => {
    if (typeof step.pages !== 'string') throw new Error(`${where} needs a page set.`)
    resolvePages(step.pages, 10_000)
  }
  switch (step.action) {
    case 'rotate':
      pages()
      if (![90, 180, 270].includes(step.delta as number)) throw new Error(`${where} must rotate by 90, 180 or 270 degrees.`)
      break
    case 'deletePages':
      pages()
      break
    case 'stamp':
      pages()
      if (!isObj(step.stamp) || typeof step.stamp.template !== 'string') throw new Error(`${where} needs stamp text.`)
      break
    case 'markTerms':
      if (!isStrings(step.terms)) throw new Error(`${where} needs a list of terms.`)
      break
    case 'markPatterns':
      if (!isStrings(step.patterns)) throw new Error(`${where} needs a list of patterns.`)
      for (const p of step.patterns) new RegExp(p)
      break
    case 'flatten':
      if (typeof step.annots !== 'boolean' || typeof step.widgets !== 'boolean') throw new Error(`${where} must say what to flatten.`)
      break
    case 'sanitize':
      if (!isObj(step.options)) throw new Error(`${where} needs sanitize options.`)
      break
    case 'setMeta':
      if (!isObj(step.meta)) throw new Error(`${where} needs properties.`)
      break
    case 'tag':
      if (typeof step.lang !== 'string') throw new Error(`${where} needs a language.`)
      break
    case 'save':
      if (!isObj(step.options) || !isObj(step.options.security)) throw new Error(`${where} needs save options.`)
      break
    case 'pdfa':
      if (step.part !== 2 && step.part !== 3) throw new Error(`${where} must be PDF/A-2 or PDF/A-3.`)
      break
  }
  return step as WorkflowStep
}

/** Parses and validates workflow JSON. */
export function parseWorkflow(json: string): Workflow {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('This is not a workflow file (it is not valid JSON).')
  }
  if (!isObj(data) || data.format !== 'openquire-workflow') throw new Error('This is not an OpenQuire workflow file.')
  if (data.version !== 1) throw new Error('This workflow was made by a newer version of OpenQuire.')
  if (typeof data.name !== 'string' || !Array.isArray(data.steps)) throw new Error('The workflow has no name or steps.')
  const steps = data.steps.map(checkStep)
  steps.forEach((s, i) => {
    if (OUTPUT_ACTIONS.includes(s.action) && i !== steps.length - 1) throw new Error(`Step ${i + 1} saves the file, so it must be the last step.`)
  })
  return { format: 'openquire-workflow', version: 1, name: data.name, steps }
}

export const newWorkflow = (name: string, steps: WorkflowStep[] = []): Workflow => ({ format: 'openquire-workflow', version: 1, name, steps })
