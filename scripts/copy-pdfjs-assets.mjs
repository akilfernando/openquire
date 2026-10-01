// Copies the character maps and standard fonts pdf.js needs at runtime into public/,
// so the app renders every PDF without fetching anything from a CDN.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const to = join(root, 'public', 'pdfjs')

mkdirSync(to, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(join(from, dir), join(to, dir), { recursive: true })
}
console.log('pdf.js assets copied to public/pdfjs')
