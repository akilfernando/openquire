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
  required: boolean
  tooltip: string
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
  links: LinkInfo[]
}

export interface LinkInfo {
  /** Position in the page's link list. */
  index: number
  rect: Rect
  uri: string
  /** Target page index for internal links, -1 for web links. */
  page: number
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

export interface SignatureInfo {
  field: string
  signer: string
  email: string
  issuer: string
  signedAt: string | null
  reason: string
  location: string
  /** The signed bytes are intact and the signature matches the certificate. */
  valid: boolean
  /** False when later revisions were appended after this signature. */
  coversWholeFile: boolean
  selfSigned: boolean
  problem: string | null
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
  /** Signatures as they were when the file was opened. */
  signatures: SignatureInfo[]
}

/** A recognized word, in page space. */
export interface OcrWord {
  text: string
  bbox: Rect
  /** Baseline y and font size estimated from the word's line. */
  baseline: number
  size: number
}

export interface SignRequest {
  p12: Uint8Array
  password: string
  /** Page for a visible signature box; null for an invisible signature. */
  pageId: number | null
  rect?: Rect
  reason?: string
  location?: string
  image?: Uint8Array
  /** Name of an empty signature field to sign into. */
  field?: string
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

/** A paragraph of page text: consecutive lines from one text block. */
export interface TextBlock {
  bbox: Rect
  lines: TextLine[]
  /** The paragraph's text, with its lines joined by spaces (or newlines for short lines). */
  text: string
  align: 'left' | 'center' | 'right' | 'justify'
  /** Distance between baselines, in points. */
  leading: number
  size: number
  font: string
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

/** Page numbering styles: decimal, lower/upper Roman, lower/upper letters, or prefix only. */
export type PageLabelStyle = 'D' | 'r' | 'R' | 'a' | 'A' | 'none'

/** An image drawn on a page, identified by its order among the page's image draws. */
export interface PageImage {
  index: number
  rect: Rect
}

export type FieldKind = 'text' | 'multiline' | 'checkbox' | 'radio' | 'choice' | 'signature'

export interface FieldProps {
  name?: string
  required?: boolean
  readOnly?: boolean
  tooltip?: string
  multiline?: boolean
  /** 0 removes the limit. */
  maxLen?: number
  options?: string[]
}

export interface SanitizeOptions {
  metadata?: boolean
  attachments?: boolean
  /** JavaScript and other active actions (launch, submit, multimedia). */
  scripts?: boolean
  comments?: boolean
  links?: boolean
  bookmarks?: boolean
  formData?: 'keep' | 'clear' | 'flatten'
  /** Text that is never drawn, including OCR text layers. */
  hiddenText?: boolean
  hiddenLayers?: boolean
}

export type SanitizeReport = Record<'metadata' | 'attachments' | 'scripts' | 'comments' | 'links' | 'bookmarks' | 'formFields' | 'hiddenText' | 'hiddenLayers' | 'signatures', number>
