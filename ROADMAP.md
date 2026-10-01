# OpenQuire roadmap

OpenQuire aims to match Adobe Acrobat on everyday PDF work, then do better in the areas Acrobat can't:
local-first privacy, automation, extensibility and price. This roadmap lists the major work in order.
Each release has a theme, a short list of deliverables, and a test for when it's done.

> **Status (October 2026):** every release below, through 1.0, has been delivered; see
> [CHANGELOG.md](CHANGELOG.md). One step remains outside the code: publishing the command-line
> tool to npm, which needs the maintainer's npm account. "Where we are (0.1)" describes the
> starting point, kept for context.

## Where we are (0.1)

OpenQuire already covers most of Acrobat's everyday work. It's built on MuPDF (WebAssembly), so edits
happen inside the original file:

- organize, split and merge pages
- edit lines of text in place
- comments with threaded replies
- form filling
- redaction by area, text, search term or pattern
- headers, footers, Bates numbering and watermarks
- AES-256 passwords and compression
- OCR with an invisible text layer
- certificate-based digital signatures with verification
- conversion from Office, EPUB and HTML
- an Obsidian-style interface with a command palette

The main gaps against Acrobat Pro are:

| Gap | Acrobat | OpenQuire today |
| --- | --- | --- |
| Text editing | Paragraphs that reflow, with the original fonts | Single lines, standard fonts, Latin characters only |
| Signatures | PAdES-LTV, trust lists, timestamps, certification | Integrity and certificate checks only |
| Compliance | PDF/A, PDF/UA, accessibility checker, auto-tagging | None |
| Compare | Side-by-side text and visual comparison | None |
| Automation | Action Wizard, batch processing | Command palette only |
| Platforms | Desktop, mobile, web | Web (desktop browsers) |
| Office export | PDF to Word, Excel, PowerPoint | None |

## 0.2: Foundations

Make the existing features dependable before adding more. Every later release relies on this one.

- **Continuous integration.** A GitHub Actions workflow that runs the type check, the engine tests and
  the build on every pull request. Add browser end-to-end tests with Playwright for the flows I
  checked by hand: open, edit text, highlight, fill a form, redact, password round trip, sign, OCR.
- **Hosting and offline use.** Publish a static build to GitHub Pages or Cloudflare Pages, with a
  link to its source in the About page, which the AGPL requires. Add a service worker so the
  25 MB of engine files are cached and the app works offline and can be installed as an app.
- **Large documents.** `Engine.state()` currently rebuilds every page's information after each
  edit. Switch to per-page changes keyed by page revision, so a 1,000-page document stays responsive.
  Also cap the extracted-text cache: it's keyed by a global counter and never shrinks.
- **Undo after saving signed documents.** Saving a signed document currently reloads it from disk,
  which clears the undo history. Keep the history across that save.
- **Accessibility of the app itself.** Full keyboard navigation of the dock, sidebars and thumbnails;
  focus kept inside open modals; ARIA roles and labels; high-contrast checks for every accent color.
- **Touch and tablets.** Pointer handling for pen and touch, pinch to zoom, and a narrow-screen layout
  where the sidebars collapse into drawers.
- **Prepare for translation.** Move all interface text into message catalogs.

**Done when:** CI runs on every pull request, a hosted build installs and works offline, a 1,000-page
PDF opens and edits without visible lag, and the app passes an axe accessibility audit.

## 0.3: Real editing

Close the biggest gap Acrobat users notice: editing.

- **Paragraph editing.** Group text lines into paragraphs from the extracted text structure. Edit a
  whole paragraph with reflow, alignment and line spacing, matched to the original layout.
- **Font fidelity.** Re-use the original font when it's embedded in full; otherwise substitute a
  bundled metric-compatible font (Liberation, Noto). Write Unicode text with CID fonts, so edits,
  stamps and the OCR text layer support every script, not just Latin.
- **Object editing.** Select, move, resize, replace and delete existing images and vector graphics.
- **Link editing.** Create and edit web and internal links.
- **Form designer.** Add text fields, checkboxes, radio groups, dropdowns, signature fields and buttons;
  set field properties; detect fields automatically on flat forms from OCR and layout.
- **Page labels.** Roman-numeral front matter and custom numbering schemes.

**Done when:** a typical contract can have a paragraph rewritten, a logo swapped and a signature field
added, and the result is indistinguishable from the original apart from those changes.

## 0.4: Trust and compliance

The features regulated industries (legal, finance, healthcare, government) need before switching.

- **Signature validation.** Check trust chains against the Adobe (AATL) and EU (EUTL) trust lists.
  Check revocation with OCSP and CRLs, and embed the revocation data (long-term validation).
  These checks need network access, so they're opt-in with a clear prompt.
- **Signature creation.** RFC 3161 timestamps from a timestamp server you choose; PAdES B-T and B-LT
  profiles; certification signatures that set which later changes are allowed.
- **Sanitize document.** Remove hidden data in one step: metadata, embedded files, JavaScript,
  comments, hidden layers, form data, and text hidden under other content.
- **Accessibility.** An accessibility checker for PDF/UA and WCAG, a reading-order and tag editor, and
  automatic tagging for untagged PDFs.
- **Archiving.** Convert to and validate PDF/A-1b, 2b and 3b. MuPDF can't validate this in the
  browser, so the validator ships with the command-line tool and desktop app from 0.6 onward.

**Done when:** a signature made in OpenQuire shows as valid with long-term validation in Acrobat
Reader, and a tagged PDF passes PAC 2024.

## 0.5: Beyond Acrobat

Features where OpenQuire can lead rather than catch up.

- **Tabs and split panes.** Open several documents at once and view them side by side, as Obsidian
  does. This is also the basis for comparing documents.
- **Compare documents.** Text differences (inserted, deleted, moved) and pixel differences between
  revisions, with a synchronized side-by-side view.
- **Recorded workflows.** Record a sequence of commands from the palette (for example stamp, number,
  flatten, compress, sign) and replay it on many files. Workflows are shareable JSON files.
- **More OCR.** Downloadable language packs, automatic language detection, straightening of skewed
  scans, and table detection.
- **Office export.** PDF to Word (structured text to `.docx`), and tables to `.xlsx`.
- **Optional AI assistant**, off by default and using your own model or API key:
  - summarize a document, and ask questions with cited page references
  - find personal data for redaction, beyond regular expressions
  - fill forms from a saved profile
  - generate alternative text for images, used by the accessibility tools

**Done when:** two revisions of a contract can be compared in under a minute, and a recorded
workflow processes a folder of 100 files with no manual steps.

## 0.6: Platforms

- **Command-line tool and Node library.** The engine has no browser dependencies, so publish
  `openquire` on npm with commands such as `openquire stamp`, `openquire redact --pattern email`,
  `openquire sign`, `openquire ocr` and `openquire run workflow.json`, for scripts and servers.
- **Desktop app (Tauri).** Native open and save in place, PDF file associations, recent files,
  hardware signing tokens and smart cards (PKCS#11), and native LibreOffice and Tesseract for
  higher-quality conversion and OCR.
- **Mobile.** A responsive layout plus a Tauri mobile or app-store build of the offline web app,
  focused on reading, annotating, filling and signing.

## 1.0: Extensibility

Obsidian's community plugins and themes are much of its strength. OpenQuire will offer the same.

- **Plugin API.** Plugins can add commands to the palette, sidebar panes, dock tools and workflow
  steps, and call a stable engine API. Plugins run sandboxed in a worker with declared permissions.
- **Themes and CSS snippets** built on the existing design tokens.
- **Custom hotkeys** for any command.
- **Saved workspace layouts:** which sidebars are open, the active tabs, and preferred tools.
- **A stable public API**, semantic versioning, and documentation for plugin authors.

**Done when:** a third party can publish a plugin (for example a new export format) without forking
OpenQuire.

## Order and reasoning

1. **0.2 first.** Every later feature depends on CI, end-to-end tests and the per-page state rework,
   and hosting is what gets OpenQuire real users and feedback.
2. **Editing (0.3) before compliance (0.4).** Editing is the gap everyday users hit first. Compliance
   matters most for the regulated customers who will pay for support.
3. **0.5 needs tabs.** Compare is built on top of tabs and split panes.
4. **0.6 is mostly packaging.** The command-line tool and desktop app re-use the engine unchanged, but
   they unlock batch processing and native signing tokens.

## Risks and how to handle them

| Risk | Mitigation |
| --- | --- |
| AGPL licensing deters some companies | State it clearly in the docs; offer commercial support; keep the plugin API usable from separately licensed plugins where the AGPL allows |
| MuPDF's JavaScript API is missing features (signing, PDF/A, some editing) | Fill gaps with our own code, as already done for signatures and attachments; contribute fixes to MuPDF; ship native tools on desktop and the command line |
| Download size (25 MB) | Service worker caching, load OCR only when used, and compressed delivery |
| Text editing on unusual or broken PDFs | Fall back to the current line-by-line approach; keep a corpus of hard PDFs in the tests |
| Signature interoperability | Validate every release against Acrobat Reader, pdfsig and the EU DSS validator |
| Maintainer bandwidth | Contributor guide, "good first issue" labels, and a public, prioritized issue board |

## How progress is tracked

Each release becomes a GitHub milestone, and each bullet above an issue labelled by area: `engine`,
`ui`, `signing`, `ocr`, `a11y`, `platform` or `infra`. A release ships when its "done when" test
passes in CI or in a documented manual check.
