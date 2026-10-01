/**
 * OpenQuire as a Node library: the same PDF engine the app runs, with no browser needed.
 *
 *   import { Engine } from 'openquire'
 *   const e = new Engine()
 *   e.open('in.pdf', bytes)
 *   e.markPattern(REDACTION_PATTERNS.email)
 *   e.applyRedactions()
 *   const out = e.save({ compress: 'standard', security: { mode: 'keep' } })
 */
export { Engine, PasswordError } from '../../src/engine/core'
export { REDACTION_PATTERNS, type PatternName } from '../../src/engine/patterns'
export { parseWorkflow, newWorkflow, resolvePages, type Workflow, type WorkflowStep } from '../../src/engine/workflow'
export { recognize } from './ocr'
export type * from '../../src/engine/types'
