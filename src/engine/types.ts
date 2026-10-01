// Shared between the engine (worker) and the UI.
// Coordinates are in "page space": PDF points, origin at the top-left of the page as
// displayed, y pointing down, with the page's rotation and crop already applied.

export type Rect = [number, number, number, number]
export type Point = [number, number]
export type Quad = [number, number, number, number, number, number, number, number]
export type RGB = [number, number, number]

export type AnnotShape = 'rect' | 'ink' | 'quads' | 'line' | 'vertices'

export interface AnnotInfo {
  id: number
  type: string
  rect: Rect
  shape: AnnotShape
  contents: string
  author: string
  modified: string | null
  color: string | null
  replyTo: number | null
  fontSize?: number
}

export type WidgetKind = 'text' | 'checkbox' | 'radio' | 'choice' | 'button' | 'signature'

export interface WidgetInfo {
  id: number
  name: string
  kind: WidgetKind
  rect: Rect
  value: string
  /** Appearance state that means "on" for checkboxes and radio buttons. */
  on?: string
  options?: string[]
  multiline: boolean
  readOnly: boolean
  maxLen: number
}

export interface PageInfo {
  /** Object number of the page; stable across reordering and undo. */
  id: number
  /** Changes whenever the page's rendering may have changed. */
  rev: number
  width: number
  height: number
  rotation: number
  label: string
  annots: AnnotInfo[]
  widgets: WidgetInfo[]
}

export interface Bookmark {
  title: string
  page: number
  children: Bookmark[]
}

export interface Metadata {
  title: string
  author: string
  subject: string
  keywords: string
}

export interface Attachment {
  name: string
  size: number
}

export interface DocState {
  name: string
  pages: PageInfo[]
  canUndo: boolean
  canRedo: boolean
  outline: Bookmark[]
  meta: Metadata
  encrypted: boolean
  attachments: Attachment[]
}

export type AnnotSpec =
  | { type: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'; quads: Quad[]; color: RGB }
  | { type: 'Ink'; strokes: Point[][]; color: RGB; width: number }
  | { type: 'FreeText'; at: Point; text: string; size: number; color: RGB }
  | { type: 'Square' | 'Circle'; rect: Rect; color: RGB | null; fill: RGB | null; width: number }
  | { type: 'Line'; a: Point; b: Point; color: RGB; width: number; arrow: boolean }
  | { type: 'Text'; at: Point; text: string; color: RGB }
  | { type: 'Stamp'; rect: Rect; png: Uint8Array }
  | { type: 'Redact'; rect?: Rect; quads?: Quad[] }

export interface AnnotPatch {
  contents?: string
  color?: RGB
  move?: Point
  rect?: Rect
  fontSize?: number
}

export interface TextLine {
  bbox: Rect
  origin: Point
  text: string
  font: string
  size: number
  bold: boolean
  italic: boolean
  serif: boolean
  mono: boolean
  color: RGB
}

export interface SearchHit {
  pageId: number
  pageIndex: number
  quads: Quad[]
  snippet: string
}

export type StampPosition = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br' | 'center'

export interface StampSpec {
  /** Supports {page}, {pages}, {date}, {name} and {bates}. */
  template: string
  position: StampPosition
  size: number | 'fit'
  color: RGB
  opacity: number
  angle: number
  pageIds: number[]
  batesStart?: number
  batesDigits?: number
}

export type CompressLevel = 'none' | 'standard' | 'medium' | 'strong'

export type Permission = 'print' | 'copy' | 'edit' | 'annotate' | 'form' | 'assemble'

export interface SaveOptions {
  compress: CompressLevel
  /** keep: leave as opened; none: remove protection; set: protect with the passwords below. */
  security: { mode: 'keep' | 'none' } | { mode: 'set'; userPassword: string; ownerPassword: string; allow: Permission[] }
}

export const hexOf = (c: RGB) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
export const rgbOf = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
