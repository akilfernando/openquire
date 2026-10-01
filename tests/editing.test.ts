import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument as LibDoc, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Engine } from '../src/engine/core'

const DEJAVU = readFileSync(fileURLToPath(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSerif.ttf', import.meta.url)))

const LOREM = 'OpenQuire edits whole paragraphs. The new text wraps inside the original width and keeps the original alignment, size and spacing.'

/** A page with a heading and a justified-looking, left-aligned paragraph drawn as wrapped lines. */
async function paragraphPdf() {
  const doc = await LibDoc.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const p = doc.addPage([595, 842])
  p.drawText('Section heading', { x: 72, y: 760, size: 18, font: bold })
  p.drawText(LOREM + ' ' + LOREM, { x: 72, y: 720, size: 12, font, maxWidth: 300, lineHeight: 16 })
  p.drawText('A following paragraph that must not move.', { x: 72, y: 560, size: 12, font })
  return doc.save()
}

/** A page whose text uses a fully embedded TrueType font, as many real PDFs do. */
async function embeddedFontPdf() {
  const doc = await LibDoc.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(DEJAVU, { subset: false })
  doc.addPage([400, 300]).drawText('Embedded font line', { x: 40, y: 240, size: 14, font })
  return doc.save()
}

const fontsUsed = (bytes: Uint8Array) => {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF() as mupdf.PDFDocument
  const names: string[] = []
  const walk = (res: mupdf.PDFObject) => {
    res.get('Font').forEach((f) => names.push(f.resolve().get('BaseFont').asName()))
    res.get('XObject').forEach((x) => walk(x.resolve().get('Resources')))
  }
  walk(doc.findPage(0).get('Resources'))
  return names
}

describe('paragraph editing', () => {
  it('groups lines into paragraphs with alignment and leading', async () => {
    const e = new Engine()
    const s = e.open('p.pdf', await paragraphPdf())
    const blocks = e.textBlocks(s.pages[0].id)
    const para = blocks.find((b) => b.text.startsWith('OpenQuire edits'))!
    expect(blocks.map((b) => b.lines.length)).toEqual([1, para.lines.length, 1])
    expect(para.lines.length).toBeGreaterThan(4)
    expect(para.leading).toBeCloseTo(16, 0)
    expect(para.align).toBe('left')
    expect(para.text).toBe(`${LOREM} ${LOREM}`)
  })

  it('rewrites a paragraph that reflows inside its original width', async () => {
    const e = new Engine()
    const s = e.open('p.pdf', await paragraphPdf())
    const id = s.pages[0].id
    const para = e.textBlocks(id).find((b) => b.text.startsWith('OpenQuire edits'))!
    const next = 'Shorter replacement paragraph. It still wraps at the same width as before, starting on the same baseline, in the same size.'
    e.replaceBlock(id, para, next)

    const after = e.textBlocks(id)
    const edited = after.find((b) => b.text.startsWith('Shorter replacement'))!
    expect(edited.text).toBe(next)
    expect(edited.lines.length).toBeGreaterThan(1)
    expect(edited.lines[0].origin[1]).toBeCloseTo(para.lines[0].origin[1], 0)
    expect(edited.lines[0].origin[0]).toBeCloseTo(para.lines[0].origin[0], 0)
    expect(edited.size).toBeCloseTo(12, 0)
    expect(edited.leading).toBeCloseTo(16, 0)
    for (const l of edited.lines) expect(l.bbox[2]).toBeLessThanOrEqual(para.bbox[2] + 1)
    // Neighbours are untouched and the old text is gone.
    expect(after.some((b) => b.text === 'Section heading')).toBe(true)
    expect(after.some((b) => b.text === 'A following paragraph that must not move.')).toBe(true)
    expect(e.pageText(id)).not.toContain('OpenQuire edits')
    // Undo restores the original paragraph.
    e.undo()
    expect(e.textBlocks(id).some((b) => b.text === para.text)).toBe(true)
  })

  it('writes non-Latin text', async () => {
    const e = new Engine()
    const s = e.open('p.pdf', await paragraphPdf())
    const id = s.pages[0].id
    const heading = e.textBlocks(id).find((b) => b.text === 'Section heading')!
    e.replaceBlock(id, heading, 'Раздел 1 · Ελληνικά · 日本語の見出し')
    expect(e.pageText(id).replace(/\s+/g, ' ')).toContain('Раздел 1 · Ελληνικά · 日本語の見出し')
    // All of it sits on the heading's baseline.
    const lines = e.textLines(id).filter((l) => /Раздел|日本語/.test(l.text))
    for (const l of lines) expect(l.origin[1]).toBeCloseTo(heading.lines[0].origin[1], 0)
  })

  it('reuses the original embedded font when it covers the new text', async () => {
    const e = new Engine()
    const s = e.open('f.pdf', await embeddedFontPdf())
    const id = s.pages[0].id
    const [line] = e.textBlocks(id)
    expect(line.text).toBe('Embedded font line')
    e.replaceBlock(id, line, 'Edited embedded line, ŝtill DejaVu')
    const out = e.save({ compress: 'none', security: { mode: 'keep' } })
    const base = line.font.replace(/^[A-Z]{6}\+/, '')
    expect(fontsUsed(out).filter((n) => n.includes(base)).length).toBeGreaterThan(0)
    expect(e.pageText(id)).toContain('Edited embedded line, ŝtill DejaVu')
  })
})
