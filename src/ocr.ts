import { createWorker, type Worker } from 'tesseract.js'
import { activeDocument, engineFor, requestRender } from './engine/client'
import { wordsFromBlocks, type OcrBlock } from './engine/ocr-layout'
import type { DocState, OcrWord } from './engine/types'
import { detectLanguage, languagePackUrl } from './ocr-languages'

const ASSETS = new URL(import.meta.env.BASE_URL + 'ocr/', location.href).href
const DPI = 300

// One Tesseract worker, for one language at a time: each downloaded language pack lives in its
// own folder, and a worker reads all its languages from one folder.
let current: { lang: string; worker: Promise<Worker> } | null = null

function getWorker(lang: string) {
  if (current?.lang === lang) return current.worker
  const old = current
  void old?.worker.then((w) => w.terminate()).catch(() => {})
  const worker = createWorker(lang, 1, {
    workerPath: ASSETS + 'worker.min.js',
    corePath: ASSETS,
    langPath: lang === 'eng' ? ASSETS : languagePackUrl(lang),
    gzip: true,
  }).catch((e) => {
    if (current?.worker === worker) current = null
    throw e
  })
  current = { lang, worker }
  return worker
}

export interface OcrOptions {
  /** A language code, or 'auto' to detect it from the first page. */
  lang: string
  /** Whether language packs other than English may be downloaded. */
  allowDownload: boolean
}

export interface OcrResult {
  state: DocState | null
  /** The language used. */
  lang: string
  /** A language that was detected but not used, because downloading it isn't allowed. */
  wanted?: string
}

async function recognize(doc: number, pageId: number, lang: string): Promise<{ words: OcrWord[]; text: string }> {
  const scale = DPI / 72
  const bmp = await requestRender(pageId, scale, 2, undefined, doc).promise
  if (!bmp) return { words: [], text: '' }
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  const ocr = await getWorker(lang)
  const { data } = await ocr.recognize(canvas, {}, { blocks: true, text: true })
  return { words: wordsFromBlocks(data.blocks as unknown as OcrBlock[], scale), text: data.text }
}

/**
 * Recognizes text on the given pages and adds an invisible, searchable text layer to each.
 * With language 'auto', the first page is read in English to detect the language.
 */
export async function recognizePages(
  pageIds: number[],
  onProgress: (done: number, total: number) => void,
  doc = activeDocument(),
  opts: OcrOptions = { lang: 'eng', allowDownload: false },
): Promise<OcrResult> {
  const engine = engineFor(doc)
  const result: OcrResult = { state: null, lang: opts.lang === 'auto' ? 'eng' : opts.lang }
  if (!opts.allowDownload && result.lang !== 'eng') {
    result.wanted = result.lang
    result.lang = 'eng'
  }
  let first: OcrWord[] | null = null
  if (opts.lang === 'auto' && pageIds.length) {
    onProgress(0, pageIds.length)
    const probe = await recognize(doc, pageIds[0], 'eng')
    const detected = detectLanguage(probe.text)
    if (detected && detected !== 'eng') {
      if (opts.allowDownload) result.lang = detected
      else result.wanted = detected
    }
    // English was right, so the first page is done.
    if (result.lang === 'eng') first = probe.words
  }
  for (const [i, id] of pageIds.entries()) {
    onProgress(i, pageIds.length)
    const words = i === 0 && first ? first : (await recognize(doc, id, result.lang)).words
    if (words.length) result.state = await engine.addTextLayer(id, words)
  }
  onProgress(pageIds.length, pageIds.length)
  return result
}
