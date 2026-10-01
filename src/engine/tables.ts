/**
 * Table detection from page layout. Words are grouped into rows by baseline, rows are split into
 * cells where words sit far apart, and runs of consecutive multi-cell rows become tables whose
 * columns are the bands between the whitespace gutters the rows share.
 */
import * as mupdf from 'mupdf'
import type { Rect } from './types'

export interface PageWord {
  text: string
  rect: Rect
  size: number
  bold: boolean
}

export interface Table {
  bbox: Rect
  /** Column bands, left to right, in page space. */
  columns: [number, number][]
  rows: { rect: Rect; cells: string[]; bold: boolean }[]
}

/** Every word on a page, in page space, with its font size and weight. */
export function pageWords(page: mupdf.Page): PageWord[] {
  const words: PageWord[] = []
  let cur: PageWord | null = null
  const end = () => {
    if (cur) words.push(cur)
    cur = null
  }
  const st = page.toStructuredText('preserve-whitespace')
  st.walk({
    onChar(c, _origin, font, size, quad) {
      if (!c.trim()) return end()
      const q = quad as number[]
      const r: Rect = [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])]
      // A wide gap between letters also ends a word, as table cells are often set that way.
      if (cur && r[0] - cur.rect[2] > size * 0.6) end()
      if (!cur) cur = { text: c, rect: r, size, bold: font.isBold() || /bold|black|heavy|semibold/i.test(font.getName()) }
      else {
        cur.text += c
        cur.rect = [Math.min(cur.rect[0], r[0]), Math.min(cur.rect[1], r[1]), Math.max(cur.rect[2], r[2]), Math.max(cur.rect[3], r[3])]
      }
    },
    endLine: end,
  })
  st.destroy()
  return words
}

interface Row {
  words: PageWord[]
  rect: Rect
  /** Cells: runs of words separated by wide gaps. */
  cells: PageWord[][]
}

function rowsOf(words: PageWord[]): Row[] {
  const sorted = [...words].sort((a, b) => (a.rect[1] + a.rect[3]) / 2 - (b.rect[1] + b.rect[3]) / 2)
  const rows: PageWord[][] = []
  for (const w of sorted) {
    const cy = (w.rect[1] + w.rect[3]) / 2
    const row = rows.at(-1)
    const ref = row?.[0]
    if (row && ref && Math.abs(cy - (ref.rect[1] + ref.rect[3]) / 2) < Math.min(ref.size, w.size) * 0.5) row.push(w)
    else rows.push([w])
  }
  return rows.map((ws) => {
    ws.sort((a, b) => a.rect[0] - b.rect[0])
    const cells: PageWord[][] = [[ws[0]]]
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].rect[0] - ws[i - 1].rect[2]
      if (gap > Math.max(ws[i].size, ws[i - 1].size) * 1.1) cells.push([ws[i]])
      else cells.at(-1)!.push(ws[i])
    }
    const rect: Rect = [Math.min(...ws.map((w) => w.rect[0])), Math.min(...ws.map((w) => w.rect[1])), Math.max(...ws.map((w) => w.rect[2])), Math.max(...ws.map((w) => w.rect[3]))]
    return { words: ws, rect, cells }
  })
}

/** Column bands: the x ranges covered by the run's words, split at shared gutters. */
function bandsOf(rows: Row[]): [number, number][] {
  const spans = rows.flatMap((r) => r.cells.map((c) => [c[0].rect[0], c.at(-1)!.rect[2]] as [number, number])).sort((a, b) => a[0] - b[0])
  const bands: [number, number][] = []
  for (const [a, b] of spans) {
    const last = bands.at(-1)
    if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b)
    else bands.push([a, b])
  }
  return bands
}

function toTable(run: Row[]): Table | null {
  const columns = bandsOf(run)
  if (columns.length < 2) return null
  const rows = run.map((r) => {
    const cells = columns.map(([a, b]) => r.words.filter((w) => w.rect[0] >= a - 0.5 && w.rect[2] <= b + 0.5).map((w) => w.text).join(' '))
    return { rect: r.rect, cells, bold: r.words.every((w) => w.bold) }
  })
  // Most rows should fill at least two columns.
  if (rows.filter((r) => r.cells.filter(Boolean).length >= 2).length < rows.length * 0.6) return null
  // Two columns of running text are a page layout, not a table.
  const wordy = columns.filter((_, c) => {
    const filled = rows.map((r) => r.cells[c]).filter(Boolean)
    return filled.length && filled.reduce((n, t) => n + t.split(' ').length, 0) / filled.length > 6
  })
  if (wordy.length >= 2) return null
  const bbox: Rect = [
    Math.min(...run.map((r) => r.rect[0])), Math.min(...run.map((r) => r.rect[1])),
    Math.max(...run.map((r) => r.rect[2])), Math.max(...run.map((r) => r.rect[3])),
  ]
  return { bbox, columns, rows }
}

/** Tables on a page, top to bottom. */
export function detectTables(words: PageWord[]): Table[] {
  const rows = rowsOf(words)
  const tables: Table[] = []
  let run: Row[] = []
  const flush = () => {
    const enough = run.length >= 3 || (run.length >= 2 && run.every((r) => r.cells.length >= 3))
    const t = enough ? toTable(run) : null
    if (t) tables.push(t)
    run = []
  }
  for (const row of rows) {
    const prev = run.at(-1)
    const height = row.rect[3] - row.rect[1]
    const near = prev && row.rect[1] - prev.rect[3] < height * 2.2
    if (row.cells.length >= 2 && (!prev || near)) run.push(row)
    else {
      flush()
      if (row.cells.length >= 2) run.push(row)
    }
  }
  flush()
  return tables
}
