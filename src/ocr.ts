import { createWorker, type Worker } from 'tesseract.js'
import { activeDocument, engineFor, requestRender } from './engine/client'
import { wordsFromBlocks, type OcrBlock } from './engine/ocr-layout'
import type { DocState } from './engine/types'

const ASSETS = new URL(import.meta.env.BASE_URL + 'ocr/', location.href).href
const DPI = 300

let worker: Promise<Worker> | null = null

function getWorker() {
  worker ??= createWorker('eng', 1, {
    workerPath: ASSETS + 'worker.min.js',
    corePath: ASSETS,
    langPath: ASSETS,
    gzip: true,
  }).catch((e) => {
    worker = null
    throw e
  })
  return worker
}

/**
 * Recognizes text on the given pages and adds an invisible, searchable text layer to each.
 * Returns the final document state, or null if nothing was recognized.
 */
export async function recognizePages(pageIds: number[], onProgress: (done: number, total: number) => void, doc = activeDocument()): Promise<DocState | null> {
  const engine = engineFor(doc)
  const ocr = await getWorker()
  const scale = DPI / 72
  let state: DocState | null = null
  for (const [i, id] of pageIds.entries()) {
    onProgress(i, pageIds.length)
    const bmp = await requestRender(id, scale, 2, undefined, doc).promise
    if (!bmp) continue
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    const { data } = await ocr.recognize(canvas, {}, { blocks: true })
    const words = wordsFromBlocks(data.blocks as unknown as OcrBlock[], scale)
    if (words.length) state = await engine.addTextLayer(id, words)
  }
  onProgress(pageIds.length, pageIds.length)
  return state
}
