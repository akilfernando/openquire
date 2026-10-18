import { fetch as desktopFetch } from '@tauri-apps/plugin-http'
import { isDesktop } from './native'

const RESPONSE_LIMIT = 16 * 1024 * 1024

/** AI uses one transport policy, including the native client on desktop. */
export function createAiFetch(desktop: boolean, browserClient: typeof fetch, nativeClient: typeof desktopFetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS AI endpoint without embedded credentials.')
    const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(sourceSignal ? [sourceSignal] : [])])
    signal.throwIfAborted()
    // Do not forward client options that weaken TLS or choose a proxy. Keys
    // stay at the selected destination; redirects and ambient cookies are off.
    const options: RequestInit = {
      method: init?.method, headers: init?.headers, body: init?.body, signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    }
    try {
      const response = desktop
        ? await nativeClient(input, { ...options, maxRedirections: 0, connectTimeout: 20_000 })
        : await browserClient(input, options)
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new Error('The AI endpoint redirected the request. Use its direct API address.')
      }
      // Consume the non-streaming AI response while cancellation and deadlines
      // are still active, releasing native body resources before returning it.
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body?.getReader()
      if (reader) {
        try {
          while (true) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > RESPONSE_LIMIT) throw new Error('The AI service returned too much data. Try a smaller request.')
            chunks.push(value)
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error }
        finally { reader.releaseLock() }
      }
      signal.throwIfAborted()
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return new Response(response.body === null ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof Error && /^(The AI endpoint redirected|The AI service returned too much)/.test(error.message)) throw error
      throw new Error('Could not reach the AI service. Check that it is running and the connection address is correct.')
    }
  }
}

export const aiFetch = createAiFetch(isDesktop, (input, init) => fetch(input, init), desktopFetch)
