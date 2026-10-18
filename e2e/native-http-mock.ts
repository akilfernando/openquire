import type { Page } from '@playwright/test'

/** Install the subset of Tauri's HTTP invoke protocol used by plugin-http 2.8.3. */
export async function installNativeHttpMock(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __forwardNativeHttpCommand?: (command: string, args: any, state: any) => Promise<{ handled: boolean; value?: any }>
    }
    target.__forwardNativeHttpCommand = async (command, args, state) => {
      if (!command.startsWith('plugin:http|')) return { handled: false }
      const http = state.http ??= { nextRid: 1, requests: new Map(), responses: new Map(), cancelled: [] as string[] }
      const nextRid = () => String(http.nextRid++)
      if (command === 'plugin:http|fetch') {
        const rid = nextRid()
        const controller = new AbortController()
        const config = args.clientConfig
        const headers = Object.fromEntries(config.headers ?? [])
        const body = config.data == null ? undefined : new Uint8Array(config.data) as BodyInit
        const promise = window.fetch(config.url, {
          method: config.method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
        }).then(async response => ({
          status: response.status,
          statusText: response.statusText,
          url: response.url || config.url,
          headers: [...response.headers.entries()],
          body: new Uint8Array(await response.arrayBuffer()),
        }))
        http.requests.set(rid, { controller, promise })
        return { handled: true, value: rid }
      }
      if (command === 'plugin:http|fetch_send') {
        const request = http.requests.get(String(args.rid))
        if (!request) throw new Error('Unknown native HTTP request')
        let response
        try { response = await request.promise }
        catch (error) { http.requests.delete(String(args.rid)); throw error }
        const rid = nextRid()
        http.responses.set(rid, { body: response.body, offset: 0, requestRid: String(args.rid) })
        return {
          handled: true,
          value: { status: response.status, statusText: response.statusText, url: response.url, headers: response.headers, rid },
        }
      }
      if (command === 'plugin:http|fetch_read_body') {
        const response = http.responses.get(String(args.rid))
        if (!response) return { handled: true, value: [1] }
        if (response.offset >= response.body.length) {
          http.responses.delete(String(args.rid))
          http.requests.delete(response.requestRid)
          return { handled: true, value: [1] }
        }
        const end = Math.min(response.offset + 64 * 1024, response.body.length)
        const chunk = response.body.slice(response.offset, end)
        response.offset = end
        return { handled: true, value: [...chunk, 0] }
      }
      if (command === 'plugin:http|fetch_cancel') {
        const rid = String(args.rid)
        const request = http.requests.get(rid)
        if (request) request.controller.abort()
        http.requests.delete(rid)
        http.cancelled.push(rid)
        return { handled: true, value: null }
      }
      if (command === 'plugin:http|fetch_cancel_body') {
        const rid = String(args.rid)
        const response = http.responses.get(rid)
        if (response) {
          const request = http.requests.get(response.requestRid)
          request?.controller.abort()
          http.requests.delete(response.requestRid)
        }
        http.responses.delete(rid)
        return { handled: true, value: null }
      }
      return { handled: false }
    }
  })
}
