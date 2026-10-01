/**
 * Parses a 1-based page range spec such as "1-3, 5, 8-" into groups of 0-based indices,
 * one group per comma-separated part.
 */
export function parseRanges(spec: string, total: number): number[][] {
  const groups: number[][] = []
  for (const raw of spec.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part)
    if (!m || (!m[1] && !m[3])) throw new Error(`Invalid page range "${part}"`)
    const start = m[1] ? Number(m[1]) : 1
    const end = m[2] ? (m[3] ? Number(m[3]) : total) : start
    if (start < 1 || end > total || start > end) throw new Error(`Page range "${part}" is outside 1-${total}`)
    groups.push(Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i))
  }
  if (!groups.length) throw new Error('Enter at least one page range, e.g. 1-3, 4-6')
  return groups
}
