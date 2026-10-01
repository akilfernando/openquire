# openquire

PDF tools on the command line and in Node, from [OpenQuire](https://akilfernando.dev/openquire/),
the open source PDF suite. Everything runs locally on MuPDF; no files are uploaded.

```sh
npx openquire redact --pattern email ./contracts -o ./redacted
npx openquire stamp ./production --text "ACME-{bates}" --position br --bates-start 1
npx openquire ocr scan.pdf --lang fra
npx openquire sign contract.pdf --p12 me.p12 --timestamp https://rfc3161.ai.moda
npx openquire run workflow.json ./inbox -o ./done
npx openquire pdfa report.pdf --part 2
npx openquire export report.pdf --to docx
```

Run `npx openquire --help` for every command and option. Commands take files or folders, process
each file in turn and write results next to the inputs (or into `--out`), so originals are never
changed. Workflows recorded in the OpenQuire app run here unchanged, and Bates numbers continue
from one file to the next.

## As a library

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { Engine, REDACTION_PATTERNS } from 'openquire'

const e = new Engine()
e.open('in.pdf', readFileSync('in.pdf'))
e.markPattern(REDACTION_PATTERNS.email)
e.applyRedactions()
writeFileSync('out.pdf', e.save({ compress: 'standard', security: { mode: 'keep' } }))
```

Requires Node 20 or later. Licensed under the AGPL-3.0, like MuPDF.
