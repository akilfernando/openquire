import { expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'

it('sets, round-trips and removes page labels', () => {
  const d = new mupdf.PDFDocument()
  for (let i = 0; i < 6; i++) d.insertPage(-1, d.addPage([0, 0, 200, 200], 0, {}, ''))
  const e = new Engine()
  let s = e.open('book.pdf', d.saveToBuffer('').asUint8Array().slice())
  const ids = s.pages.map((p) => p.id)
  e.setPageLabels(ids[0], 'r')
  s = e.setPageLabels(ids[3], 'D', '', 1)
  expect(s.pages.map((p) => p.label)).toEqual(['i', 'ii', 'iii', '1', '2', '3'])
  s = e.setPageLabels(ids[5], 'A', 'App-', 1)
  expect(s.pages.at(-1)!.label).toBe('App-A')

  const r = new Engine().open('r.pdf', e.save({ compress: 'standard', security: { mode: 'keep' } }))
  expect(r.pages.map((p) => p.label)).toEqual(['i', 'ii', 'iii', '1', '2', 'App-A'])

  s = e.removePageLabels(ids[3])
  expect(s.pages.map((p) => p.label).slice(0, 5)).toEqual(['i', 'ii', 'iii', 'iv', 'v'])
  s = e.undo()
  expect(s.pages[3].label).toBe('1')
})
