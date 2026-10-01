import { beforeAll, describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createDigitalId } from '../src/engine/signing'

let p12: Uint8Array
beforeAll(async () => {
  p12 = await createDigitalId({ name: 'Notary', password: 'pw' })
})

const formPdf = () => {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  d.insertPage(-1, d.addPage([0, 0, 400, 500], 0, { Font: { F1: font } }, 'BT /F1 14 Tf 40 450 Td (Certified agreement) Tj ET'))
  return d.saveToBuffer('').asUint8Array().slice()
}

/** A certified document with one text field, reopened from its saved bytes. */
async function certified(level: 1 | 2 | 3) {
  const e = new Engine()
  const first = e.open('c.pdf', formPdf()).pages[0].id
  e.addField(first, 'text', [40, 300, 240, 322], { name: 'Name' })
  const { state } = await e.sign({ p12, password: 'pw', pageId: null, certify: level })
  expect(state.signatures[0]).toMatchObject({ valid: true, certification: level })
  // Signing reloads the document, so take ids from the new state.
  return { e, id: state.pages[0].id, field: state.pages[0].widgets.find((w) => w.kind === 'text')!.id }
}

const resave = (e: Engine) => new Engine().open('r.pdf', e.save({ compress: 'standard', security: { mode: 'keep' } })).signatures

describe('certification signatures', () => {
  it('allows form filling at level 2 but not comments', async () => {
    const { e, id, field } = await certified(2)
    e.setField(id, field, 'Ada')
    let sigs = resave(e)
    expect(sigs[0]).toMatchObject({ valid: true, coversWholeFile: false, problem: null })

    e.addAnnot(id, { type: 'Text', at: [10, 10], text: 'note', color: [1, 1, 0] })
    sigs = resave(e)
    expect(sigs[0].valid).toBe(false)
    expect(sigs[0].problem).toMatch(/annotations/)
  })

  it('allows comments at level 3', async () => {
    const { e, id } = await certified(3)
    e.addAnnot(id, { type: 'Text', at: [10, 10], text: 'note', color: [1, 1, 0] })
    expect(resave(e)[0]).toMatchObject({ valid: true, problem: null })
  })

  it('allows no changes at level 1', async () => {
    const { e, id, field } = await certified(1)
    e.setField(id, field, 'Ada')
    const [sig] = resave(e)
    expect(sig.valid).toBe(false)
    expect(sig.problem).toMatch(/form/)
  })

  it('accepts approval signatures after level 2, and flags page edits', async () => {
    const { e, id } = await certified(2)
    const { state } = await e.sign({ p12, password: 'pw', pageId: null })
    expect(state.signatures.map((s) => s.valid)).toEqual([true, true])

    const line = e.textBlocks(id).find((b) => b.text === 'Certified agreement')!
    e.replaceBlock(id, line, 'Edited agreement')
    const sigs = resave(e)
    expect(sigs[0].valid).toBe(false)
    expect(sigs[0].problem).toMatch(/pages/)
  })

  it('only certifies documents that are not yet signed', async () => {
    const e = new Engine()
    e.open('c.pdf', formPdf())
    await e.sign({ p12, password: 'pw', pageId: null })
    await expect(e.sign({ p12, password: 'pw', pageId: null, certify: 2 })).rejects.toThrow(/first signature/)
  })
})
