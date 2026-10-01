/**
 * Document comparison: text differences (inserted, deleted, changed and moved text) and visual
 * differences (graphics and images that changed where there is no text).
 *
 * Text is compared a line at a time first, then word by word inside each changed stretch of
 * lines. That keeps long documents fast: the expensive word diff only runs where lines differ.
 */
import * as mupdf from 'mupdf'
import type { Rect } from './types'

export interface Word {
  text: string
  page: number
  rect: Rect
}

export interface ChangeSide {
  text: string
  /** Page index of the first word. */
  page: number
  rects: { page: number; rect: Rect }[]
}

export interface Change {
  kind: 'insert' | 'delete' | 'change' | 'move'
  /** Where the text was in the older document (null for insertions). */
  old: ChangeSide | null
  /** Where the text is in the newer document (null for deletions). */
  new: ChangeSide | null
}

export interface VisualChange {
  /** Page index in the newer document, and the matching page in the older one. */
  page: number
  oldPage: number
  rect: Rect
}

/** A highlighted area on a page, for showing a comparison. */
export interface Mark {
  rect: Rect
  kind: Change['kind'] | 'visual'
  active?: boolean
}

export interface Comparison {
  changes: Change[]
  visual: VisualChange[]
  /** Pages only in one of the documents. */
  addedPages: number
  removedPages: number
}

// ---- extraction ------------------------------------------------------------------------------

/** Words grouped into lines, in reading order, with their bounds in page space. */
export function extractLines(doc: mupdf.PDFDocument): { lines: Word[][]; boxes: Rect[][] } {
  const lines: Word[][] = []
  const boxes: Rect[][] = []
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i)
    const st = page.toStructuredText('preserve-whitespace')
    const pageBoxes: Rect[] = []
    let line: Word[] = []
    let word: Word | null = null
    const end = () => {
      if (word) line.push(word)
      word = null
    }
    st.walk({
      beginLine(bbox) {
        line = []
        pageBoxes.push(bbox as Rect)
      },
      onChar(c, _origin, _font, _size, quad) {
        if (!c.trim()) return end()
        const q = quad as number[]
        const r: Rect = [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])]
        if (!word) word = { text: c, page: i, rect: r }
        else {
          word.text += c
          word.rect = [Math.min(word.rect[0], r[0]), Math.min(word.rect[1], r[1]), Math.max(word.rect[2], r[2]), Math.max(word.rect[3], r[3])]
        }
      },
      endLine() {
        end()
        if (line.length) lines.push(line)
      },
    })
    st.destroy()
    page.destroy()
    boxes.push(pageBoxes)
  }
  return { lines, boxes }
}

// ---- diff ------------------------------------------------------------------------------------

type Op = { op: 'eq' | 'del' | 'ins'; a: number; b: number }

/**
 * Myers' O(ND) difference algorithm over two sequences of keys. Returns edit operations with
 * indexes into both sequences (for 'del' only `a` is meaningful, for 'ins' only `b`).
 */
export function diff(a: string[], b: string[]): Op[] {
  // Common prefix and suffix are cheap to strip, and usually most of a revised document.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: Op[] = Array.from({ length: start }, (_, i) => ({ op: 'eq' as const, a: i, b: i }))
  const tail: Op[] = Array.from({ length: a.length - endA }, (_, i) => ({ op: 'eq' as const, a: endA + i, b: endB + i }))
  const A = a.slice(start, endA)
  const B = b.slice(start, endB)
  const n = A.length
  const m = B.length
  const middle: Op[] = []
  if (!n) for (let j = 0; j < m; j++) middle.push({ op: 'ins', a: start, b: start + j })
  else if (!m) for (let i = 0; i < n; i++) middle.push({ op: 'del', a: start + i, b: start })
  else {
    // Very different stretches would make the search quadratic; past a budget, call the
    // remaining stretch a replacement.
    const max = Math.min(n + m, 4000)
    const offset = max
    const v = new Int32Array(2 * max + 2)
    const trace: Int32Array[] = []
    let found = false
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice())
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
        let y = x - k
        while (x < n && y < m && A[x] === B[y]) {
          x++
          y++
        }
        v[offset + k] = x
        if (x >= n && y >= m) {
          found = true
          break
        }
      }
    }
    if (!found) {
      for (let i = 0; i < n; i++) middle.push({ op: 'del', a: start + i, b: start })
      for (let j = 0; j < m; j++) middle.push({ op: 'ins', a: endA, b: start + j })
    } else {
      // Walk the trace back from the end to recover the path.
      let x = n
      let y = m
      const rev: Op[] = []
      for (let d = trace.length - 1; d > 0; d--) {
        const vd = trace[d]
        const k = x - y
        const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1
        const prevX = vd[offset + prevK]
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) rev.push({ op: 'eq', a: start + --x, b: start + --y })
        if (d > 0) {
          if (x === prevX) rev.push({ op: 'ins', a: start + x, b: start + --y })
          else rev.push({ op: 'del', a: start + --x, b: start + y })
        }
      }
      while (x > 0 && y > 0) rev.push({ op: 'eq', a: start + --x, b: start + --y })
      middle.push(...rev.reverse())
    }
  }
  return [...head, ...middle, ...tail]
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

function side(words: Word[]): ChangeSide | null {
  if (!words.length) return null
  return { text: words.map((w) => w.text).join(' '), page: words[0].page, rects: mergeRects(words) }
}

/** One rectangle per run of words on the same line, so highlights read as phrases. */
function mergeRects(words: Word[]) {
  const out: { page: number; rect: Rect }[] = []
  for (const w of words) {
    const last = out.at(-1)
    const r = last?.rect
    const sameLine = last && last.page === w.page && r && Math.abs((r[1] + r[3]) / 2 - (w.rect[1] + w.rect[3]) / 2) < (r[3] - r[1]) / 2 && w.rect[0] >= r[0]
    if (sameLine) last!.rect = [Math.min(r![0], w.rect[0]), Math.min(r![1], w.rect[1]), Math.max(r![2], w.rect[2]), Math.max(r![3], w.rect[3])]
    else out.push({ page: w.page, rect: [...w.rect] as Rect })
  }
  return out
}

/** Text differences between an older and a newer list of lines. */
export function compareText(oldLines: Word[][], newLines: Word[][]): Change[] {
  const runs: { d: Word[]; n: Word[]; moved?: boolean }[] = []
  const key = (l: Word[]) => norm(l.map((w) => w.text).join(' '))
  const ops = diff(oldLines.map(key), newLines.map(key))

  // Gather each run of differing lines into one hunk, then diff its words.
  let i = 0
  while (i < ops.length) {
    if (ops[i].op === 'eq') {
      i++
      continue
    }
    const dels: Word[] = []
    const ins: Word[] = []
    while (i < ops.length && ops[i].op !== 'eq') {
      if (ops[i].op === 'del') dels.push(...oldLines[ops[i].a])
      else ins.push(...newLines[ops[i].b])
      i++
    }
    const words = diff(dels.map((w) => w.text), ins.map((w) => w.text))
    let j = 0
    while (j < words.length) {
      if (words[j].op === 'eq') {
        j++
        continue
      }
      const d: Word[] = []
      const n: Word[] = []
      while (j < words.length && words[j].op !== 'eq') {
        if (words[j].op === 'del') d.push(dels[words[j].a])
        else n.push(ins[words[j].b])
        j++
      }
      runs.push({ d, n })
    }
  }

  // Deleted text (a few words or more) that reappears inside an insertion was moved. The
  // insertion is split around it, as moved text often lands next to new text.
  for (const del of runs.filter((r) => r.n.length === 0 && r.d.length >= 3)) {
    const want = del.d.map((w) => w.text)
    for (const [k, ins] of runs.entries()) {
      if (ins.d.length || ins.moved) continue
      const at = ins.n.findIndex((_, x) => want.every((t, y) => ins.n[x + y]?.text === t))
      if (at < 0) continue
      del.n = ins.n.slice(at, at + want.length)
      del.moved = true
      const parts = [ins.n.slice(0, at), ins.n.slice(at + want.length)].filter((p) => p.length).map((n) => ({ d: [], n }))
      runs.splice(k, 1, ...parts)
      break
    }
  }
  return runs
    .map((r): Change => ({ kind: r.moved ? 'move' : r.d.length && r.n.length ? 'change' : r.d.length ? 'delete' : 'insert', old: side(r.d), new: side(r.n) }))
    .sort((a, b) => order(a) - order(b))
}

/** Sorts changes by where they are in the newer document, deletions by the older one. */
function order(c: Change) {
  const s = c.new ?? c.old!
  const r = s.rects[0]?.rect ?? [0, 0, 0, 0]
  return s.page * 1e6 + r[1] * 1e3 + r[0]
}

// ---- visual differences --------------------------------------------------------------------

const CELL = 8
const SCALE = 1

function grayPixels(doc: mupdf.PDFDocument, index: number) {
  const page = doc.loadPage(index)
  const pix = page.toPixmap([SCALE, 0, 0, SCALE, 0, 0], mupdf.ColorSpace.DeviceGray, false, true)
  const out = { w: pix.getWidth(), h: pix.getHeight(), data: pix.getPixels().slice() }
  pix.destroy()
  page.destroy()
  return out
}

/**
 * Areas of a page pair that look different, outside any text. Text is compared separately, and
 * reflowed text would otherwise mark most of a page as changed.
 */
export function compareVisual(oldDoc: mupdf.PDFDocument, newDoc: mupdf.PDFDocument, oldText: Rect[][], newText: Rect[][]): VisualChange[] {
  const out: VisualChange[] = []
  const pages = Math.min(oldDoc.countPages(), newDoc.countPages())
  for (let p = 0; p < pages; p++) {
    const a = grayPixels(oldDoc, p)
    const b = grayPixels(newDoc, p)
    const w = Math.min(a.w, b.w)
    const h = Math.min(a.h, b.h)
    const cols = Math.ceil(w / CELL)
    const rows = Math.ceil(h / CELL)
    const text = [...(oldText[p] ?? []), ...(newText[p] ?? [])]
    const masked = (cx: number, cy: number) => {
      const x0 = cx * CELL
      const y0 = cy * CELL
      return text.some((r) => x0 + CELL > r[0] * SCALE - 2 && x0 < r[2] * SCALE + 2 && y0 + CELL > r[1] * SCALE - 2 && y0 < r[3] * SCALE + 2)
    }
    const hot = new Uint8Array(cols * rows)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const cell = Math.floor(y / CELL) * cols + Math.floor(x / CELL)
        if (hot[cell]) continue
        if (Math.abs(a.data[y * a.w + x] - b.data[y * b.w + x]) > 48) hot[cell] = 1
      }
    for (let c = 0; c < hot.length; c++) if (hot[c] && masked(c % cols, Math.floor(c / cols))) hot[c] = 0

    // Connected cells become one rectangle.
    const seen = new Uint8Array(hot.length)
    for (let c = 0; c < hot.length; c++) {
      if (!hot[c] || seen[c]) continue
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
      const stack = [c]
      seen[c] = 1
      while (stack.length) {
        const k = stack.pop()!
        const cx = k % cols
        const cy = Math.floor(k / cols)
        x0 = Math.min(x0, cx)
        y0 = Math.min(y0, cy)
        x1 = Math.max(x1, cx)
        y1 = Math.max(y1, cy)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const nk = ny * cols + nx
          if (hot[nk] && !seen[nk]) {
            seen[nk] = 1
            stack.push(nk)
          }
        }
      }
      out.push({ page: p, oldPage: p, rect: [(x0 * CELL) / SCALE, (y0 * CELL) / SCALE, Math.min(w, (x1 + 1) * CELL) / SCALE, Math.min(h, (y1 + 1) * CELL) / SCALE] })
    }
  }
  return out
}

/** A comparison with the page ids of both documents, by page index. */
export interface ComparisonResult extends Comparison {
  oldIds: number[]
  newIds: number[]
}

export function compare(oldDoc: mupdf.PDFDocument, newDoc: mupdf.PDFDocument): Comparison {
  const a = extractLines(oldDoc)
  const b = extractLines(newDoc)
  return {
    changes: compareText(a.lines, b.lines),
    visual: compareVisual(oldDoc, newDoc, a.boxes, b.boxes),
    addedPages: Math.max(0, newDoc.countPages() - oldDoc.countPages()),
    removedPages: Math.max(0, oldDoc.countPages() - newDoc.countPages()),
  }
}
