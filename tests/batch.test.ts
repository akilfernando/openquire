import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'

const mocks = vi.hoisted(() => {
  let nextDoc = 0
  const engines = new Map<number, any>()
  const engineFor = vi.fn((doc: number) => engines.get(doc))
  const newDocument = vi.fn(() => {
    const doc = ++nextDoc
    engines.set(doc, {
      open: vi.fn(async (name: string, bytes: Uint8Array) => {
        if (bytes[0] === 0xff) throw new Error('Invalid PDF input')
        return { name: name.replace(/\.[^.]+$/, ''), pages: [] }
      }),
      save: vi.fn(async () => new TextEncoder().encode(`saved-${doc}`)),
    })
    return doc
  })
  const closeDocument = vi.fn(async (doc: number) => { engines.delete(doc) })
  const reset = () => { nextDoc = 0 }
  return { engines, engineFor, newDocument, closeDocument, reset }
})

vi.mock('../src/engine/client', () => ({
  engineFor: mocks.engineFor,
  newDocument: mocks.newDocument,
  closeDocument: mocks.closeDocument,
}))

import { runBatch } from '../src/workflows'

const workflow = { name: 'test workflow', steps: [] } as any
const ocr = { lang: 'eng' } as any

function file(name: string, bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
}

function entries(zip: Uint8Array) {
  return Object.fromEntries(Object.entries(unzipSync(zip)).map(([name, bytes]) => [name, new TextDecoder().decode(bytes)]))
}

describe('runBatch', () => {
  beforeEach(() => {
    mocks.reset()
    mocks.engines.clear()
    mocks.engineFor.mockClear()
    mocks.newDocument.mockClear()
    mocks.closeDocument.mockClear()
  })

  it('finishes the current file on cancellation, skips later files, and reports counts', async () => {
    const controller = new AbortController()
    const progress: string[] = []
    const result = await runBatch(
      [file('first.pdf'), file('second.pdf'), file('third.pdf')], workflow, ocr,
      (_done, _total, name) => progress.push(name), undefined,
      { signal: controller.signal, onStage: (_name, stage) => {
        if (stage === 'Preparing output') controller.abort()
      } },
    )

    const zip = entries(result.zip)
    expect(result).toMatchObject({ done: 1, failed: [], cancelled: true, skipped: ['second.pdf', 'third.pdf'] })
    expect(Object.keys(zip).sort()).toEqual(['batch-report.json', 'first.pdf'])
    expect(zip['first.pdf']).toBe('saved-1')
    expect(JSON.parse(zip['batch-report.json'])).toMatchObject({ done: 1, cancelled: true, skipped: ['second.pdf', 'third.pdf'] })
    expect(progress).toEqual(['first.pdf', ''])
    expect(mocks.newDocument).toHaveBeenCalledTimes(1)
  })

  it('records a corrupt input and continues with later files', async () => {
    const result = await runBatch([file('broken.pdf', [0xff]), file('good.pdf')], workflow, ocr, () => {})
    const zip = entries(result.zip)
    expect(result).toMatchObject({ done: 1, cancelled: false, skipped: [], failed: [{ name: 'broken.pdf', error: 'Invalid PDF input' }] })
    expect(Object.keys(zip).sort()).toEqual(['batch-report.json', 'failed.txt', 'good.pdf'])
    expect(zip['failed.txt']).toContain('broken.pdf: Invalid PDF input')
    expect(JSON.parse(zip['batch-report.json']).failed).toEqual(result.failed)
  })

  it('preserves duplicate filenames without case-sensitive collisions', async () => {
    const result = await runBatch([file('Report.pdf'), file('report.PDF')], workflow, ocr, () => {})
    const zip = entries(result.zip)
    expect(result.done).toBe(2)
    expect(Object.keys(zip).sort()).toEqual(['Report.pdf', 'batch-report.json', 'report (2).pdf'])
    expect(zip['Report.pdf']).toBe('saved-1')
    expect(zip['report (2).pdf']).toBe('saved-2')
  })

  it('waits for each document to close before resolving', async () => {
    let releaseClose!: () => void
    mocks.closeDocument.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseClose = resolve }))
    let settled = false
    const running = runBatch([file('wait.pdf')], workflow, ocr, () => {}).then((result) => {
      settled = true
      return result
    })

    await vi.waitFor(() => expect(releaseClose).toBeTypeOf('function'))
    expect(settled).toBe(false)
    releaseClose()
    const result = await running
    expect(settled).toBe(true)
    expect(result.done).toBe(1)
  })
})
