import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'

const DEJAVU = readFileSync(fileURLToPath(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url)))
const VERAPDF = process.env.VERAPDF

/** An untagged report: a heading, two paragraphs, a picture, a rule, a link and a form field. */
function source() {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('DejaVu', DEJAVU))
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false)
  pixels.clear(128)
  const img = d.addImage(new mupdf.Image(pixels))
  const content = [
    'BT /F1 24 Tf 60 760 Td (Quarterly report) Tj ET',
    '0.5 w 60 745 m 535 745 l S',
    'BT /F1 11 Tf 60 720 Td 14 TL (Revenue grew in every region this quarter, led by new) Tj T* (customers in the north and steady renewals elsewhere.) Tj ET',
    'q 120 0 0 90 60 600 cm /Im1 Do Q',
    'BT /F1 11 Tf 60 570 Td (Costs stayed flat. The full figures follow on the next page.) Tj ET',
  ].join('\n')
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font }, XObject: { Im1: img } }, content))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, 'BT /F1 18 Tf 60 760 Td (Figures) Tj ET BT /F1 11 Tf 60 730 Td (All numbers are unaudited.) Tj ET'))
  const e = new Engine()
  const s = e.open('report.pdf', d.saveToBuffer('').asUint8Array().slice())
  const [p1, p2] = s.pages.map((p) => p.id)
  e.addLink(p1, [60, 270, 300, 285], 1)
  e.addField(p2, 'text', [60, 140, 260, 162], { name: 'Approver' })
  return e
}

function veraPdf(bytes: Uint8Array, flavour: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oq-ua-'))
  const file = join(dir, 'out.pdf')
  writeFileSync(file, bytes)
  try {
    return execFileSync(VERAPDF!, ['--flavour', flavour, '--format', 'text', file], { encoding: 'utf8', shell: process.platform === 'win32' })
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? String(e)
  }
}

describe('accessibility', () => {
  it('reports what an untagged document is missing', () => {
    const { tagged, problems } = source().checkAccessibility()
    expect(tagged).toBe(false)
    const text = problems.map((p) => p.message).join('\n')
    expect(text).toMatch(/not tagged/)
    expect(text).toMatch(/language/)
    expect(text).toMatch(/no title/)
    expect(text).toMatch(/tab order/)
  })

  it('tags headings, paragraphs, figures, links and fields in reading order', () => {
    const e = source()
    const { notes } = e.autoTag('en-US')
    expect(notes.join(' ')).toMatch(/1 figure needs alternate text/)
    const tags = e.tags()
    expect(tags.map((t) => [t.type, t.page])).toEqual([
      ['H1', 0], ['P', 0], ['Figure', 0], ['P', 0], ['Link', 0],
      ['H2', 1], ['P', 1], ['Form', 1],
    ])
    expect(tags[1].text).toContain('Revenue grew')
    expect(tags[1].text).toContain('steady renewals')
    expect(tags[4].text).toBe('Link to page 2')
    // The text is unchanged.
    expect(e.pageText(e.pageIds()[0])).toContain('Quarterly report')

    const before = e.checkAccessibility()
    expect(before.problems.map((p) => p.message)).toEqual(['A figure has no alternate text.'])
    const figure = tags.find((t) => t.type === 'Figure')!
    e.updateTag(figure.id, { alt: 'Bar chart of revenue by region' })
    expect(e.checkAccessibility()).toEqual({ tagged: true, problems: [] })

    if (VERAPDF) expect(veraPdf(e.save({ compress: 'standard', security: { mode: 'keep' } }), 'ua1')).toMatch(/PASS/)
  }, 120_000)

  it('edits and reorders tags as undoable steps', () => {
    const e = source()
    e.autoTag('en-US')
    const [h1, p] = e.tags()
    let tags = e.moveTag(p.id, -1)
    expect(tags.slice(0, 2).map((t) => t.id)).toEqual([p.id, h1.id])
    tags = e.updateTag(h1.id, { type: 'P' })
    expect(tags[1].type).toBe('P')
    e.undo()
    e.undo()
    expect(e.tags().slice(0, 2).map((t) => [t.id, t.type])).toEqual([[h1.id, 'H1'], [p.id, 'P']])
  })

  it('warns about skipped heading levels', () => {
    const e = source()
    e.autoTag('en-US')
    const [h1] = e.tags()
    e.updateTag(h1.id, { type: 'H3' })
    expect(e.checkAccessibility().problems.map((p) => p.message)).toContain('A level 3 heading follows no heading, skipping a level.')
  })

  it('tags a PDF/A file and keeps it valid PDF/A', () => {
    const e = source()
    const r = new Engine()
    r.open('a.pdf', e.convertToPdfA(2).bytes)
    r.autoTag('en-US')
    for (const t of r.tags()) if (t.type === 'Figure') r.updateTag(t.id, { alt: 'Chart' })
    expect(r.checkAccessibility().problems).toEqual([])
    const bytes = r.save({ compress: 'standard', security: { mode: 'keep' } })
    if (process.env.OQ_DUMP) writeFileSync(process.env.OQ_DUMP, bytes)
    if (VERAPDF) {
      expect(veraPdf(bytes, '2b')).toMatch(/PASS/)
      expect(veraPdf(bytes, 'ua1')).toMatch(/PASS/)
    }
  }, 180_000)
})
