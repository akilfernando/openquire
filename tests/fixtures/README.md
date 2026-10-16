# Generated PDF corpus

All fixtures are generated from repository-owned test code using synthetic content.
No customer documents, private keys, or production certificates are included.
Run `npm ci && npm test` to generate and exercise them. The contract tests also
require Poppler (`pdftotext`) and OpenSSL, installed by the Linux CI workflow.
Generated files live in temporary directories and are removed after the suite.

| Builder | Properties | Consumers and semantic checks |
| --- | --- | --- |
| `contracts.ts:splitTextPdf` | One email split across PDF text operators; unreachable private-copy sentinel | Engine, Node CLI and MCP redaction; independent text extraction and decompressed indirect-object inspection |
| `contracts.ts:embeddedTextPdf` | Subset embedded DejaVu Sans with Unicode mapping | Same redaction interfaces; Poppler confirms input and output semantics |
| `contracts.ts:separateTextObjectsPdf` | Embedded font split across distinct BT/ET objects; adjacent, separate-column and separate-line layouts | Adjacent text matches terms/patterns and is removed through Engine/Node/MCP; unrelated columns and lines must not match |
| `contracts.ts:signedIncrementalPdf` | Synthetic digital ID; signed base plus later annotation revision | OpenSSL verifies the input CMS signature; all redaction outputs must discard prior revisions |
| `contracts.ts:rotatedFormPdf` | Page rotation 90 degrees; populated text widget | Save/reopen with pdf-lib checks rotation, value and appearance presence |
| `invoice.ts:textPdf`, `scannedPdf` | Invoice source and image-only rendering | Existing OCR alignment/pixel and signature tests |
| `report.ts:reportPdf` | Two-page report, table, prose and image | Existing DOCX and XLSX tests parse produced containers with mammoth and SheetJS |

Text strings and geometry are stable. Cryptographic keys, timestamps and PDF
serialization identifiers are intentionally regenerated; tests compare semantics,
not byte-for-byte snapshots. DejaVu font files come from the existing
`dejavu-fonts-ttf` development dependency and retain that package's license.
Other source code follows this repository's AGPL-3.0-or-later license.

Redacting a signed file requires rewriting it and invalidates its prior signatures.
Preserving a valid original signature would preserve the original signed content.
The output contract takes precedence over signature preservation for destructive
redaction and sanitization.

The integrated suite also checks corrupt/protected input refusal through Engine,
Node CLI and MCP, plus form filling followed by independently verified signing.
Coverage still to add includes native CLI parity, more complex text geometry,
and extraction of the existing hidden-content/PDF-A builders into
this shared directory. Existing sanitization/PDF-A tests remain in their suites.
