# Generated PDF corpus

`updater-signature.json` is a separate synthetic updater verification fixture: a
short text payload, public verification key and Tauri signature. It contains no
private key. Tests reject changed payload bytes, versions and signed metadata.

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
| `hidden-content.ts:hiddenContentPdf` | Invisible OCR text, hidden layer, JavaScript and private metadata | Existing sanitization assertions, including signed source and form clearing |
| `archive.ts:archiveSource` | Standard fonts, comment, form, links, bookmarks and attachment | Existing PDF/A-2b/3b conversion and veraPDF validation |
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
and additional independent viewer coverage. Hidden-content/PDF-A builders are now shared; their existing sanitization/PDF-A assertions remain in their suites.

The Native PDF contracts workflow runs the native executable against these inputs. Redaction must refuse without altering inputs or outputs. Native signing of the rotated form must preserve fields/appearances and pass OpenSSL CMS verification; a changed signed-content byte must fail verification.

