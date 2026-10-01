import { describe, expect, it } from 'vitest'
import { findImageDraws, multiply, invert, patch } from '../src/engine/content'

describe('content stream scanner', () => {
  const isImage = (n: string) => n.startsWith('Im')

  it('finds image draws with their transforms', () => {
    const src = 'q 100 0 0 50 10 20 cm /Im1 Do Q\nq 2 0 0 2 0 0 cm q 30 0 0 30 5 5 cm /Im2 Do Q /Fm1 Do Q'
    const draws = findImageDraws(src, isImage)
    expect(draws.map((d) => d.name)).toEqual(['Im1', 'Im2'])
    expect(draws[0].ctm).toEqual([100, 0, 0, 50, 10, 20])
    expect(draws[1].ctm).toEqual([60, 0, 0, 60, 10, 10])
    expect(src.slice(draws[0].start, draws[0].end)).toBe('/Im1 Do')
  })

  it('is not fooled by strings, comments, inline images or escaped names', () => {
    const src = [
      'BT (fake /Im9 Do \\) still string) Tj ET',
      '% /Im8 Do in a comment',
      'BI /W 2 /H 1 /BPC 8 /CS /G ID \u0000EI/Im7 Doÿ EI',
      '<< /Im6 1 >> pop',
      'q 1 0 0 1 0 0 cm /Im#41 Do Q',
    ].join('\n')
    expect(findImageDraws(src, isImage).map((d) => d.name)).toEqual(['ImA'])
  })

  it('patches draws without touching the rest of the stream', () => {
    const src = 'q 100 0 0 50 10 20 cm /Im1 Do Q 0 0 m 5 5 l S'
    const [d] = findImageDraws(src, isImage)
    expect(patch(src, [{ start: d.start, end: d.end, text: '' }])).toBe('q 100 0 0 50 10 20 cm  Q 0 0 m 5 5 l S')
  })

  it('multiplies and inverts matrices', () => {
    const m: [number, number, number, number, number, number] = [2, 0, 0, 3, 10, 20]
    expect(multiply(m, invert(m)).map((v) => +v.toFixed(9) + 0)).toEqual([1, 0, 0, 1, 0, 0])
  })
})
