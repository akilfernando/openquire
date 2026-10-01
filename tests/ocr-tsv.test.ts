import { describe, expect, it } from 'vitest'
import { wordsFromTsv } from '../src/engine/ocr-tsv'

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
const row = (...c: (string | number)[]) => c.join('\t')

describe('Tesseract TSV', () => {
  it('turns word boxes into text-layer words in page space', () => {
    const tsv = [
      HEADER,
      row(1, 1, 0, 0, 0, 0, 0, 0, 2480, 3508, -1, ''),
      row(4, 1, 1, 1, 1, 0, 250, 400, 900, 100, -1, ''),
      row(5, 1, 1, 1, 1, 1, 250, 410, 300, 80, 96.5, 'Parties'),
      row(5, 1, 1, 1, 1, 2, 580, 410, 200, 80, 91, 'agree'),
      row(5, 1, 1, 1, 1, 3, 800, 410, 50, 80, 12, '~'),
      row(5, 1, 1, 1, 1, 4, 870, 410, 50, 80, 95, ' '),
      '',
    ].join('\n')
    const scale = 300 / 72
    const words = wordsFromTsv(tsv, scale)
    // Low-confidence and empty words are dropped.
    expect(words.map((w) => w.text)).toEqual(['Parties', 'agree'])
    expect(words[0].bbox[0]).toBeCloseTo(250 / scale)
    expect(words[0].bbox[3]).toBeCloseTo(490 / scale)
    // The baseline sits within the line, below the middle; the size follows the line height.
    expect(words[0].baseline).toBeGreaterThan(450 / scale)
    expect(words[0].baseline).toBeLessThan(500 / scale)
    expect(words[0].size).toBeGreaterThan(20)
    expect(words[1].baseline).toBe(words[0].baseline)
  })

  it('handles empty output', () => {
    expect(wordsFromTsv('', 1)).toEqual([])
    expect(wordsFromTsv(HEADER + '\n', 1)).toEqual([])
  })
})
