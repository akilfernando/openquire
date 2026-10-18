export type UpdateMode = 'notify' | 'automatic' | 'manual'

/** Existing installations without a preference receive update notifications. */
export const DEFAULT_UPDATE_MODE: UpdateMode = 'notify'

export function updateModeOf(value: unknown): UpdateMode {
  return value === 'automatic' || value === 'manual' || value === 'notify'
    ? value
    : DEFAULT_UPDATE_MODE
}
