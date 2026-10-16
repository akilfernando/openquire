import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activeDocument: vi.fn(),
  addTextLayer: vi.fn(),
  detectLanguage: vi.fn(),
  engineFor: vi.fn(),
  nativeOcr: vi.fn(),
  nativeTools: vi.fn(),
  recognize: vi.fn(),
  requestRender: vi.fn(),
  wordsFromBlocks: vi.fn(),
  wordsFromTsv: vi.fn(),
}))

vi.mock('tesseract.js', () => ({ createWorker: vi.fn(async () => ({ recognize: mocks.recognize, terminate: vi.fn() })) }))
vi.mock('../src/engine/client', () => ({
  activeDocument: mocks.activeDocument,
  engineFor: mocks.engineFor,
  requestRender: mocks.requestRender,
}))
vi.mock('../src/engine/ocr-layout', () => ({ wordsFromBlocks: mocks.wordsFromBlocks }))
vi.mock('../src/engine/ocr-tsv', () => ({ wordsFromTsv: mocks.wordsFromTsv }))
vi.mock('../src/ocr-languages', () => ({ detectLanguage: mocks.detectLanguage, languagePackUrl: (lang: string) => `/packs/${lang}/` }))
vi.mock('../src/native', () => ({ nativeOcr: mocks.nativeOcr, nativeTools: mocks.nativeTools }))

const word = { text: 'hello', bbox: [1, 2, 3, 4] }
const state = { revision: 'r1', pages: [] }

function bitmap() {
  return { width: 10, height: 10, close: vi.fn() }
}

async function loadOcr() {
  vi.resetModules()
  return import('../src/ocr')
}

describe('recognizePages controls', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.activeDocument.mockReturnValue(99)
    vi.stubGlobal('location', { href: 'http://localhost/' })
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['image'])),
      }),
    })
    mocks.engineFor.mockReturnValue({ addTextLayer: vi.fn(async () => state) })
    mocks.requestRender.mockImplementation(() => ({ promise: Promise.resolve(bitmap()) }))
    mocks.wordsFromBlocks.mockReturnValue([word])
    mocks.wordsFromTsv.mockReturnValue([word])
    mocks.recognize.mockResolvedValue({ data: { blocks: [], text: 'sample text' } })
    mocks.detectLanguage.mockReturnValue('eng')
    mocks.nativeTools.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stops before recognition when the signal is already aborted', async () => {
    const ocr = await loadOcr()
    const abort = new AbortController()
    abort.abort()
    const progress = vi.fn()
    const result = await ocr.recognizePages([1, 2], progress, 7, { lang: 'eng', allowDownload: true }, { signal: abort.signal })

    expect(result).toMatchObject({ completed: 0, skipped: 2, stopped: true, state: null })
    expect(mocks.requestRender).not.toHaveBeenCalled()
    expect(mocks.engineFor).toHaveBeenCalledWith(7)
    expect(progress).toHaveBeenCalledWith(0, 2)
  })

  it('finishes the page in progress after stop and skips later pages', async () => {
    const ocr = await loadOcr()
    const abort = new AbortController()
    mocks.recognize.mockImplementation(async () => {
      abort.abort()
      return { data: { blocks: [], text: 'recognized' } }
    })
    const addTextLayer = vi.fn(async () => state)
    mocks.engineFor.mockReturnValue({ addTextLayer })
    const result = await ocr.recognizePages([11, 12], vi.fn(), 4, { lang: 'eng', allowDownload: true }, { signal: abort.signal })

    expect(result).toMatchObject({ completed: 1, skipped: 1, stopped: true, state })
    expect(mocks.requestRender).toHaveBeenCalledTimes(1)
    expect(mocks.requestRender).toHaveBeenCalledWith(11, 300 / 72, 2, undefined, 4)
    expect(mocks.engineFor).toHaveBeenCalledWith(4)
    expect(addTextLayer).toHaveBeenCalledTimes(1)
  })

  it('keeps the requested document for the engine and render if the active document changes', async () => {
    const ocr = await loadOcr()
    mocks.requestRender.mockImplementation(() => {
      mocks.activeDocument.mockReturnValue(100)
      return { promise: Promise.resolve(bitmap()) }
    })

    await ocr.recognizePages([15], vi.fn(), undefined, { lang: 'eng', allowDownload: true })

    expect(mocks.engineFor).toHaveBeenCalledWith(99)
    expect(mocks.requestRender).toHaveBeenCalledWith(15, 300 / 72, 2, undefined, 99)
  })

  it('finishes the first page in the detected language when stopped during auto detection', async () => {
    const ocr = await loadOcr()
    const abort = new AbortController()
    mocks.detectLanguage.mockReturnValue('fra')
    mocks.recognize.mockImplementation(async () => {
      abort.abort()
      return { data: { blocks: [], text: 'bonjour le monde' } }
    })
    const result = await ocr.recognizePages([21, 22], vi.fn(), 3, { lang: 'auto', allowDownload: true }, { signal: abort.signal })

    expect(result).toMatchObject({ completed: 1, skipped: 1, stopped: true, lang: 'fra', state })
    expect(mocks.requestRender).toHaveBeenCalledTimes(2)
    expect(mocks.engineFor).toHaveBeenCalledWith(3)
  })

  it('publishes each committed state before a later page fails', async () => {
    const ocr = await loadOcr()
    const addTextLayer = vi.fn().mockResolvedValueOnce(state)
    mocks.engineFor.mockReturnValue({ addTextLayer })
    mocks.requestRender.mockImplementationOnce(() => ({ promise: Promise.resolve(bitmap()) }))
      .mockImplementationOnce(() => ({ promise: Promise.reject(new Error('render failed')) }))
    const onState = vi.fn()

    await expect(ocr.recognizePages([31, 32], vi.fn(), 2, { lang: 'eng', allowDownload: true }, { onState })).rejects.toThrow('render failed')
    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenCalledWith(state)
  })

  it('throws when a requested page cannot be rendered', async () => {
    const ocr = await loadOcr()
    mocks.requestRender.mockReturnValue({ promise: Promise.resolve(null) })

    await expect(ocr.recognizePages([41], vi.fn(), 1, { lang: 'eng', allowDownload: true })).rejects.toThrow('The page could not be rendered')
    expect(mocks.recognize).not.toHaveBeenCalled()
  })

  it('finishes a native OCR page after stop and skips remaining pages', async () => {
    const ocr = await loadOcr()
    const abort = new AbortController()
    mocks.nativeTools.mockResolvedValue({ tesseract: true, tesseract_langs: ['eng'] })
    mocks.nativeOcr.mockImplementation(async () => {
      abort.abort()
      return 'native tsv'
    })
    const addTextLayer = vi.fn(async () => state)
    mocks.engineFor.mockReturnValue({ addTextLayer })

    const result = await ocr.recognizePages(
      [51, 52], vi.fn(), 5, { lang: 'eng', allowDownload: false, native: true }, { signal: abort.signal },
    )

    expect(result).toMatchObject({ completed: 1, skipped: 1, stopped: true, state })
    expect(mocks.nativeOcr).toHaveBeenCalledTimes(1)
    expect(mocks.wordsFromTsv).toHaveBeenCalledWith('native tsv', 300 / 72)
    expect(addTextLayer).toHaveBeenCalledTimes(1)
    expect(mocks.requestRender).toHaveBeenCalledTimes(1)
    expect(mocks.recognize).not.toHaveBeenCalled()
  })
})
