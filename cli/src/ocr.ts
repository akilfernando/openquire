/**
 * OCR in Node: Tesseract reads each page render and the words become an invisible text layer,
 * as in the app. English is installed with the package; other languages are downloaded from
 * jsDelivr on first use and cached.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { createWorker, type Worker } from 'tesseract.js'
import type { Engine } from '../../src/engine/core'
import { wordsFromBlocks, type OcrBlock } from '../../src/engine/ocr-layout'

const DPI = 300
const require = createRequire(import.meta.url)
let current: { lang: string; worker: Promise<Worker> } | null = null

function langPath(lang: string) {
  if (lang === 'eng') return join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int')
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`
}

function getWorker(lang: string) {
  if (current?.lang === lang) return current.worker
  void current?.worker.then((w) => w.terminate())
  const cachePath = join(homedir(), '.cache', 'openquire', 'tessdata')
  mkdirSync(cachePath, { recursive: true })
  current = { lang, worker: createWorker(lang, 1, { langPath: langPath(lang), cachePath, gzip: true }) }
  return current.worker
}

/** Adds a text layer to pages without text. Returns how many pages were recognized. */
export async function recognize(engine: Engine, lang = 'eng', pageIds = engine.pagesWithoutText()) {
  const ocr = await getWorker(lang)
  let done = 0
  for (const id of pageIds) {
    const png = engine.renderPng(id, DPI)
    const { data } = await ocr.recognize(Buffer.from(png), {}, { blocks: true })
    const words = wordsFromBlocks(data.blocks as unknown as OcrBlock[], DPI / 72)
    if (words.length) {
      engine.addTextLayer(id, words)
      done++
    }
  }
  return done
}

export async function stopOcr() {
  const w = current?.worker
  current = null
  if (w) await (await w).terminate()
}
