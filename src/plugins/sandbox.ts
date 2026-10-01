/// <reference lib="webworker" />
/**
 * The sandbox one plugin runs in: a dedicated worker with no access to the page, the user's
 * files or storage. The plugin sees only the API object, which forwards every call to the app.
 * Network access (fetch, XMLHttpRequest, WebSocket, EventSource) is removed unless the plugin
 * declared the "network" permission.
 */

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextCall = 1

function call(method: string, ...args: unknown[]): Promise<unknown> {
  const id = nextCall++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    self.postMessage({ type: 'call', id, method, args })
  })
}

function register(kind: string, id: string, info: Record<string, unknown>, handler?: Handler) {
  if (typeof id !== 'string' || !id) throw new Error(`A ${kind} needs an id.`)
  if (handler) handlers.set(`${kind}:${id}`, handler)
  self.postMessage({ type: 'register', kind, id, info })
}

function lockDown(network: boolean) {
  const scope = self as unknown as Record<string, unknown>
  const blocked = () => {
    throw new Error('This plugin has no network permission.')
  }
  if (!network) for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport']) scope[name] = blocked
  // Nested workers would escape the lockdown.
  for (const name of ['Worker', 'SharedWorker', 'importScripts']) scope[name] = blocked
  // Storage belongs to the app, not plugins.
  for (const name of ['indexedDB', 'caches']) {
    try {
      Object.defineProperty(self, name, { get: blocked, configurable: false })
    } catch {
      scope[name] = undefined
    }
  }
}

function makeApi(manifest: Record<string, unknown>) {
  return Object.freeze({
    apiVersion: 1,
    manifest,
    commands: { add: (c: { id: string; name: string; workflow?: boolean; run: Handler }) => register('command', c.id, { name: c.name, workflow: !!c.workflow }, c.run) },
    panes: {
      add: (p: { id: string; title: string; content: unknown[]; onEvent?: Handler }) => register('pane', p.id, { title: p.title, content: p.content ?? [] }, p.onEvent),
      update: (id: string, content: unknown[]) => void call('panes.update', id, content),
    },
    tools: { add: (t: { id: string; name: string; onClick: Handler }) => register('tool', t.id, { name: t.name }, t.onClick) },
    document: {
      info: () => call('document.info'),
      pageText: (page: number) => call('document.pageText', page),
      search: (text: string) => call('document.search', text),
      bytes: () => call('document.bytes'),
      runStep: (step: unknown) => call('document.runStep', step),
      addNote: (page: number, x: number, y: number, text: string) => call('document.addNote', page, x, y, text),
    },
    ui: {
      notice: (text: string) => call('ui.notice', String(text)),
      download: (name: string, data: Uint8Array | string, type?: string) => call('ui.download', String(name), data, type),
    },
  })
}

self.onmessage = async ({ data }: MessageEvent) => {
  switch (data.type) {
    // Load the plugin: inspect only reads its manifest, start also activates it.
    case 'inspect':
    case 'start': {
      try {
        lockDown(data.type === 'start' && !!data.network)
        const mod = await import(/* @vite-ignore */ data.url)
        if (data.type === 'inspect') return self.postMessage({ type: 'manifest', manifest: JSON.parse(JSON.stringify(mod.manifest ?? null)) })
        if (typeof mod.default !== 'function') throw new Error('The plugin has no default export to activate it.')
        await mod.default(makeApi(data.manifest))
        self.postMessage({ type: 'ready' })
      } catch (e) {
        self.postMessage({ type: 'error', message: (e as Error)?.message ?? String(e) })
      }
      return
    }
    case 'result': {
      const p = pending.get(data.id)
      pending.delete(data.id)
      if (data.error !== undefined) p?.reject(new Error(data.error))
      else p?.resolve(data.result)
      return
    }
    // The app asks the plugin to handle something: a command, a pane event, a tool click.
    case 'event': {
      const h = handlers.get(data.handler)
      try {
        if (!h) throw new Error(`Nothing handles ${data.handler}`)
        const result = await h(...(data.args ?? []))
        self.postMessage({ type: 'eventDone', id: data.id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) })
      } catch (e) {
        self.postMessage({ type: 'eventDone', id: data.id, error: (e as Error)?.message ?? String(e) })
      }
    }
  }
}
