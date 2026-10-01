import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { newWorkflow, pageSetOf, parseWorkflow, resolvePages, type WorkflowStep } from '../src/engine/workflow'

function letter(name: string, pages: number) {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  for (let i = 0; i < pages; i++)
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 12 Tf 60 760 Td (${name} page ${i + 1}. Contact jane@example.com.) Tj ET`))
  return d.saveToBuffer('').asUint8Array().slice()
}

const STEPS: WorkflowStep[] = [
  { action: 'markPatterns', patterns: ['[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+'] },
  { action: 'applyRedactions' },
  { action: 'rotate', pages: 'even', delta: 90 },
  { action: 'stamp', pages: 'all', stamp: { template: 'ACME-{bates}', position: 'br', size: 9, color: [0, 0, 0], opacity: 1, angle: 0, batesDigits: 6 } },
  { action: 'setMeta', meta: { author: 'Records team' } },
  { action: 'save', options: { compress: 'standard', security: { mode: 'keep' } } },
]

describe('workflows', () => {
  it('resolves page sets', () => {
    expect(resolvePages('all', 4)).toEqual([0, 1, 2, 3])
    expect(resolvePages('odd', 5)).toEqual([0, 2, 4])
    expect(resolvePages('even', 5)).toEqual([1, 3])
    expect(resolvePages('2-3, 1', 5)).toEqual([0, 1, 2])
    // Ranges past the end of a shorter document are clipped.
    expect(resolvePages('2-10, 12', 3)).toEqual([1, 2])
    expect(resolvePages('3-', 4)).toEqual([2, 3])
    expect(pageSetOf([0, 1, 2, 4], 6)).toBe('1-3, 5')
    expect(pageSetOf([0, 1], 2)).toBe('all')
  })

  it('round-trips through JSON and rejects bad files', () => {
    const wf = newWorkflow('Prepare for production', STEPS)
    expect(parseWorkflow(JSON.stringify(wf))).toEqual(wf)
    const withPlugin = newWorkflow('Export', [{ action: 'plugin', plugin: 'dev.openquire.csv-export', command: 'export', name: 'CSV export: Export text to CSV' }])
    expect(parseWorkflow(JSON.stringify(withPlugin))).toEqual(withPlugin)
    expect(() => parseWorkflow(JSON.stringify({ ...wf, steps: [{ action: 'plugin', plugin: 'x' }] }))).toThrow(/plugin and its command/)
    expect(() => parseWorkflow('{')).toThrow(/not valid JSON/)
    expect(() => parseWorkflow(JSON.stringify({ ...wf, version: 2 }))).toThrow(/newer version/)
    expect(() => parseWorkflow(JSON.stringify({ ...wf, steps: [{ action: 'format-disk' }] }))).toThrow(/Step 1 has an unknown action/)
    expect(() => parseWorkflow(JSON.stringify({ ...wf, steps: [STEPS[5], STEPS[0]] }))).toThrow(/must be the last step/)
    expect(() => parseWorkflow(JSON.stringify({ ...wf, steps: [{ action: 'rotate', pages: 'all', delta: 45 }] }))).toThrow(/90, 180 or 270/)
  })

  it('processes 100 files with Bates numbers that continue across them', () => {
    const wf = parseWorkflow(JSON.stringify(newWorkflow('Production', STEPS)))
    let bates: number | undefined = 1
    const outputs: Uint8Array[] = []
    for (let f = 0; f < 100; f++) {
      const e = new Engine()
      e.open(`letter-${f}.pdf`, letter(`Letter ${f}`, 2))
      for (const step of wf.steps) {
        const r = e.runStep(step, { bates })
        bates = r.bates ?? bates
        if (r.bytes) outputs.push(r.bytes)
      }
    }
    expect(outputs).toHaveLength(100)
    expect(bates).toBe(201)

    const last = new Engine()
    const s = last.open('out.pdf', outputs[99])
    const text = last.pageText(s.pages[1].id)
    expect(text).toContain('ACME-000200')
    expect(text).not.toContain('jane@example.com')
    expect(s.pages.map((p) => p.rotation)).toEqual([0, 90])
    expect(s.meta.author).toBe('Records team')
  }, 120_000)

  it('saves as PDF/A as the output step', () => {
    const e = new Engine()
    e.open('a.pdf', letter('Archive', 1))
    const r = e.runStep({ action: 'pdfa', part: 2 })
    expect(new TextDecoder('latin1').decode(r.bytes!)).toContain('pdfaid:part>2<')
  })
})
