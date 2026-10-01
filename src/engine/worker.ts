/// <reference lib="webworker" />
import { Engine, PasswordError } from './core'

/** One engine per open document (workspace tab), keyed by document id. */
const engines = new Map<number, Engine>()
// Settings shared by every document, applied to engines created later too.
let author = 'OpenQuire user'
let trusted: string[] = []

// Smart card signing happens outside the worker (in the desktop shell), so the engine asks the
// main thread and waits for its answer.
const waiting = new Map<number, { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }>()
let nextCallback = 1
function signOnDevice(key: unknown, digestInfo: Uint8Array) {
  const id = nextCallback++
  return new Promise<Uint8Array>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    self.postMessage({ callback: id, kind: 'token-sign', key, digestInfo })
  })
}

function create() {
  const e = new Engine()
  e.externalSigner = signOnDevice
  e.author = author
  if (trusted.length) e.setTrustedCertificates(trusted)
  return e
}

export interface Request {
  id: number
  /** The document the call is for. */
  doc: number
  method: string
  args: unknown[]
}

self.onmessage = async ({ data }: MessageEvent<Request | { callbackReply: number; result?: Uint8Array; error?: string }>) => {
  if ('callbackReply' in data) {
    const w = waiting.get(data.callbackReply)
    waiting.delete(data.callbackReply)
    if (data.error !== undefined) w?.reject(new Error(data.error))
    else w?.resolve(data.result!)
    return
  }
  const { id, doc, method, args } = data
  try {
    if (method === 'setAuthor') {
      author = String(args[0] || 'OpenQuire user')
      for (const e of engines.values()) e.author = author
      return self.postMessage({ id, result: null })
    }
    if (method === 'closeDocument') {
      engines.get(doc)?.close()
      engines.delete(doc)
      return self.postMessage({ id, result: null })
    }
    let engine = engines.get(doc)
    if (!engine) engines.set(doc, (engine = create()))
    if (method === 'setTrustedCertificates') {
      trusted = args[0] as string[]
      for (const [d, e] of engines) if (d !== doc) e.setTrustedCertificates(trusted)
    }
    if (method === 'compareWith') {
      const older = engines.get(args[0] as number)
      if (!older) throw new Error('The other document is no longer open')
      args[0] = older
    }
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    if (typeof fn !== 'function') throw new Error(`Unknown engine method ${method}`)
    const result = await fn.apply(engine, args)

    if (method === 'render') {
      const { width, height, pixels } = result as ReturnType<Engine['render']>
      const bitmap = await createImageBitmap(new ImageData(pixels, width, height))
      return self.postMessage({ id, result: bitmap }, [bitmap])
    }
    const transfer: Transferable[] = []
    if (result instanceof Uint8Array) transfer.push(result.buffer)
    self.postMessage({ id, result }, transfer)
  } catch (e) {
    const err = e as Error
    self.postMessage({
      id,
      error: { name: err.name, message: err.message, file: (e as PasswordError).file, retry: (e as PasswordError).retry },
    })
  }
}

// Messages that arrive while MuPDF's WebAssembly is still loading can be dropped, so the
// client waits for this before sending anything.
self.postMessage({ ready: true })
