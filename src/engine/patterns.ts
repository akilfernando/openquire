/** Built-in patterns for finding personal data to redact, shared by the app and the command line. */
export const REDACTION_PATTERNS = {
  email: String.raw`[\w.+-]+@[\w-]+(\.[\w-]+)+`,
  phone: String.raw`\+?\d[\d ()-]{7,}\d`,
  card: String.raw`\b(?:\d[ -]?){13,19}\b`,
  date: String.raw`\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b`,
  url: String.raw`https?://\S+`,
} as const

export type PatternName = keyof typeof REDACTION_PATTERNS
