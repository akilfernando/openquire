import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { DocumentSessions } from '../src/document-sessions'

describe('DocumentSessions', () => {
  it('opens an existing saved document clean', () => {
    const sessions = new DocumentSessions()

    sessions.open(1, 'rev-a', true)

    assert.equal(sessions.dirty(1), false)
    assert.deepEqual(sessions.dirtyIds(), [])
  })

  it('opens a new blank document dirty', () => {
    const sessions = new DocumentSessions()

    sessions.open(1, 'blank', false)

    assert.equal(sessions.dirty(1), true)
    assert.deepEqual(sessions.dirtyIds(), [1])
  })

  it('becomes clean after an edit is saved', () => {
    const sessions = new DocumentSessions()
    sessions.open(1, 'rev-a', true)

    sessions.update(1, 'rev-b')
    assert.equal(sessions.dirty(1), true)

    sessions.markSaved(1, 'rev-b')

    assert.equal(sessions.dirty(1), false)
  })

  it('stays dirty when a save finishes at an older revision', () => {
    const sessions = new DocumentSessions()
    sessions.open(1, 'rev-a', true)

    sessions.update(1, 'rev-b')
    sessions.update(1, 'rev-c')
    sessions.markSaved(1, 'rev-b')

    assert.equal(sessions.dirty(1), true)
  })

  it('becomes clean when undo returns to the saved revision token', () => {
    const sessions = new DocumentSessions()
    sessions.open(1, 'rev-a', true)
    sessions.update(1, 'rev-b')

    sessions.update(1, 'rev-a')

    assert.equal(sessions.dirty(1), false)
  })

  it('stays dirty for a new branch token at the same position', () => {
    const sessions = new DocumentSessions()
    sessions.open(1, 'rev-a', true)
    sessions.update(1, 'rev-b')

    // A branch can have the same history position as rev-a but a distinct token.
    sessions.update(1, 'rev-a-branch-2')

    assert.equal(sessions.dirty(1), true)
  })

  it('keeps documents independent when marking one saved', () => {
    const sessions = new DocumentSessions()
    sessions.open(1, 'rev-a', true)
    sessions.open(2, 'rev-b', false)

    sessions.markSaved(1, 'rev-a')

    assert.equal(sessions.dirty(1), false)
    assert.equal(sessions.dirty(2), true)
    assert.deepEqual(sessions.dirtyIds(), [2])
  })

  it('removes a closed document and ignores a late save completion', () => {
    const sessions = new DocumentSessions()
    sessions.open(1, 'rev-a', false)

    sessions.close(1)
    sessions.markSaved(1, 'rev-a')

    assert.equal(sessions.dirty(1), false)
    assert.deepEqual(sessions.dirtyIds(), [])
  })
})
