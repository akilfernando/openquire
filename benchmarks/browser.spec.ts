import { test as base, expect, type Browser } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import * as mupdf from 'mupdf'
import { PDFDocument } from 'pdf-lib'
import { scannedPdf } from '../tests/fixtures/invoice'
import { processTreeRss } from './process-memory'

// Own the launch server so memory sampling has an explicit browser root PID.
// Each fixture starts a fresh browser; profiles within a trial share a worker.
const test = base.extend<{ measuredBrowser: { browser: Browser; pid: number } }>({
  measuredBrowser: async ({ playwright, browserName }, use) => {
    const server = await playwright[browserName].launchServer({ headless: true })
    const browser = await playwright[browserName].connect(server.wsEndpoint())
    try { await use({ browser, pid: server.process().pid! }) }
    finally { await browser.close(); await server.close() }
  },
})

async function fixture(kind: string, pages: number) {
  const doc = new mupdf.PDFDocument()
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  const scan = mupdf.Document.openDocument(await scannedPdf(), 'application/pdf').asPDF()!
  for (let i = 0; i < pages; i++) {
    if (kind === 'mixed-scan' && i % 2 === 0) doc.graftPage(-1, scan, 0)
    else doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 12 Tf 72 720 Td (Synthetic page ${i}) Tj ET`))
  }
  const buffer = doc.saveToBuffer('compress')
  const bytes = Buffer.from(buffer.asUint8Array())
  buffer.destroy(); doc.destroy(); scan.destroy()
  return bytes
}

for (const [kind, pages] of [['small', 2], ['large', 1000], ['mixed-scan', 100]] as const) {
  test(`${kind} browser measurements`, async ({ measuredBrowser: { browser, pid }, baseURL, storageState }, info) => {
    const bytes = await fixture(kind, pages)
    const samples: Record<string, number | string>[] = []
    let observedPeakRss: number | null = null
    let memorySamples = 0
    const sampleMemory = () => {
      if (process.platform !== 'linux') return
      const rss = processTreeRss(pid)
      if (rss !== null) { memorySamples++; observedPeakRss = Math.max(observedPeakRss ?? 0, rss) }
    }
    const timer = setInterval(sampleMemory, 100)
    try {
      for (let trial = 0; trial < 3; trial++) {
        const context = await browser.newContext({ storageState, serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1000 } })
        try {
          // Observe actual page-canvas draws without changing engine behavior.
          await context.addInitScript(() => {
            const draw = CanvasRenderingContext2D.prototype.drawImage
            CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof draw>) {
              draw.apply(this, args)
              if (this.canvas.closest('.page') && !this.canvas.dataset.benchmarkPainted) this.canvas.dataset.benchmarkPainted = String(performance.now())
            } as typeof draw
          })
          const page = await context.newPage()
          await page.goto(baseURL!)
          for (const profile of ['fresh-context', 'warm-worker']) {
            const openStart = await page.evaluate(() => performance.now())
            await page.locator('input[type=file]').first().setInputFiles({ name: 'baseline.pdf', mimeType: 'application/pdf', buffer: bytes })
            await expect(page.locator('.page canvas[data-benchmark-painted]').first()).toBeVisible()
            const canvasReady = Number(await page.locator('.page canvas[data-benchmark-painted]').first().getAttribute('data-benchmark-painted'))
            const openUiMs = await page.evaluate(start => performance.now() - start, openStart)
            const editStart = await page.evaluate(() => performance.now())
            await page.getByRole('button', { name: 'Sticky note', exact: true }).click()
            await page.locator('.page .overlay.tool-note').first().click({ position: { x: 50, y: 60 } })
            await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
            const editUiMs = await page.evaluate(start => performance.now() - start, editStart)
            const saveStart = performance.now()
            const downloaded = page.waitForEvent('download')
            await page.getByRole('button', { name: 'Save', exact: true }).click()
            const download = await downloaded
            const stream = await download.createReadStream()
            const chunks: Buffer[] = []
            for await (const chunk of stream) chunks.push(Buffer.from(chunk))
            const output = Buffer.concat(chunks) // Includes completion of the download.
            const saveDownloadMs = performance.now() - saveStart
            const parsed = await PDFDocument.load(output)
            expect(parsed.getPageCount()).toBe(pages)
            expect(parsed.getPage(0).node.Annots()?.size()).toBeGreaterThan(0)
            sampleMemory()
            samples.push({ trial: trial + 1, profile, openUiMs, firstCanvasMs: canvasReady - openStart, editUiMs, saveDownloadMs, outputBytes: output.length })
            await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)
            await page.getByRole('button', { name: 'Close baseline', exact: true }).click()
            await expect(page.locator('.page')).toHaveCount(0)
          }
        } finally { await context.close() }
      }
    } finally { clearInterval(timer) }
    if (process.platform === 'linux') {
      expect(memorySamples).toBeGreaterThan(0)
      expect(observedPeakRss).toBeGreaterThan(0)
    }
    const evidence = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
      platform: os.platform(), cpu: os.cpus()[0].model, systemMemoryBytes: os.totalmem(),
      browser: browser.version(), kind, pages, inputBytes: bytes.length,
      viewport: { width: 1440, height: 1000 }, samples,
      memory: { observedPeakRss, memorySamples, intervalMs: 100, method: process.platform === 'linux' ? 'sampled Linux browser process-tree RSS; shared pages counted per process' : 'unavailable on this OS' },
    }
    const path = info.outputPath('measurements.json')
    writeFileSync(path, JSON.stringify(evidence, null, 2))
    await info.attach('measurements.json', { path, contentType: 'application/json' })
    console.log(JSON.stringify(evidence))
  })
}
