/**
 * Types for OpenQuire plugins, plugin API version 1.
 * https://akilfernando.dev/openquire/docs/plugins.html
 *
 * Use them from JavaScript with JSDoc:
 *   /** @param {import('./openquire-plugin').PluginApi} api *\/
 *   export default function activate(api) { ... }
 */

export type Permission = 'document:read' | 'document:write' | 'network'

export interface Manifest {
  /** Reverse-domain style id, e.g. "dev.example.csv-export". */
  id: string
  name: string
  /** Your plugin's own version, e.g. "1.2.0". */
  version: string
  description?: string
  author?: string
  /** The plugin API version you wrote against: 1. */
  apiVersion: 1
  permissions: Permission[]
}

/** A sidebar pane's content, drawn by OpenQuire in its own style. */
export type PaneElement =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'button'; id: string; label: string; primary?: boolean }
  | { type: 'input'; id: string; label: string; value?: string; placeholder?: string }
  | { type: 'list'; items: string[] }

export interface DocumentInfo {
  name: string
  pageCount: number
  pages: { index: number; width: number; height: number; label: string }[]
  meta: { title: string; author: string; subject: string; keywords: string }
}

type Rgb = [number, number, number]
type PageSet = 'all' | 'odd' | 'even' | string

/** Steps document.runStep accepts: the same steps as OpenQuire workflows (except saving and OCR). */
export type WorkflowStep =
  | { action: 'rotate'; pages: PageSet; delta: 90 | 180 | 270 }
  | { action: 'deletePages'; pages: PageSet }
  | { action: 'stamp'; pages: PageSet; stamp: { template: string; position: 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br' | 'center'; size: number | 'fit'; color: Rgb; opacity: number; angle: number; batesStart?: number; batesDigits?: number } }
  | { action: 'markTerms'; terms: string[] }
  | { action: 'markPatterns'; patterns: string[] }
  | { action: 'applyRedactions' }
  | { action: 'flatten'; annots: boolean; widgets: boolean }
  | { action: 'sanitize'; options: { metadata?: boolean; attachments?: boolean; scripts?: boolean; comments?: boolean; links?: boolean; bookmarks?: boolean; formData?: 'keep' | 'clear' | 'flatten'; hiddenText?: boolean; hiddenLayers?: boolean } }
  | { action: 'setMeta'; meta: Partial<DocumentInfo['meta']> }
  | { action: 'detectFields' }
  | { action: 'tag'; lang: string }

export interface PluginApi {
  apiVersion: 1
  manifest: Manifest
  commands: {
    /** Adds a command to the palette. With workflow: true it can be recorded as a workflow step. */
    add(command: { id: string; name: string; workflow?: boolean; run: () => unknown }): void
  }
  panes: {
    add(pane: { id: string; title: string; content: PaneElement[]; onEvent?: (e: { element: string; values: Record<string, string> }) => unknown }): void
    update(id: string, content: PaneElement[]): void
  }
  tools: {
    /** A dock tool. Points are in PDF points from the page's top-left corner. */
    add(tool: { id: string; name: string; onClick: (e: { page: number; x: number; y: number }) => unknown }): void
  }
  document: {
    /** Needs document:read. Pages are numbered from 0. */
    info(): Promise<DocumentInfo>
    pageText(page: number): Promise<string>
    search(text: string): Promise<{ page: number; snippet: string }[]>
    /** The document as PDF bytes. */
    bytes(): Promise<Uint8Array>
    /** Needs document:write. Each call is one undoable change. */
    runStep(step: WorkflowStep): Promise<void>
    addNote(page: number, x: number, y: number, text: string): Promise<void>
  }
  ui: {
    notice(text: string): Promise<void>
    /** Offers a file to the user: how plugins add export formats. */
    download(name: string, data: Uint8Array | string, type?: string): Promise<void>
  }
}

export default function activate(api: PluginApi): void | Promise<void>
