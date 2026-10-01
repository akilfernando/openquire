/**
 * Runs installed plugins, each in its own sandbox worker, and answers their API calls. Calls that
 * touch the document are checked against the permissions the user approved at install time.
 */
import { engineFor } from '../engine/client'
import type { DocState } from '../engine/types'
import { parseWorkflow, OUTPUT_ACTIONS, type WorkflowStep } from '../engine/workflow'
import { validateManifest, type InstalledPlugin, type Manifest, type PaneElement, type Permission } from './types'

export interface PluginCommand { plugin: string; id: string; name: string; workflow: boolean }
export interface PluginPane { plugin: string; id: string; title: string; content: PaneElement[] }
export interface PluginTool { plugin: string; id: string; name: string }

/** What the host needs from the app. */
export interface HostContext {
  /** The document plugin calls act on right now (the active tab, or a file in a batch). */
  doc: () => number | null
  applied: (state: DocState, doc: number) => void
  notice: (text: string) => void
  download: (name: string, data: Uint8Array | string, type: string) => void
}

// Written out in full each time: Vite only bundles a worker from this exact pattern.
const sandbox = (name: string) => new Worker(new URL('./sandbox.ts', import.meta.url), { type: 'module', name })

function sourceUrl(source: string) {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}

/** Loads a plugin file in a locked-down sandbox just to read and check its manifest. */
export function inspectPlugin(source: string): Promise<Manifest> {
  const w = sandbox('plugin check')
  const url = sourceUrl(source)
  return new Promise<Manifest>((resolve, reject) => {
    const done = () => {
      w.terminate()
      URL.revokeObjectURL(url)
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error('The plugin took too long to load.'))
    }, 10_000)
    w.onmessage = ({ data }) => {
      clearTimeout(timer)
      done()
      if (data.type === 'manifest') {
        try {
          resolve(validateManifest(data.manifest))
        } catch (e) {
          reject(e)
        }
      } else reject(new Error(data.message ?? 'The plugin could not be loaded.'))
    }
    w.onerror = (e) => {
      clearTimeout(timer)
      done()
      reject(new Error(e.message || 'The plugin could not be loaded.'))
    }
    w.postMessage({ type: 'inspect', url })
  })
}

interface Running {
  manifest: Manifest
  worker: Worker
  url: string
  /** Events waiting for the plugin's answer. */
  waiting: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  /** The document the current event is about; plugin calls in between act on it. */
  docOverride: number | null
}

export class PluginHost {
  private running = new Map<string, Running>()
  private nextEvent = 1
  commands: PluginCommand[] = []
  panes: PluginPane[] = []
  tools: PluginTool[] = []
  errors = new Map<string, string>()
  private listeners = new Set<() => void>()

  constructor(private ctx: HostContext) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private changed() {
    this.commands = [...this.commands]
    this.panes = [...this.panes]
    this.tools = [...this.tools]
    for (const fn of this.listeners) fn()
  }

  /** Starts, stops or restarts plugins to match the installed list. */
  sync(plugins: InstalledPlugin[]) {
    const wanted = new Map(plugins.filter((p) => p.enabled).map((p) => [p.manifest.id, p]))
    for (const id of [...this.running.keys()]) {
      const r = this.running.get(id)!
      const w = wanted.get(id)
      if (!w || w.manifest.version !== r.manifest.version || w.manifest.permissions.join() !== r.manifest.permissions.join()) this.stop(id)
    }
    for (const [id, p] of wanted) if (!this.running.has(id)) this.start(p)
  }

  private stop(id: string) {
    const r = this.running.get(id)
    if (!r) return
    r.worker.terminate()
    URL.revokeObjectURL(r.url)
    for (const w of r.waiting.values()) w.reject(new Error('The plugin was stopped.'))
    this.running.delete(id)
    this.commands = this.commands.filter((c) => c.plugin !== id)
    this.panes = this.panes.filter((c) => c.plugin !== id)
    this.tools = this.tools.filter((c) => c.plugin !== id)
    this.errors.delete(id)
    this.changed()
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id)
  }

  private start(p: InstalledPlugin) {
    const worker = sandbox(`plugin ${p.manifest.id}`)
    const url = sourceUrl(p.source)
    const r: Running = { manifest: p.manifest, worker, url, waiting: new Map(), docOverride: null }
    this.running.set(p.manifest.id, r)
    worker.onmessage = ({ data }) => void this.onMessage(r, data)
    worker.onerror = (e) => {
      this.errors.set(p.manifest.id, e.message || 'The plugin stopped with an error.')
      this.changed()
    }
    worker.postMessage({ type: 'start', url, manifest: p.manifest, network: p.manifest.permissions.includes('network') })
  }

  private async onMessage(r: Running, data: Record<string, unknown>) {
    const id = r.manifest.id
    switch (data.type) {
      case 'error':
        this.errors.set(id, String(data.message))
        this.changed()
        return
      case 'register': {
        const info = data.info as Record<string, unknown>
        const key = String(data.id)
        if (data.kind === 'command') this.commands.push({ plugin: id, id: key, name: String(info.name), workflow: !!info.workflow })
        else if (data.kind === 'pane') this.panes.push({ plugin: id, id: key, title: String(info.title), content: info.content as PaneElement[] })
        else if (data.kind === 'tool') this.tools.push({ plugin: id, id: key, name: String(info.name) })
        this.changed()
        return
      }
      case 'eventDone': {
        const w = r.waiting.get(data.id as number)
        r.waiting.delete(data.id as number)
        if (data.error !== undefined) w?.reject(new Error(String(data.error)))
        else w?.resolve(data.result)
        return
      }
      case 'call': {
        try {
          const result = await this.answer(r, String(data.method), (data.args as unknown[]) ?? [])
          r.worker.postMessage({ type: 'result', id: data.id, result: result ?? null }, result instanceof Uint8Array ? [result.buffer] : [])
        } catch (e) {
          r.worker.postMessage({ type: 'result', id: data.id, error: (e as Error).message })
        }
      }
    }
  }

  private need(r: Running, permission: Permission) {
    if (!r.manifest.permissions.includes(permission)) throw new Error(`${r.manifest.name} doesn't have the ${permission} permission.`)
  }

  private async answer(r: Running, method: string, args: unknown[]): Promise<unknown> {
    const docId = r.docOverride ?? this.ctx.doc()
    const docApi = () => {
      if (docId === null) throw new Error('No document is open.')
      return engineFor(docId)
    }
    const pageIdOf = async (index: unknown) => {
      const ids = await docApi().pageIds()
      const i = Number(index)
      if (!Number.isInteger(i) || i < 0 || i >= ids.length) throw new Error(`There is no page ${index}.`)
      return ids[i]
    }
    switch (method) {
      case 'document.info': {
        this.need(r, 'document:read')
        const s = await docApi().state()
        return { name: s.name, pageCount: s.pages.length, meta: s.meta, pages: s.pages.map((p, index) => ({ index, width: p.width, height: p.height, label: p.label })) }
      }
      case 'document.pageText':
        this.need(r, 'document:read')
        return docApi().pageText(await pageIdOf(args[0]))
      case 'document.search': {
        this.need(r, 'document:read')
        const ids = await docApi().pageIds()
        return (await docApi().search(String(args[0] ?? ''), 200)).map((h) => ({ page: ids.indexOf(h.pageId), snippet: h.snippet }))
      }
      case 'document.bytes':
        this.need(r, 'document:read')
        return docApi().save({ compress: 'standard', security: { mode: 'keep' } })
      case 'document.runStep': {
        this.need(r, 'document:write')
        // Checked like an imported workflow; saving and nested plugin steps aren't allowed here.
        const [step] = parseWorkflow(JSON.stringify({ format: 'openquire-workflow', version: 1, name: 'plugin', steps: [args[0]] })).steps
        if (OUTPUT_ACTIONS.includes(step.action) || step.action === 'ocr' || step.action === 'plugin') throw new Error(`Plugins can't run ${step.action} steps.`)
        const { state } = await docApi().runStep(step as WorkflowStep)
        this.ctx.applied(state, docId!)
        return null
      }
      case 'document.addNote': {
        this.need(r, 'document:write')
        const pageId = await pageIdOf(args[0])
        const { state } = await docApi().addAnnot(pageId, { type: 'Text', at: [Number(args[1]), Number(args[2])], text: String(args[3] ?? ''), color: [1, 0.85, 0.2] })
        this.ctx.applied(state, docId!)
        return null
      }
      case 'panes.update': {
        const pane = this.panes.find((p) => p.plugin === r.manifest.id && p.id === args[0])
        if (pane) {
          pane.content = (args[1] as PaneElement[]) ?? []
          this.changed()
        }
        return null
      }
      case 'ui.notice':
        this.ctx.notice(`${r.manifest.name}: ${String(args[0]).slice(0, 300)}`)
        return null
      case 'ui.download': {
        const name = String(args[0]).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'download'
        this.ctx.download(name, args[1] as Uint8Array | string, String(args[2] ?? 'application/octet-stream'))
        return null
      }
    }
    throw new Error(`Unknown plugin API call ${method}`)
  }

  /** Asks a plugin to handle something, optionally acting on a specific document. */
  dispatch(plugin: string, handler: string, args: unknown[] = [], doc: number | null = null): Promise<unknown> {
    const r = this.running.get(plugin)
    if (!r) return Promise.reject(new Error(`The plugin ${plugin} isn't installed or is turned off.`))
    const id = this.nextEvent++
    r.docOverride = doc
    return new Promise<unknown>((resolve, reject) => {
      r.waiting.set(id, { resolve, reject })
      r.worker.postMessage({ type: 'event', id, handler, args })
    }).finally(() => {
      if (r.docOverride === doc) r.docOverride = null
    })
  }

  runCommand(plugin: string, id: string, doc: number | null = null) {
    return this.dispatch(plugin, `command:${id}`, [], doc)
  }

  paneEvent(plugin: string, pane: string, element: string, values: Record<string, string>) {
    return this.dispatch(plugin, `pane:${pane}`, [{ element, values }])
  }

  toolClick(plugin: string, tool: string, page: number, x: number, y: number) {
    return this.dispatch(plugin, `tool:${tool}`, [{ page, x, y }])
  }

  isRunning(plugin: string) {
    return this.running.has(plugin)
  }
}

// ---- storage ---------------------------------------------------------------------------------

const STORE = 'openquire.plugins'

export function loadPlugins(): InstalledPlugin[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) ?? '[]') as InstalledPlugin[]
    return list.flatMap((p) => {
      try {
        return [{ ...p, manifest: validateManifest(p.manifest) }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function savePlugins(list: InstalledPlugin[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list))
  } catch {
    // Too large for storage: the plugins still run this session.
  }
}
