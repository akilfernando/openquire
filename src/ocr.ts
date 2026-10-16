import { createWorker, type Worker } from 'tesseract.js'
import { activeDocument, engineFor, requestRender } from './engine/client'
import { wordsFromBlocks, type OcrBlock } from './engine/ocr-layout'
import type { DocState, OcrWord } from './engine/types'
import { detectLanguage, languagePackUrl } from './ocr-languages'
import { wordsFromTsv } from './engine/ocr-tsv'
import { nativeOcr, nativeTools } from './native'

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
  /** Use an installed Tesseract when there is one (desktop app). */
  native?: boolean
}

export interface OcrResult {
  state: DocState | null
  completed: number
  skipped: number
  stopped: boolean
  /** The language used. */
  lang: string
  /** A language that was detected but not used, because downloading it isn't allowed. */
  wanted?: string
}

export interface OcrControls {
  /** Finish the current page, then skip remaining pages. */
  signal?: AbortSignal
  /** Publish each committed text layer, including before a later page fails. */
  onState?: (state: DocState) => void
}

async function recognize(doc: number, pageId: number, lang: string, native: string[] | null): Promise<{ words: OcrWord[]; text: string }> {
  const scale = DPI / 72
  const bmp = await requestRender(pageId, scale, 2, undefined, doc).promise
  if (!bmp) throw new Error('The page could not be rendered for text recognition.')
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  // The installed Tesseract, when it has this language.
  if (native?.includes(lang)) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (blob) {
      const words = wordsFromTsv(await nativeOcr(new Uint8Array(await blob.arrayBuffer()), lang), scale)
      return { words, text: words.map((w) => w.text).join(' ') }
    }
  }
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
  controls: OcrControls = {},
): Promise<OcrResult> {
  const engine = engineFor(doc)
  const result: OcrResult = { state: null, lang: opts.lang === 'auto' ? 'eng' : opts.lang, completed: 0, skipped: pageIds.length, stopped: false }
  const finish = () => {
    result.skipped = pageIds.length - result.completed
    result.stopped = result.skipped > 0 && !!controls.signal?.aborted
    onProgress(result.completed, pageIds.length)
    return result
  }
  if (controls.signal?.aborted) return finish()
  const installed = opts.native ? await nativeTools() : null
  const native = installed?.tesseract ? installed.tesseract_langs : null
  // Languages installed with Tesseract need no download.
  const downloadable = (lang: string) => opts.allowDownload || !!native?.includes(lang)
  if (!downloadable(result.lang) && result.lang !== 'eng') {
    result.wanted = result.lang
    result.lang = 'eng'
  }
  for (const [i, id] of pageIds.entries()) {
    if (controls.signal?.aborted) break
    onProgress(i, pageIds.length)
    // Language probing belongs to the first page: a stop during probing still
    // finishes that page in the selected language before reaching the boundary.
    let first: OcrWord[] | null = null
    if (i === 0 && opts.lang === 'auto') {
      const probe = await recognize(doc, id, 'eng', native)
      const detected = detectLanguage(probe.text)
      if (detected && detected !== 'eng') {
        if (downloadable(detected)) result.lang = detected
        else result.wanted = detected
      }
      if (result.lang === 'eng') first = probe.words
    }
    const words = i === 0 && first ? first : (await recognize(doc, id, result.lang, native)).words
    if (words.length) {
      result.state = await engine.addTextLayer(id, words)
      controls.onState?.(result.state)
    }
    result.completed++
  }
  return finish()
}

