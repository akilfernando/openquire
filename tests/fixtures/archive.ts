import * as mupdf from 'mupdf'
import { Engine } from '../../src/engine/core'

/** A realistic source: standard (non-embedded) fonts, a comment, a form field, a link, bookmarks and an attachment. */
export function archiveSource() {
  const d = new mupdf.PDFDocument()
  const helv = d.addSimpleFont(new mupdf.Font('Helvetica'))
  for (let i = 0; i < 2; i++)
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, `BT /F1 16 Tf 60 760 Td (Archive page ${i + 1}) Tj ET 0 0 1 rg 60 600 200 80 re f`))
  const sourceBytes = d.saveToBuffer('').asUint8Array().slice()
  const e = new Engine()
  const s = e.open('source.pdf', sourceBytes)
  d.destroy()
  const [p1, p2] = s.pages.map((p) => p.id)
  e.addAnnot(p1, { type: 'FreeText', at: [60, 120], text: 'Reviewed', size: 12, color: [1, 0, 0] })
  e.addField(p1, 'text', [60, 200, 260, 222], { name: 'Name' })
  e.addLink(p1, [60, 600 - 80, 260, 600], 1)
  e.addBookmark('Chapter one', 0)
  e.addBookmark('Chapter two', 1)
  e.setMeta({ title: 'Annual archive', author: 'Records team', subject: '', keywords: 'archive, test' })
  e.attach('data.csv', new TextEncoder().encode('a,b\n1,2'), 'text/csv')
  return { e, p2 }
}
