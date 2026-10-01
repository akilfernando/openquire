/**
 * A small PDF content-stream tokenizer. It walks operators with their operands and offsets, so
 * specific operations (an image draw, invisible text, a hidden layer's content) can be patched
 * while the rest of the stream stays byte-for-byte intact.
 */

export type Matrix = [number, number, number, number, number, number]

export interface Operand {
  text: string
  start: number
}

export interface Op {
  op: string
  operands: Operand[]
  /** From the first operand (or the operator itself) to the end of the operator. */
  start: number
  end: number
}

export interface ImageDraw {
  /** Resource name of the image XObject. */
  name: string
  /** Offsets of the `/Name Do` text in the stream. */
  start: number
  end: number
  /** Current transformation matrix at the draw (image unit square to content space). */
  ctm: Matrix
}

export const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
]

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return [1, 0, 0, 1, 0, 0]
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const isSpace = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37

/** Calls `visit` for every operator in a content stream, with its operands and offsets. */
export function tokenize(src: string, visit: (op: Op) => void) {
  let operands: Operand[] = []
  let i = 0
  const n = src.length
  const emit = (op: string, start: number, end: number) => {
    visit({ op, operands, start: operands[0]?.start ?? start, end })
    operands = []
  }

  while (i < n) {
    const c = src.charCodeAt(i)
    if (isSpace(c)) { i++; continue }
    if (c === 37) { // comment
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    const start = i
    if (c === 40) { // literal string with nesting and escapes
      let depth = 0
      for (; i < n; i++) {
        const ch = src[i]
        if (ch === '\\') { i++; continue }
        if (ch === '(') depth++
        else if (ch === ')' && --depth === 0) { i++; break }
      }
      operands.push({ text: src.slice(start, i), start })
      continue
    }
    if (c === 60 && src[i + 1] === '<') { i += 2; operands.push({ text: '<<', start }); continue }
    if (c === 62 && src[i + 1] === '>') { i += 2; operands.push({ text: '>>', start }); continue }
    if (c === 60) { // hex string
      const close = src.indexOf('>', i)
      i = close < 0 ? n : close + 1
      operands.push({ text: src.slice(start, i), start })
      continue
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) { i++; operands.push({ text: src[start], start }); continue }
    if (c === 47) { // name
      i++
      while (i < n && !isSpace(src.charCodeAt(i)) && !isDelim(src.charCodeAt(i))) i++
      operands.push({ text: src.slice(start, i), start })
      continue
    }
    while (i < n && !isSpace(src.charCodeAt(i)) && !isDelim(src.charCodeAt(i))) i++
    const word = src.slice(start, i)
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) || word === 'true' || word === 'false' || word === 'null') {
      operands.push({ text: word, start })
      continue
    }
    if (word === 'BI') {
      // Inline image: its data can contain anything, so skip straight to the EI operator.
      const id = src.indexOf('ID', i)
      let j = id < 0 ? n : id + 3
      while (j < n) {
        const e = src.indexOf('EI', j)
        if (e < 0) { j = n; break }
        if (isSpace(src.charCodeAt(e - 1)) && (e + 2 >= n || isSpace(src.charCodeAt(e + 2)))) { j = e + 2; break }
        j = e + 2
      }
      i = j
      emit('BI', start, i)
      continue
    }
    emit(word, start, i)
  }
}

export const decodeName = (s: string) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

/**
 * Lists every image drawn directly by a content stream. `isImage` says whether a resource
 * name refers to an image XObject (forms are drawn but not descended into).
 */
export function findImageDraws(src: string, isImage: (name: string) => boolean): ImageDraw[] {
  const draws: ImageDraw[] = []
  const stack: Matrix[] = []
  let ctm = IDENTITY
  tokenize(src, ({ op, operands, end }) => {
    if (op === 'q') stack.push(ctm)
    else if (op === 'Q') ctm = stack.pop() ?? IDENTITY
    else if (op === 'cm') {
      const v = operands.slice(-6).map((o) => Number(o.text))
      if (v.length === 6 && v.every(Number.isFinite)) ctm = multiply(v as Matrix, ctm)
    } else if (op === 'Do') {
      const name = operands.at(-1)
      if (name?.text.startsWith('/')) {
        const decoded = decodeName(name.text.slice(1))
        if (isImage(decoded)) draws.push({ name: decoded, start: name.start, end, ctm })
      }
    }
  })
  return draws
}

/**
 * Removes content a reader never sees: text drawn invisibly (render mode 3, as OCR layers do)
 * and content in hidden optional-content layers or hidden form XObjects.
 */
export function stripHidden(
  src: string,
  opts: { invisibleText: boolean; isHiddenLayer: (propertiesName: string) => boolean; isHiddenXObject: (name: string) => boolean },
) {
  const edits: { start: number; end: number; text: string }[] = []
  const counts = { text: 0, layers: 0 }
  const modes: number[] = []
  let mode = 0
  // Marked-content stack: the start offset of a hidden layer's BDC, or null for other sections.
  const marked: (number | null)[] = []
  const inHidden = () => marked.some((m) => m !== null)

  tokenize(src, ({ op, operands, start, end }) => {
    if (op === 'q') modes.push(mode)
    else if (op === 'Q') mode = modes.pop() ?? 0
    else if (op === 'Tr') mode = Number(operands.at(-1)?.text) || 0
    else if (op === 'BMC') marked.push(null)
    else if (op === 'BDC') {
      const [tag, props] = operands
      const hidden = !inHidden() && tag?.text === '/OC' && props?.text.startsWith('/') && opts.isHiddenLayer(decodeName(props.text.slice(1)))
      marked.push(hidden ? start : null)
    } else if (op === 'EMC') {
      const from = marked.pop()
      if (from !== null && from !== undefined) {
        // Drop edits nested inside the removed section, then remove the whole section.
        for (let k = edits.length - 1; k >= 0; k--) if (edits[k].start >= from) edits.splice(k, 1)
        edits.push({ start: from, end, text: '' })
        counts.layers++
      }
    } else if (inHidden()) {
      return
    } else if (op === 'Do' && operands.at(-1)?.text.startsWith('/') && opts.isHiddenXObject(decodeName(operands.at(-1)!.text.slice(1)))) {
      edits.push({ start, end, text: '' })
      counts.layers++
    } else if (opts.invisibleText && mode === 3 && (op === 'Tj' || op === 'TJ' || op === "'" || op === '"')) {
      // Keep the line moves that ' and " make, so any visible text after them stays in place.
      const keep = op === "'" ? 'T*' : op === '"' ? `${operands[0]?.text ?? 0} Tw ${operands[1]?.text ?? 0} Tc T*` : ''
      edits.push({ start, end, text: keep })
      counts.text++
    }
  })
  return { text: patch(src, edits), counts }
}

/** Applies replacements (by offset range) to a stream, working from the end so offsets stay valid. */
export function patch(src: string, edits: { start: number; end: number; text: string }[]) {
  let out = src
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

export const fmt = (m: Matrix) => m.map((v) => +v.toFixed(5)).join(' ')

type Box = [number, number, number, number]

/**
 * The matrix to insert before an image draw (`X cm`) so that the image, drawn with `ctm` on a
 * page whose PDF-to-page transform is `toPage`, moves from the page-space box `from` to `to`.
 * The image's own orientation and any skew are kept.
 */
export function imageWarp(ctm: Matrix, toPage: Matrix, from: Box, to: Box): Matrix {
  const sx = (to[2] - to[0]) / (from[2] - from[0] || 1)
  const sy = (to[3] - to[1]) / (from[3] - from[1] || 1)
  const move: Matrix = [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy]
  const placed = multiply(ctm, toPage)
  return multiply(multiply(placed, move), invert(placed))
}
