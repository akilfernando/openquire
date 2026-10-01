/**
 * OCR languages. English is bundled; other language packs are downloaded from jsDelivr (the same
 * files tesseract.js uses) when needed, and only if the user allows it in Settings.
 *
 * Only languages written with Western European characters are offered, because the invisible
 * text layer uses the standard PDF fonts.
 */
export interface OcrLanguage {
  code: string
  /** Common short words, for telling languages apart in recognized text. */
  stopwords: string[]
}

export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', stopwords: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'this', 'are', 'be', 'on', 'it', 'was', 'by'] },
  { code: 'fra', stopwords: ['le', 'la', 'les', 'des', 'et', 'est', 'une', 'dans', 'pour', 'que', 'qui', 'sur', 'pas', 'du', 'au', 'avec', 'sont', 'nous', 'vous'] },
  { code: 'deu', stopwords: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'den', 'ein', 'eine', 'zu', 'von', 'sich', 'auf', 'dem', 'wir', 'sie'] },
  { code: 'spa', stopwords: ['el', 'los', 'las', 'de', 'que', 'y', 'en', 'es', 'por', 'con', 'para', 'una', 'del', 'se', 'no', 'su'] },
  { code: 'ita', stopwords: ['il', 'che', 'di', 'e', 'per', 'non', 'una', 'sono', 'del', 'della', 'con', 'gli', 'le', 'si', 'nel'] },
  { code: 'por', stopwords: ['o', 'os', 'as', 'de', 'que', 'e', 'uma', 'para', 'com', 'em', 'do', 'da', 'no', 'na', 'se', 'ao'] },
  { code: 'nld', stopwords: ['de', 'het', 'een', 'en', 'van', 'is', 'niet', 'dat', 'op', 'te', 'met', 'voor', 'zijn', 'er', 'die', 'wij'] },
  { code: 'swe', stopwords: ['och', 'att', 'det', 'som', 'en', 'av', 'för', 'med', 'inte', 'den', 'till', 'har', 'jag', 'vi', 'om'] },
  { code: 'dan', stopwords: ['og', 'at', 'det', 'er', 'en', 'til', 'af', 'for', 'med', 'ikke', 'den', 'som', 'har', 'jeg', 'vi'] },
  { code: 'nor', stopwords: [] },
  { code: 'fin', stopwords: ['ja', 'on', 'ei', 'se', 'oli', 'mutta', 'kun', 'niin', 'tai', 'ovat', 'sen', 'myös', 'jos'] },
  { code: 'cat', stopwords: ['els', 'les', 'de', 'que', 'i', 'per', 'amb', 'una', 'del', 'als', 'dels', 'aquest', 'seva'] },
]

/**
 * Guesses the language of recognized text from how often each language's common words appear.
 * Text recognized with the wrong language model loses accents but keeps most short words, which
 * is enough to tell. Returns null when there is too little text to judge.
 */
export function detectLanguage(text: string): string | null {
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]+/g) ?? []
  if (words.length < 12) return null
  let best: string | null = null
  let bestScore = 0
  let second = 0
  for (const lang of OCR_LANGUAGES) {
    if (!lang.stopwords.length) continue
    const set = new Set(lang.stopwords)
    const score = words.filter((w) => set.has(w)).length / words.length
    if (score > bestScore) {
      second = bestScore
      bestScore = score
      best = lang.code
    } else if (score > second) second = score
  }
  // Require a clear signal and a clear winner.
  return bestScore >= 0.08 && bestScore >= second * 1.3 ? best : null
}

export const languagePackUrl = (code: string) => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}/4.0.0_best_int`
