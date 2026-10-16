import { it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { scannedPdf } from './fixtures/invoice'
import os from 'node:os'

// Opt-in measurements, separate from correctness tests. No timing assertions until
// comparable machines have established stable budgets.
it.skipIf(!process.env.OPENQUIRE_BASELINE)('records synthetic engine baselines', async () => {
  console.log(JSON.stringify({ platform: os.platform(), cpu: os.cpus()[0].model, node: process.version }))
  const scan = mupdf.Document.openDocument(await scannedPdf(), 'application/pdf').asPDF()!
  for (const [kind, pages] of [['small', 2], ['large', 1000], ['mixed-scan', 100]] as const) {
    const doc = new mupdf.PDFDocument()
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
    for (let i = 0; i < pages; i++) {
      if (kind === 'mixed-scan' && i % 2) doc.graftPage(-1, scan, 0)
      else doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 12 Tf 72 720 Td (Synthetic page ${i}) Tj ET`))
    }
    const buffer = doc.saveToBuffer('compress')
    const bytes = buffer.asUint8Array().slice()
    buffer.destroy(); doc.destroy()
    const engine = new Engine()
    const measurements: Record<string, number> = {}
    let sampledRss = process.memoryUsage().rss
    const measure = <T>(name: string, fn: () => T): T => {
      const start = performance.now()
      const result = fn()
      measurements[name] = Math.round((performance.now() - start) * 100) / 100
      sampledRss = Math.max(sampledRss, process.memoryUsage().rss)
      return result
    }
    const state = measure('openMs', () => engine.open('baseline.pdf', bytes))
    measure('renderMs', () => engine.render(state.pages[kind === 'mixed-scan' ? 1 : 0].id, 1))
    measure('editMs', () => engine.addAnnot(state.pages[0].id, { type: 'Text', at: [10, 10], text: 'Baseline', color: [1, 1, 0] }))
    measure('saveMs', () => engine.save({ compress: 'standard', security: { mode: 'keep' } }))
    console.log(JSON.stringify({ kind, pages, bytes: bytes.length, ...measurements, sampledProcessRssMiB: Math.round(sampledRss / 1048576) }))
    engine.close()
  }
  scan.destroy()
})
