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

## Claude Desktop Integration (Model Context Protocol)

Use OpenQuire directly inside **Claude Desktop** on Windows, macOS, or Linux. Claude can read, fill forms, permanently redact PII, compare revisions, and sign PDFs locally without uploading full files to the cloud.

### One-Command Setup

Run this in your terminal or PowerShell:

```sh
npx -y openquire mcp setup
```

This automatically discovers and configures your `claude_desktop_config.json` (including Windows Store MSIX installations). Then **restart Claude Desktop**.

You can verify connection status anytime:
```sh
npx -y openquire mcp status
```

To disconnect:
```sh
npx -y openquire mcp uninstall
```

### Available Tools in Claude

* `openquire_get_metadata`: Inspect page counts, encryption status, permissions, bookmarks, and signature validity.
* `openquire_read_page`: Extract text from a specific page or bounding box `[x0, y0, x1, y1]`.
* `openquire_search`: Search for phrases, quads, and snippets across pages.
* `openquire_inspect_fields`: Inspect interactive AcroForm fields (names, types, values, options, and coordinates).
* `openquire_fill_form`: Fill form dictionaries and update PDF appearance streams non-destructively.
* `openquire_redact_patterns`: Permanent vector/glyph byte-level redaction of PII (emails, SSNs, phone numbers, cards) or exact terms.
* `openquire_organize_pages`: Rotate or delete pages non-destructively.
* `openquire_compare_documents`: Compare two PDF revisions for text additions, deletions, modifications, and visual shifts.
* `openquire_check_accessibility`: Verify PDF/UA tags and heading structure.
* `openquire_digital_sign`: Cryptographically sign documents using zeroized Rust crypto (requires explicit user confirmation).

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
