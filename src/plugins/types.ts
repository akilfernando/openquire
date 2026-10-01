/**
 * The plugin API, version 1. These are the types plugin authors work with; they are published
 * with the documentation as openquire-plugin.d.ts.
 */

export const API_VERSION = 1

export type Permission = 'document:read' | 'document:write' | 'network'
export const PERMISSIONS: Permission[] = ['document:read', 'document:write', 'network']

export interface Manifest {
  /** Reverse-domain style id, e.g. "dev.example.csv-export". */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** The plugin API version the plugin was written for. */
  apiVersion: number
  permissions: Permission[]
}

/** A sidebar pane's content: a list of simple elements the app draws in its own style. */
export type PaneElement =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'button'; id: string; label: string; primary?: boolean }
  | { type: 'input'; id: string; label: string; value?: string; placeholder?: string }
  | { type: 'list'; items: string[] }

export interface PageInfo {
  index: number
  width: number
  height: number
  label: string
}

export interface DocumentInfo {
  name: string
  pageCount: number
  pages: PageInfo[]
  meta: { title: string; author: string; subject: string; keywords: string }
}

/** The object passed to a plugin's activate function. Every method returns a promise. */
export interface PluginApi {
  apiVersion: number
  manifest: Manifest
  commands: {
    /** Adds a command to the palette. With workflow: true it can be recorded as a workflow step. */
    add(command: { id: string; name: string; workflow?: boolean; run: () => unknown }): void
  }
  panes: {
    /** Adds a sidebar pane, and calls onEvent when its buttons are pressed. */
    add(pane: { id: string; title: string; content: PaneElement[]; onEvent?: (e: { element: string; values: Record<string, string> }) => unknown }): void
    update(id: string, content: PaneElement[]): void
  }
  tools: {
    /** Adds a tool to the dock; onClick receives the page and the point clicked, in points. */
    add(tool: { id: string; name: string; onClick: (e: { page: number; x: number; y: number }) => unknown }): void
  }
  document: {
    /** Requires document:read. */
    info(): Promise<DocumentInfo>
    pageText(page: number): Promise<string>
    search(text: string): Promise<{ page: number; snippet: string }[]>
    bytes(): Promise<Uint8Array>
    /** Requires document:write. Runs any workflow step, e.g. { action: 'stamp', ... }. */
    runStep(step: Record<string, unknown>): Promise<void>
    addNote(page: number, x: number, y: number, text: string): Promise<void>
  }
  ui: {
    notice(text: string): Promise<void>
    /** Offers a file to the user, e.g. a new export format. */
    download(name: string, data: Uint8Array | string, type?: string): Promise<void>
  }
}

export interface InstalledPlugin {
  manifest: Manifest
  source: string
  enabled: boolean
}

/** Checks a plugin's exported manifest. */
export function validateManifest(data: unknown): Manifest {
  if (!data || typeof data !== 'object') throw new Error('This file has no "export const manifest". See the plugin documentation.')
  const d = data as Partial<Manifest>
  if (typeof d.id !== 'string' || !/^[a-z0-9]+([.-][a-z0-9]+)+$/i.test(d.id)) throw new Error('The manifest needs an id like "dev.example.my-plugin".')
  if (typeof d.name !== 'string' || !d.name.trim()) throw new Error('The manifest needs a name.')
  if (typeof d.version !== 'string') throw new Error('The manifest needs a version.')
  if (d.apiVersion !== API_VERSION) throw new Error(`This plugin needs plugin API version ${d.apiVersion}; this OpenQuire provides version ${API_VERSION}.`)
  const permissions = Array.isArray(d.permissions) ? d.permissions : []
  const unknown = permissions.filter((p) => !PERMISSIONS.includes(p as Permission))
  if (unknown.length) throw new Error(`Unknown permissions: ${unknown.join(', ')}`)
  return {
    id: d.id, name: d.name.trim(), version: d.version, apiVersion: d.apiVersion, permissions: permissions as Permission[],
    description: typeof d.description === 'string' ? d.description : undefined, author: typeof d.author === 'string' ? d.author : undefined,
  }
}
