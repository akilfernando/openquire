import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createDigitalId } from '../src/engine/signing'

const blank = (rotate: 0 | 90 = 0) => {
  const d = new mupdf.PDFDocument()
  d.insertPage(-1, d.addPage([0, 0, 400, 500], rotate, {}, ''))
  return d.saveToBuffer('').asUint8Array().slice()
}

/** A flat form: labels with an underline, a box, a checkbox square and an underscore run. */
const flatForm = () => {
  const d = new mupdf.PDFDocument()
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'))
  d.insertPage(-1, d.addPage([0, 0, 400, 400], 0, { Font: { F1: f } }, [
    'BT /F1 12 Tf 40 350 Td (Name:) Tj ET', '0.5 w 90 348 m 300 348 l S',
    'BT /F1 12 Tf 40 300 Td (I agree) Tj ET', '1 w 100 298 12 12 re S',
    'BT /F1 12 Tf 40 250 Td (Address) Tj ET', '1 w 100 240 200 24 re S',
    'BT /F1 12 Tf 40 200 Td (Phone ____________________) Tj ET',
  ].join('\n')))
  return d.saveToBuffer('').asUint8Array().slice()
}

const reload = (bytes: Uint8Array) => new Engine().open('r.pdf', bytes)
const byName = (e: Engine) => Object.fromEntries(e.state().pages.flatMap((p) => p.widgets).map((w) => [w.name, w]))

describe('form designer', () => {
  it('adds every field kind, and they can be filled and saved', () => {
    for (const rotate of [0, 90] as const) {
      const e = new Engine()
      const id = e.open('f.pdf', blank(rotate)).pages[0].id
      e.addField(id, 'text', [40, 40, 240, 62], { name: 'Full name' })
      e.addField(id, 'multiline', [40, 80, 240, 140], { name: 'Notes' })
      e.addField(id, 'checkbox', [40, 160, 56, 176], { name: 'Subscribe' })
      e.addField(id, 'radio', [40, 200, 56, 216], { group: 'Size' })
      e.addField(id, 'radio', [80, 200, 96, 216], { group: 'Size' })
      e.addField(id, 'choice', [40, 240, 200, 262], { name: 'Plan', options: ['Basic', 'Pro'] })
      const { name: sigName } = e.addField(id, 'signature', [40, 300, 240, 350])
      let w = byName(e)
      expect(Object.keys(w).sort()).toEqual(['Full name', 'Notes', 'Plan', 'Signature', 'Size', 'Subscribe'])
      expect(sigName).toBe('Signature')
      expect(w['Full name'].rect.map(Math.round)).toEqual([40, 40, 240, 62])
      expect(w.Notes.multiline).toBe(true)
      expect(w.Plan.options).toEqual(['Basic', 'Pro'])
      expect(e.state().pages[0].widgets.filter((x) => x.kind === 'radio')).toHaveLength(2)

      e.setField(id, w['Full name'].id, 'Ada')
      e.setField(id, w.Subscribe.id, true)
      e.setField(id, w.Plan.id, 'Pro')
      const radios = e.state().pages[0].widgets.filter((x) => x.kind === 'radio')
      e.setField(id, radios[1].id, true)

      const r = reload(e.save({ compress: 'standard', security: { mode: 'keep' } }))
      w = Object.fromEntries(r.pages[0].widgets.map((x) => [x.name, x]))
      expect(w['Full name'].value).toBe('Ada')
      expect(w.Subscribe.value).toBe(w.Subscribe.on)
      expect(w.Plan.value).toBe('Pro')
      expect(r.pages[0].widgets.filter((x) => x.kind === 'radio').map((x) => x.value === x.on)).toEqual([false, true])
      expect(w.Signature.kind).toBe('signature')
    }
  })

  it('edits properties, moves and deletes fields', () => {
    const e = new Engine()
    const id = e.open('f.pdf', blank()).pages[0].id
    e.addField(id, 'text', [40, 40, 240, 62], { name: 'Email' })
    e.addField(id, 'radio', [40, 200, 56, 216], { group: 'Choice' })
    e.addField(id, 'radio', [80, 200, 96, 216], { group: 'Choice' })
    let w = byName(e)
    e.updateField(id, w.Email.id, { name: 'Work email', required: true, tooltip: 'Your work address', maxLen: 60, multiline: true })
    w = byName(e)
    expect(w['Work email']).toMatchObject({ required: true, tooltip: 'Your work address', maxLen: 60, multiline: true })

    e.moveField(id, w['Work email'].id, [50, 50, 300, 90])
    expect(byName(e)['Work email'].rect.map(Math.round)).toEqual([50, 50, 300, 90])
    const radio = e.state().pages[0].widgets.find((x) => x.kind === 'radio')!
    e.moveField(id, radio.id, [40, 220, 60, 240])
    expect(e.state().pages[0].widgets.find((x) => x.id === radio.id)!.rect.map(Math.round)).toEqual([40, 220, 60, 240])

    e.deleteField(id, radio.id)
    expect(e.state().pages[0].widgets.filter((x) => x.kind === 'radio')).toHaveLength(1)
    const last = e.state().pages[0].widgets.find((x) => x.kind === 'radio')!
    e.deleteField(id, last.id)
    e.deleteField(id, byName(e)['Work email'].id)
    const r = reload(e.save({ compress: 'standard', security: { mode: 'keep' } }))
    expect(r.pages[0].widgets).toEqual([])
    e.undo()
    expect(e.state().pages[0].widgets).toHaveLength(1)
  })

  it('detects fields on a flat form and names them from labels', () => {
    const e = new Engine()
    e.open('flat.pdf', flatForm())
    const { count, state } = e.detectFields()
    expect(count).toBe(4)
    const w = Object.fromEntries(state.pages[0].widgets.map((x) => [x.name, x.kind]))
    expect(w).toEqual({ Name: 'text', 'I agree': 'checkbox', Address: 'text', Phone: 'text' })
    // Running it again finds nothing new.
    expect(e.detectFields().count).toBe(0)
  })

  it('signs into a designed signature field', async () => {
    const e = new Engine()
    const id = e.open('f.pdf', blank()).pages[0].id
    e.addField(id, 'text', [40, 40, 240, 62], { name: 'Name' })
    const { name } = e.addField(id, 'signature', [40, 300, 240, 350], { name: 'Approver' })
    const p12 = await createDigitalId({ name: 'Ada', password: 'pw' })
    const { state } = await e.sign({ p12, password: 'pw', pageId: null, field: name, reason: 'Approved' })
    expect(state.signatures).toHaveLength(1)
    expect(state.signatures[0]).toMatchObject({ field: 'Approver', valid: true, coversWholeFile: true })
    expect(state.pages[0].widgets.map((w) => w.kind).sort()).toEqual(['signature', 'text'])
    await expect(async () => e.sign({ p12, password: 'pw', pageId: null, field: name })).rejects.toThrow(/already signed/)
  })
})
