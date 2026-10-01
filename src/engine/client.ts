import type { Engine } from './core'
import type { Request } from './worker'

type Callable = { [K in keyof Engine]: Engine[K] extends (...a: infer A) => infer R ? (...a: A) => R : never }
type Remote = { [K in keyof Callable as Callable[K] extends never ? never : K]: (...a: Parameters<Callable[K]>) => Promise<ReturnType<Callable[K]>> }

export class EngineError extends Error {
  constructor(name: string, message: string, public file?: string, public retry?: boolean) {
    super(message)
    this.name = name
  }
}

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
let nextId = 1
let markReady: () => void
const ready = new Promise<void>((r) => (markReady = r))

worker.onmessage = ({ data }) => {
  if (data.ready) return markReady()
  const p = pending.get(data.id)
  if (!p) return
  pending.delete(data.id)
  if (data.error) p.reject(new EngineError(data.error.name, data.error.message, data.error.file, data.error.retry))
  else p.resolve(data.result)
}

async function call(doc: number, method: string, args: unknown[]): Promise<unknown> {
  await ready
  const id = nextId++
  const transfer = args.filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, doc, method, args } satisfies Request, transfer)
  })
}

// ---- documents --------------------------------------------------------------------------
// Each workspace tab has its own engine in the worker. `engine` talks to the active one.

let active = 1
let nextDoc = 2

/** The id of the document `engine` currently talks to. */
export const activeDocument = () => active

/** Makes `engine` (and renders that don't name a document) talk to another document. */
export function setActiveDocument(doc: number) {
  active = doc
}

/** Reserves an id for a new, empty document. Its engine is created on first use. */
export function newDocument() {
  return nextDoc++
}

/** Frees a document's engine in the worker, and its pending renders. */
export function closeDocument(doc: number) {
  for (const job of [...queue]) if (job.doc === doc) job.cancel()
  return call(doc, 'closeDocument', [])
}

type Extra = {
  setAuthor(name: string): Promise<null>
  /** Compares with another open document, by its id (the engine itself stays in the worker). */
  compareWith(older: number): Promise<ReturnType<Engine['compareWith']>>
}

/** One document's engine, running in the worker. Every method returns a promise. */
export function engineFor(doc: number | (() => number)) {
  return new Proxy({} as Omit<Remote, 'compareWith'> & Extra, {
    get: (_, method: string) => (...args: unknown[]) => call(typeof doc === 'number' ? doc : doc(), method, args),
  })
}

/** The active document's engine. */
export const engine = engineFor(activeDocument)

// ---- render scheduling ------------------------------------------------------
// Renders are queued here, one in flight at a time, so edits never wait behind a long
// backlog of pages that have already scrolled out of view.

interface Job {
  doc: number
  key: string
  args: [number, number, number | undefined]
  priority: number
  cancelled: boolean
  resolve: (b: ImageBitmap | null) => void
  cancel: () => void
}

const queue: Job[] = []
let busy = false

async function pump() {
  if (busy) return
  const job = queue.sort((a, b) => a.priority - b.priority).shift()
  if (!job) return
  busy = true
  try {
    job.resolve(job.cancelled ? null : ((await call(job.doc, 'render', job.args)) as ImageBitmap))
  } catch {
    job.resolve(null)
  } finally {
    busy = false
    void pump()
  }
}

/** Requests a page bitmap; call the returned cancel function if it's no longer needed. */
export function requestRender(pageId: number, scale: number, priority: number, skipAnnot?: number, doc = active) {
  let job!: Job
  const promise = new Promise<ImageBitmap | null>((resolve) => {
    job = {
      doc, key: `${doc}:${pageId}`, args: [pageId, scale, skipAnnot], priority, cancelled: false, resolve,
      cancel() {
        job.cancelled = true
        const i = queue.indexOf(job)
        if (i >= 0) {
          queue.splice(i, 1)
          job.resolve(null)
        }
      },
    }
  })
  queue.push(job)
  void pump()
  return { promise, cancel: () => job.cancel() }
}
