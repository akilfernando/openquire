import { expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createDigitalId } from '../src/engine/signing'
import { hiddenContentPdf } from './fixtures/hidden-content'

it('removes hidden and sensitive information', async () => {
  const e = new Engine()
  let s = e.open('leaky.pdf', hiddenContentPdf())
  const id = s.pages[0].id
  e.attach('salaries.csv', new TextEncoder().encode('a,b'), 'text/csv')
  e.addAnnot(id, { type: 'Text', at: [10, 10], text: 'internal comment', color: [1, 1, 0] })
  e.addLink(id, [40, 40, 140, 60], 'https://intranet.example')
  e.addBookmark('Draft section', 0)
  const { state } = e.addField(id, 'text', [40, 300, 240, 322], { name: 'Notes' })
  e.setField(id, state.pages[0].widgets[0].id, 'confidential answer')
  const p12 = await createDigitalId({ name: 'Ada', password: 'pw' })
  s = (await e.sign({ p12, password: 'pw', pageId: null })).state
  expect(s.signatures).toHaveLength(1)

  const { report } = e.sanitize({
    metadata: true, attachments: true, scripts: true, comments: true, links: true, bookmarks: true,
    formData: 'clear', hiddenText: true, hiddenLayers: true,
  })
  expect(report.metadata).toBeGreaterThan(0)
  expect(report).toMatchObject({ attachments: 1, comments: 1, links: 1, bookmarks: 1, formFields: 1, hiddenText: 1, hiddenLayers: 1, signatures: 1 })
  expect(report.scripts).toBeGreaterThanOrEqual(2)

  const bytes = e.save({ compress: 'standard', security: { mode: 'keep' } })
  const raw = new TextDecoder('latin1').decode(bytes)
  for (const leak of ['Jane Secret', 'Internal draft', 'author secrets', 'app.alert', 'salaries', 'internal comment', 'intranet', 'Draft section', 'confidential answer'])
    expect(raw, leak).not.toContain(leak)

  const r = new Engine()
  const out = r.open('clean.pdf', bytes)
  const text = r.pageText(out.pages[0].id)
  expect(text).toContain('Visible paragraph')
  expect(text).not.toContain('hidden ocr words')
  expect(text).not.toContain('secret layer text')
  expect(out.attachments).toEqual([])
  expect(out.outline).toEqual([])
  expect(out.signatures).toEqual([])
  expect(out.pages[0].annots).toEqual([])
  expect(out.pages[0].links).toEqual([])
  expect(out.pages[0].widgets.filter((w) => w.kind === 'text').map((w) => w.value)).toEqual([''])
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF() as mupdf.PDFDocument
  expect(doc.getTrailer().get('Root', 'OCProperties').isNull()).toBe(true)
  expect(doc.getTrailer().get('Root', 'OpenAction').isNull()).toBe(true)
})

it('flattens form data and keeps what was not selected', () => {
  const e = new Engine()
  const id = e.open('leaky.pdf', hiddenContentPdf()).pages[0].id
  const { state } = e.addField(id, 'text', [40, 300, 240, 322], { name: 'Notes' })
  e.setField(id, state.pages[0].widgets[0].id, 'kept as page text')
  const { report, state: after } = e.sanitize({ formData: 'flatten', hiddenText: true })
  expect(report.formFields).toBe(1)
  expect(after.pages[0].widgets).toEqual([])
  expect(e.pageText(id)).toContain('kept as page text')
  // The hidden layer was not selected, so its content is still in the file.
  expect(e.save({ compress: 'none', security: { mode: 'keep' } }).length).toBeGreaterThan(0)
  expect(after.meta.author).toBe('Jane Secret')
})

