// Writes src/engine/roots.json: the Mozilla root certificates that ship with Node.js, used as
// default trust anchors when checking signatures. Run with `node scripts/make-roots.mjs`.
import { writeFileSync } from 'node:fs'
import { rootCertificates } from 'node:tls'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine', 'roots.json')
writeFileSync(out, JSON.stringify(rootCertificates) + '\n')
console.log(`${rootCertificates.length} root certificates written to src/engine/roots.json`)
