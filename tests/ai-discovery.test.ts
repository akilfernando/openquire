import { afterEach, describe, expect, it, vi } from 'vitest'
import { bounded, discoverLocalModels } from '../src/ai-discovery'

afterEach(() => vi.unstubAllGlobals())
describe('local AI discovery boundaries', () => {
  it('probes only loopback without credentials and rejects redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'local-model' }] })))
    vi.stubGlobal('fetch', fetcher)
    const result = await discoverLocalModels(new AbortController().signal)
    expect(result.models).toEqual(['local-model'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost:11434/v1/models')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: {} })
  })
  it('does not accept unrelated service responses as model catalogues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }))))
    await expect(discoverLocalModels(new AbortController().signal)).rejects.toThrow('model catalogue')
  })
  it('bounds displayed model names and list size', async () => {
    const data = [{ id: 'x'.repeat(201) }, ...Array.from({ length: 150 }, (_, i) => ({ id: `model-${i}` }))]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))))
    const result = await discoverLocalModels(new AbortController().signal)
    expect(result.models).toHaveLength(100)
    expect(result.models[0]).toBe('model-0')
  })
  it('cancels native work publication even if it resolves later', async () => {
    let release!: (value: string) => void
    const pending = new Promise<string>(resolve => { release = resolve })
    const controller = new AbortController()
    const task = bounded(pending, controller.signal)
    controller.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    release('late')
  })
  it('rejects already aborted checks and preserves genuine errors', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(bounded(Promise.resolve('late'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(bounded(Promise.reject(new Error('failed')), new AbortController().signal)).rejects.toThrow('failed')
  })
})
