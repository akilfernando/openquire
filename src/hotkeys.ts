/**
 * Keyboard shortcuts for commands. A combo is written like "Mod+Shift+K", where Mod is Ctrl, or
 * Cmd on a Mac. Users can change any command's shortcuts in Settings; their changes are stored as
 * overrides on top of the defaults.
 */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Default shortcuts by command id. */
export const DEFAULT_HOTKEYS: Record<string, string[]> = {
  palette: ['Mod+P'],
  open: ['Mod+O'],
  save: ['Mod+S'],
  settings: ['Mod+,'],
  find: ['Mod+F'],
  undo: ['Mod+Z'],
  redo: ['Mod+Y', 'Mod+Shift+Z'],
  'zoom-in': ['Mod+=', 'Mod++'],
  'zoom-out': ['Mod+-'],
}

/** Commands whose shortcuts also work while typing in a field (they don't conflict with editing). */
export const WHILE_TYPING = new Set(['palette', 'open', 'save', 'settings', 'find', 'zoom-in', 'zoom-out'])

const NAMED: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Esc: 'Escape' }

/** The combo for a key press, or null for a modifier on its own. */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null
  const key = NAMED[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  // For symbols, Shift is already in the character produced ("+", "?"), so it isn't listed.
  if (e.shiftKey && (key.length > 1 || /[A-Z0-9]/.test(key))) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** A combo as shown to the user: Ctrl or Cmd, and readable key names. */
export function displayCombo(combo: string) {
  return combo.replace(/^Mod(?=\+)/, isMac ? 'Cmd' : 'Ctrl')
}

/** Every command's shortcuts: the defaults, with the user's overrides applied. */
export function effectiveHotkeys(overrides: Record<string, string[]>): Record<string, string[]> {
  return { ...DEFAULT_HOTKEYS, ...overrides }
}

/** The command a combo runs, if any. */
export function commandFor(combo: string, map: Record<string, string[]>): string | null {
  for (const [id, combos] of Object.entries(map)) if (combos.includes(combo)) return id
  return null
}

/** Assigns a combo to a command, taking it away from any command that had it. */
export function assign(overrides: Record<string, string[]>, id: string, combo: string): Record<string, string[]> {
  const map = effectiveHotkeys(overrides)
  const next = { ...overrides }
  for (const [other, combos] of Object.entries(map)) if (other !== id && combos.includes(combo)) next[other] = combos.filter((c) => c !== combo)
  next[id] = [...new Set([...(map[id] ?? []), combo])]
  return next
}

export function unassign(overrides: Record<string, string[]>, id: string, combo: string): Record<string, string[]> {
  return { ...overrides, [id]: (effectiveHotkeys(overrides)[id] ?? []).filter((c) => c !== combo) }
}

/** Restores a command's default shortcuts, taking them back from any command that has them now. */
export function resetHotkey(overrides: Record<string, string[]>, id: string): Record<string, string[]> {
  const defaults = DEFAULT_HOTKEYS[id] ?? []
  const map = effectiveHotkeys(overrides)
  const next = { ...overrides }
  delete next[id]
  for (const [other, combos] of Object.entries(map))
    if (other !== id && combos.some((c) => defaults.includes(c))) next[other] = combos.filter((c) => !defaults.includes(c))
  return next
}
