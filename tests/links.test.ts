import { expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'

it('creates, edits and deletes web and internal links', () => {
  const d = new mupdf.PDFDocument()
  for (let i = 0; i < 3; i++) d.insertPage(-1, d.addPage([0, 0, 300, 400], i === 1 ? 90 : 0, {}, ''))
  const e = new Engine()
  const s0 = e.open('l.pdf', d.saveToBuffer('').asUint8Array().slice())
  const [, p1, p2] = s0.pages.map((p) => p.id)
  e.addLink(p1, [10, 20, 110, 40], 'example.com/docs')
  e.addLink(p1, [10, 60, 110, 80], 'someone@example.com')
  let s = e.addLink(p1, [10, 100, 110, 120], 2)
  expect(s.pages[1].links.map((l) => [l.uri, l.page])).toEqual([
    ['https://example.com/docs', -1],
    ['mailto:someone@example.com', -1],
    [expect.stringContaining('#page=3'), 2],
  ])
  expect(s.pages[1].links[0].rect.map(Math.round)).toEqual([10, 20, 110, 40])

  s = e.updateLink(p1, 0, { target: 'https://openquire.dev', rect: [20, 20, 120, 50] })
  const moved = s.pages[1].links.find((l) => l.uri === 'https://openquire.dev')!
  expect(moved.rect.map(Math.round)).toEqual([20, 20, 120, 50])
  s = e.deleteLink(p1, s.pages[1].links.findIndex((l) => l.uri.startsWith('mailto:')))
  expect(s.pages[1].links).toHaveLength(2)

  // Internal links follow their page when pages move, and survive saving.
  e.movePages([p2], s.pages[0].id)
  const r = new Engine().open('r.pdf', e.save({ compress: 'standard', security: { mode: 'keep' } }))
  const internal = r.pages[2].links.find((l) => l.page >= 0)!
  expect(internal.page).toBe(0)
  expect(e.undo().pages[0].id).not.toBe(p2)
})
