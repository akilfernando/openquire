import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiFetch } from '../src/ai-transport'
import { readFileSync } from 'node:fs'

const endpoint = 'https://api.example.test/v1/chat/completions'

function mockResponse(status = 200, body = '{"ok":true}', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('createAiFetch transport boundaries', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ships native HTTP without a persistent cookie jar or unsafe features', () => {
    const manifest = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
    const dependency = manifest.split('\n').find(line => line.startsWith('tauri-plugin-http ='))!
    expect(dependency).toMatch(/default-features\s*=\s*false/)
    expect(dependency).not.toMatch(/"cookies"|"dangerous-settings"|"unsafe-headers"/)
    const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
    expect(capability.windows).toEqual(['main'])
    expect(capability.remote).toBeUndefined()
    const http = capability.permissions.find((permission: unknown) => typeof permission === 'object' && (permission as { identifier: string }).identifier === 'http:default')
    expect(http.allow).toEqual([{ url: 'https://**:*' }, { url: 'http://**:*' }])
  })

  it('uses the native client on desktop, with redirects and connection wait bounded', async () => {
    const browser = vi.fn<typeof fetch>()
    const native = vi.fn<typeof fetch>().mockResolvedValue(mockResponse())
    const request = createAiFetch(true, browser, native)

    const response = await request(endpoint, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } })

    expect(await response.json()).toEqual({ ok: true })
    expect(browser).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledOnce()
    const options = native.mock.calls[0][1] as RequestInit & { maxRedirections: number; connectTimeout: number }
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', maxRedirections: 0, connectTimeout: 20_000 })
  })

  it('uses browser fetch outside desktop and keeps credentialled HTTP errors intact', async () => {
    const browser = vi.fn<typeof fetch>().mockResolvedValue(mockResponse(401, '{"error":"invalid key"}'))
    const native = vi.fn<typeof fetch>()
    const request = createAiFetch(false, browser, native)

    const response = await request(endpoint, { headers: { authorization: 'Bearer secret' } })

    expect(native).not.toHaveBeenCalled()
    expect(browser).toHaveBeenCalledOnce()
    const options = browser.mock.calls[0][1]!
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('{"error":"invalid key"}')
  })

  it('rejects redirects, cancels their body, and hides response details', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('secret redirect body')) },
      cancel,
    })
    const browser = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 302, headers: { location: 'https://private.example.test/secret-path' },
    }))
    const request = createAiFetch(false, browser, vi.fn<typeof fetch>())

    let rejection: unknown
    try { await request(endpoint) } catch (error) { rejection = error }
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe('The AI endpoint redirected the request. Use its direct API address.')
    expect(cancel).toHaveBeenCalledOnce()
    expect((rejection as Error).message).not.toContain('private.example.test')
    expect((rejection as Error).message).not.toContain('secret redirect body')
  })

  it('sanitizes network errors so provider messages cannot echo API keys', async () => {
    const browser = vi.fn<typeof fetch>().mockRejectedValue(new Error('request failed for Bearer super-secret-key'))
    const request = createAiFetch(false, browser, vi.fn<typeof fetch>())

    await expect(request(endpoint)).rejects.toThrow('Could not reach the AI service. Check that it is running and the connection address is correct.')
    await expect(request(endpoint)).rejects.not.toThrow('super-secret-key')
  })

  it('cancels an oversized response body before rejecting', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)) },
      cancel,
    })
    const browser = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const request = createAiFetch(false, browser, vi.fn<typeof fetch>())

    await expect(request(endpoint)).rejects.toThrow('The AI service returned too much data. Try a smaller request.')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    'file:///tmp/provider',
    'https://user:password@api.example.test/v1/chat/completions',
  ])('rejects unsafe endpoint %s before calling either client', async url => {
    const browser = vi.fn<typeof fetch>()
    const native = vi.fn<typeof fetch>()
    const request = createAiFetch(false, browser, native)

    await expect(request(url)).rejects.toThrow('Use an HTTP or HTTPS AI endpoint without embedded credentials.')
    expect(browser).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  it('does not start a request when the caller has already aborted', async () => {
    const browser = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort()
    const request = createAiFetch(false, browser, vi.fn<typeof fetch>())

    await expect(request(endpoint, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(browser).not.toHaveBeenCalled()
  })

  it('preserves DOMException cancellation while a signal-aware client is waiting', async () => {
    const browser = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const controller = new AbortController()
    const request = createAiFetch(false, browser, vi.fn<typeof fetch>())
    const pending = request(endpoint, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels a body reader when cancellation interrupts response reading', async () => {
    const cancel = vi.fn(async () => {})
    const browser = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = {
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          }),
          cancel,
          releaseLock: vi.fn(),
        }),
      }
      return { body, status: 200, statusText: 'OK', headers: new Headers() } as unknown as Response
    })
    const controller = new AbortController()
    const request = createAiFetch(false, browser, vi.fn<typeof fetch>())
    const pending = request(endpoint, { signal: controller.signal })
    await vi.waitFor(() => expect(browser).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
