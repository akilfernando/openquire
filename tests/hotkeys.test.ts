import { describe, expect, it } from 'vitest'
import { assign, comboOf, commandFor, effectiveHotkeys, resetHotkey, unassign } from '../src/hotkeys'

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  ({ key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift })

describe('hotkeys', () => {
  it('names key presses the same on every platform', () => {
    expect(comboOf(key('k', { ctrl: true }))).toBe('Mod+K')
    expect(comboOf(key('k', { meta: true }))).toBe('Mod+K')
    expect(comboOf(key('K', { ctrl: true, shift: true }))).toBe('Mod+Shift+K')
    expect(comboOf(key('+', { ctrl: true, shift: true }))).toBe('Mod++')
    expect(comboOf(key('ArrowDown', { alt: true }))).toBe('Alt+Down')
    expect(comboOf(key('F5'))).toBe('F5')
    expect(comboOf(key('Shift', { shift: true }))).toBeNull()
  })

  it('applies user changes on top of the defaults', () => {
    let o: Record<string, string[]> = {}
    expect(commandFor('Mod+F', effectiveHotkeys(o))).toBe('find')
    o = assign(o, 'find', 'Mod+Shift+K')
    expect(effectiveHotkeys(o).find).toEqual(['Mod+F', 'Mod+Shift+K'])
    // Taking a shortcut from another command removes it there.
    o = assign(o, 'export-docx', 'Mod+S')
    expect(commandFor('Mod+S', effectiveHotkeys(o))).toBe('export-docx')
    expect(effectiveHotkeys(o).save).toEqual([])
    o = unassign(o, 'find', 'Mod+F')
    expect(effectiveHotkeys(o).find).toEqual(['Mod+Shift+K'])
    o = resetHotkey(o, 'save')
    expect(effectiveHotkeys(o).save).toEqual(['Mod+S'])
    expect(effectiveHotkeys(o)['export-docx']).toEqual([])
  })
})
