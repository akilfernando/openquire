// All annotation coordinates are in "view space": PDF points, origin at the top-left of the
// page as it is displayed with its intrinsic /Rotate applied (but before the user's extra rotation).

export type RectKind = 'highlight' | 'whiteout' | 'redact'

export interface RectAnnot {
  id: string
  type: RectKind
  x: number
  y: number
  w: number
  h: number
  color: string
}

export interface InkAnnot {
  id: string
  type: 'ink'
  points: [number, number][]
  color: string
  width: number
}

export interface TextAnnot {
  id: string
  type: 'text'
  x: number
  y: number
  text: string
  size: number
  color: string
  /** Counter-clockwise degrees around the start of the first baseline. */
  angle?: number
  opacity?: number
}

export interface ImageAnnot {
  id: string
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  dataUrl: string
}

export type Annot = RectAnnot | InkAnnot | TextAnnot | ImageAnnot

export type Rotation = 0 | 90 | 180 | 270

/** One page of the working document: a reference into a source PDF plus pending edits. */
export interface PageEntry {
  id: string
  sourceId: string
  pageIndex: number
  /** Extra rotation applied by the user, on top of the page's own. */
  rotation: Rotation
  /** View-space size in points. */
  width: number
  height: number
  annots: Annot[]
}

export interface Metadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
}

export const uid = () => crypto.randomUUID()

export const TEXT_LINE_HEIGHT = 1.2
