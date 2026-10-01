/**
 * Tesseract's TSV output (from the installed command-line Tesseract) as text-layer words.
 *
 * TSV gives each word's box and confidence, and each line's box, but no baseline. Line boxes run
 * from the tallest ascender to the lowest descender, so the baseline is placed a fixed share of
 * the way down, which is close for Latin text in the standard fonts.
 */
import type { OcrWord } from './types'

const BASELINE_SHARE = 0.78

export function wordsFromTsv(tsv: string, scale: number, minConfidence = 30): OcrWord[] {
  const lines = new Map<string, { top: number; height: number }>()
  const words: { key: string; text: string; left: number; top: number; width: number; height: number }[] = []
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split('\t')
    if (c.length < 12) continue
    const [level, , block, par, line, , left, top, width, height, conf] = c.slice(0, 11).map(Number)
    const text = c.slice(11).join('\t').trim()
    const key = `${block}.${par}.${line}`
    if (level === 4) lines.set(key, { top, height })
    else if (level === 5 && text && conf >= minConfidence) words.push({ key, text, left, top, width, height })
  }
  return words.map((w) => {
    const line = lines.get(w.key) ?? { top: w.top, height: w.height }
    const baseline = line.top + line.height * BASELINE_SHARE
    return {
      text: w.text,
      bbox: [w.left / scale, w.top / scale, (w.left + w.width) / scale, (w.top + w.height) / scale],
      baseline: baseline / scale,
      // Ascender to baseline is about 0.75 em in the standard fonts.
      size: Math.max(2, (baseline - line.top) / 0.75 / scale),
    }
  })
}
