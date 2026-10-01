import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { diff } from '../src/engine/compare'

/** A contract as lines of text on pages, plus an optional filled box (a logo, say) on page 1. */
function contract(pages: string[][], box?: [number, number, number, number]) {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  for (const [i, lines] of pages.entries()) {
    const body = lines.map((l, j) => `BT /F1 11 Tf 60 ${760 - j * 16} Td (${l}) Tj ET`).join('\n')
    const art = i === 0 && box ? `\n0.2 0.3 0.8 rg ${box.join(' ')} re f` : ''
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, body + art))
  }
  const e = new Engine()
  e.open('c.pdf', d.saveToBuffer('').asUint8Array().slice())
  return e
}

const V1 = [
  [
    'This agreement is made between the Supplier and the Customer.',
    'The Supplier will deliver the goods within 30 days of the order.',
    'Payment is due within 60 days of the invoice date.',
    'Either party may end this agreement with written notice.',
    'Late payments carry interest at the statutory rate.',
  ],
]
const V2 = [
  [
    'This agreement is made between the Supplier and the Customer.',
    'The Supplier will deliver the goods within 14 days of the order.',
    'Payment is due within 60 days of the invoice date.',
    'Late payments carry interest at the statutory rate.',
    'All prices exclude value added tax.',
    'Either party may end this agreement with written notice.',
  ],
]

describe('compare', () => {
  it('diffs sequences', () => {
    const ops = diff('a b c d e'.split(' '), 'a x c d f e'.split(' '))
    expect(ops.map((o) => o.op).join(',')).toBe('eq,del,ins,eq,eq,ins,eq')
    expect(diff([], ['a']).map((o) => o.op)).toEqual(['ins'])
    expect(diff(['a'], []).map((o) => o.op)).toEqual(['del'])
  })

  it('finds changed, inserted, deleted and moved text', () => {
    const older = contract(V1)
    const newer = contract(V2)
    const { changes, visual } = newer.compareWith(older)
    const summary = changes.map((c) => [c.kind, c.old?.text ?? null, c.new?.text ?? null])
    expect(summary).toContainEqual(['change', '30', '14'])
    expect(summary).toContainEqual(['insert', null, 'All prices exclude value added tax.'])
    expect(summary).toContainEqual(['move', 'Either party may end this agreement with written notice.', 'Either party may end this agreement with written notice.'])
    expect(changes).toHaveLength(3)
    expect(visual).toEqual([])
    const change = changes.find((c) => c.kind === 'change')!
    expect(change.new!.rects[0].rect[1]).toBeGreaterThan(842 - 760 - 16)
  })

  it('reports graphics that changed outside text', () => {
    const older = contract(V1, [400, 100, 80, 40])
    const newer = contract(V1, [400, 100, 120, 40])
    const { changes, visual } = newer.compareWith(older)
    expect(changes).toEqual([])
    expect(visual).toHaveLength(1)
    const [x0, , x1] = visual[0].rect
    expect(x0).toBeGreaterThanOrEqual(470)
    expect(x1).toBeLessThanOrEqual(530)
  })

  it('compares two revisions of a long contract quickly', () => {
    const clause = (i: number) => `Clause ${i}. The parties agree to the terms set out in schedule ${i % 7} of this agreement.`
    const pages = (edit: boolean) => Array.from({ length: 60 }, (_, p) =>
      Array.from({ length: 40 }, (_, l) => {
        const n = p * 40 + l
        return edit && n % 97 === 0 ? clause(n).replace('agree', 'have agreed') : clause(n)
      }))
    const older = contract(pages(false))
    const newer = contract(pages(true))
    const t = performance.now()
    const { changes } = newer.compareWith(older)
    const ms = performance.now() - t
    expect(changes.length).toBe(Math.ceil(2400 / 97))
    expect(changes.every((c) => c.kind === 'change')).toBe(true)
    expect(ms).toBeLessThan(20_000)
  }, 60_000)
})
