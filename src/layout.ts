/**
 * The workspace layout, remembered between visits: sidebars, the sidebar tab, zoom and tool
 * preferences, and in the desktop app the documents that were open.
 */
const KEY = 'openquire.layout'

export interface Layout {
  leftOpen: boolean
  rightOpen: boolean
  tab: string
  zoom: number
  colors: { markup: string; draw: string; text: string }
  strokeWidth: number
  fieldKind: string
  /** Desktop app: paths of the open documents, and which one was active. */
  files: string[]
  activeFile: number
}

export function loadLayout(): Partial<Layout> {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // The layout is a convenience; nothing is lost without it.
  }
}
