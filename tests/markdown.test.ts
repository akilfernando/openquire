import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { buildMarkdown } from '../src/engine/markdown'
import type { ExportPage } from '../src/engine/office'

const text = (x: number, y: number, size: number, s: string, font = 'F1') => `BT /${font} ${size} Tf ${x} ${842 - y} Td (${s}) Tj ET`

/** A sample report: title, heading, paragraphs, a table and a picture, and a second page. */
function samplePdf() {
  const d = new mupdf.PDFDocument()
  const regular = d.addSimpleFont(new mupdf.Font('Helvetica'))
  const bold = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'))
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false)
  pix.clear(200)
  const img = d.addImage(new mupdf.Image(pix))
  const rows = [
    ['Quarter', 'Revenue', 'Status'],
    ['Q1', '$1,250,000', 'Complete'],
    ['Q2', '$1,400,000', 'In Review'],
  ]
  const table = rows.flatMap((r, i) => r.map((c, j) => text(72 + j * 150, 330 + i * 20, 11, c, i === 0 ? 'F2' : 'F1')))
  const page1 = [
    text(72, 90, 24, 'Annual Financial Review', 'F2'),
    text(72, 140, 11, 'This report outlines quarterly revenue across business units.'),
    text(72, 160, 11, '• North American operations grew by 15%'),
    text(72, 180, 11, '• European operations remained steady'),
    text(72, 220, 16, 'Summary Table', 'F2'),
    ...table,
    'q 160 0 0 80 72 300 cm /Im1 Do Q',
  ]
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: regular, F2: bold }, XObject: { Im1: img } }, page1.join('\n')))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: regular, F2: bold } }, [
    text(72, 90, 16, 'Conclusion & Next Steps', 'F2'),
    text(72, 120, 11, '1. Finalize annual audit'),
    text(72, 140, 11, '2. Submit filings to regulators'),
  ].join('\n')))
  const e = new Engine()
  e.open('annual-review.pdf', d.saveToBuffer('').asUint8Array().slice())
  return e
}

describe('Markdown export', () => {
  it('converts PDF document to clean GitHub-Flavored Markdown', () => {
    const e = samplePdf()
    const md = e.exportMarkdown()

    // Page markers
    expect(md).toContain('<!-- Page 1 -->')
    expect(md).toContain('<!-- Page 2 -->')

    // Headings
    expect(md).toContain('# Annual Financial Review')
    expect(md).toContain('## Summary Table')
    expect(md).toContain('## Conclusion & Next Steps')

    // Paragraphs
    expect(md).toContain('This report outlines quarterly revenue across business units.')

    // Formatted Table
    expect(md).toContain('| Quarter | Revenue | Status |')
    expect(md).toContain('| --- | --- | --- |')
    expect(md).toContain('| Q1 | $1,250,000 | Complete |')
    expect(md).toContain('| Q2 | $1,400,000 | In Review |')

    // Bullet lists
    expect(md).toContain('- North American operations grew by 15%')
    expect(md).toContain('- European operations remained steady')

    // Numbered lists
    expect(md).toContain('1. Finalize annual audit')
    expect(md).toContain('2. Submit filings to regulators')

    // Figures
    expect(md).toContain('<!-- Figure')
  })

  it('supports YAML frontmatter and page breaks', () => {
    const e = samplePdf()
    e.setMeta({ title: 'Annual Review 2026', author: 'Finance Team', subject: 'Finance', keywords: 'q1, q2' })
    const md = e.exportMarkdown({ frontmatter: true, pageBreaks: true })

    expect(md).toContain('---')
    expect(md).toContain('title: "Annual Review 2026"')
    expect(md).toContain('author: "Finance Team"')
    expect(md).toContain('---') // page break between pages
  })

  it('allows selective page extraction', () => {
    const e = samplePdf()
    const pageIds = e.pageIds()
    const page2Md = e.exportMarkdown({ pageIds: [pageIds[1]] })

    expect(page2Md).toContain('Conclusion & Next Steps')
    expect(page2Md).not.toContain('Annual Financial Review')
  })

  it('escapes pipes and handles multi-line cells in tables', () => {
    const fakePages: ExportPage[] = [
      {
        width: 600,
        height: 800,
        blocks: [],
        images: [],
        tables: [
          {
            bbox: [50, 50, 500, 200],
            columns: [[50, 200], [200, 400]],
            rows: [
              { rect: [50, 50, 500, 70], cells: ['Col A', 'Col | B'], bold: true },
              { rect: [50, 70, 500, 90], cells: ['Line 1\nLine 2', 'Simple'], bold: false },
            ],
          },
        ],
      },
    ]

    const md = buildMarkdown(fakePages, undefined, { pageMarkers: false })
    expect(md).toContain('| Col A | Col \\| B |')
    expect(md).toContain('| Line 1<br>Line 2 | Simple |')
  })
})
