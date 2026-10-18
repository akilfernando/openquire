import { describe, expect, it } from 'vitest'
import { DEFAULT_UPDATE_MODE, updateModeOf } from '../src/update-preferences'

describe('desktop update preferences', () => {
  it('defaults new and existing installations to notification only', () => {
    expect(DEFAULT_UPDATE_MODE).toBe('notify')
    expect(updateModeOf(undefined)).toBe('notify')
  })

  it('preserves each explicit user choice', () => {
    for (const mode of ['notify', 'automatic', 'manual'] as const) {
      expect(updateModeOf(mode)).toBe(mode)
    }
  })

  it('recovers invalid stored preferences without silently enabling installation', () => {
    for (const value of [null, true, 1, '', 'auto', {}, []]) {
      expect(updateModeOf(value)).toBe('notify')
    }
  })
})
