import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/core'
import { createDigitalId } from '../src/engine/signing'
import { PDFDocument, PDFDict, PDFName, PDFString } from 'pdf-lib'

const saveOptions = { compress: 'none' as const, security: { mode: 'keep' as const } }

function blank() {
  const engine = new Engine()
  const state = engine.newBlank()
  return { engine, state }
}

describe('document content revisions', () => {
  it('does not reuse a signed save from a discarded branch at the same journal position', async () => {
    const { engine } = blank()
    const p12 = await createDigitalId({ name: 'Revision signer', password: 'fixture-only' })
    await engine.sign({ p12, password: 'fixture-only', pageId: null })
    const id = engine.pageIds()[0]
    const annotate = (text: string) => engine.addAnnot(id, { type: 'Text', at: [10, 10], text, color: [1, 1, 0] })
    annotate('Discarded branch')
    const first = engine.saveSnapshot(saveOptions)
    engine.undo()
    annotate('Current branch')
    const second = engine.saveSnapshot(saveOptions)
    expect(second.revision).not.toBe(first.revision)
    const parsed = await PDFDocument.load(second.bytes)
    const contents = (parsed.getPages()[0].node.Annots()?.asArray() ?? []).map((ref) => {
      const value = parsed.context.lookup(ref, PDFDict).get(PDFName.of('Contents'))
      return value instanceof PDFString ? value.decodeText() : ''
    })
    expect(contents).toContain('Current branch')
    expect(contents).not.toContain('Discarded branch')
    engine.close()
  })
  it('keeps reads stable and follows edits, undo, redo, and divergent branches', () => {
    const { engine, state } = blank()
    const initial = state.revision

    expect(engine.state().revision).toBe(initial)
    expect(engine.state().meta).toEqual(state.meta)
    expect(engine.exportText()).toBe('')
    expect(engine.state().revision).toBe(initial)

    const edit = (text: string) => engine.addAnnot(state.pages[0].id, {
      type: 'Text', at: [10, 10], text, color: [1, 1, 0],
    }).state.revision

    const firstEdit = edit('note')
    expect(firstEdit).not.toBe(initial)
    expect(engine.undo().revision).toBe(initial)
    expect(engine.redo().revision).toBe(firstEdit)
    expect(engine.undo().revision).toBe(initial)

    const branchEdit = edit('branch note')
    expect(branchEdit).not.toBe(firstEdit)
    expect(engine.state().canRedo).toBe(false)
  })

  it('captures a save snapshot revision and ordinary saves leave it unchanged', () => {
    const { engine, state } = blank()
    const snapshot = engine.saveSnapshot(saveOptions)
    expect(snapshot.revision).toBe(state.revision)
    expect(snapshot.name).toBe('untitled')

    const afterSaveRevision = engine.state().revision
    const ordinaryBytes = engine.save(saveOptions)
    expect(ordinaryBytes.byteLength).toBeGreaterThan(0)
    expect(engine.state().revision).toBe(afterSaveRevision)

    engine.addAnnot(state.pages[0].id, { type: 'Text', at: [10, 10], text: 'later', color: [1, 1, 0] })
    expect(engine.state().revision).not.toBe(snapshot.revision)

    const reopened = new Engine()
    const reopenedState = reopened.open(`${snapshot.name}.pdf`, snapshot.bytes)
    expect(reopenedState.pages).toHaveLength(1)
    expect(reopenedState.revision).toBeDefined()
  })

  it('tracks metadata as content and preserves it through save and reopen', () => {
    const { engine } = blank()
    const before = engine.state().revision
    const metadata = { title: 'A title', author: 'An author', subject: 'A subject', keywords: 'one, two' }
    const changed = engine.setMeta(metadata)
    expect(changed.revision).not.toBe(before)
    expect(changed.meta).toEqual(metadata)

    const bytes = engine.saveSnapshot(saveOptions).bytes
    const reopened = new Engine()
    expect(reopened.open('metadata.pdf', bytes).meta).toEqual(metadata)
  })

  it('assigns a new revision epoch when the document is replaced', () => {
    const engine = new Engine()
    const original = engine.newBlank()
    const bytes = engine.save(saveOptions)

    const replacement = engine.newBlank()
    expect(replacement.revision).not.toBe(original.revision)

    const opened = engine.open('replacement.pdf', bytes)
    expect(opened.revision).not.toBe(replacement.revision)
  })
})
