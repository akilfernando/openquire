/// <reference lib="webworker" />
import { Engine, PasswordError } from './core'

/** One engine per open document (workspace tab), keyed by document id. */
const engines = new Map<number, Engine>()
// Settings shared by every document, applied to engines created later too.
let author = 'OpenQuire user'
let trusted: string[] = []

function create() {
  const e = new Engine()
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

self.onmessage = async ({ data }: MessageEvent<Request>) => {
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
