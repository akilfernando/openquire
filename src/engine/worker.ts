/// <reference lib="webworker" />
import { Engine, PasswordError } from './core'

const engine = new Engine()

export interface Request {
  id: number
  method: string
  args: unknown[]
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  const { id, method, args } = data
  try {
    if (method === 'setAuthor') {
      engine.author = String(args[0] || 'OpenQuire user')
      return self.postMessage({ id, result: null })
    }
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    if (typeof fn !== 'function') throw new Error(`Unknown engine method ${method}`)
    const result = fn.apply(engine, args)

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
