# OpenQuire

A free, open source PDF suite that runs entirely in your browser. Files are processed on your
device by [MuPDF](https://mupdf.com/) compiled to WebAssembly and are never uploaded anywhere. (The optional AI assistant is the one exception, and it sends only what you approve, only to the provider you choose.)

## Features

| Area | What you can do |
| --- | --- |
| View | Fast, accurate rendering, zoom, thumbnails, several documents in tabs, two side by side with linked scrolling, find with match navigation, text selection and copy |
| Edit | Edit whole paragraphs that reflow, in the document's own embedded fonts; text boxes; move, resize, replace and delete images; erase graphics; whiteout; links |
| Comment | Highlight, underline and strike through text; sticky notes; pen, rectangles, ellipses, arrows; threaded replies; comments panel with filtering |
| Compare | Compare two versions: changed, added, removed and moved text, and changed graphics, highlighted in both documents side by side |
| Workflows | Record steps as you work, then replay them on the open document or on hundreds of files at once (results in a zip, Bates numbers continuing across files); share workflows as JSON |
| AI assistant (optional) | Off by default. With your own Anthropic API key or any OpenAI-compatible model (including local ones): summaries and answers with page citations, personal data found and marked for redaction, forms filled from your details, alternative text for figures. Every request is shown and approved first |
| Organize | Merge PDFs and other files, drag to reorder, rotate, delete, extract, insert blank pages, crop |
| Split | By page ranges (`1-3, 4-6, 7-`) or every page, as a zip; each part keeps its structure |
| Forms | Fill text fields, checkboxes, radio buttons and dropdowns on the page; design forms (add, move, resize and configure fields); detect fields automatically; flatten |
| Sign | Draw, type or upload a signature, remembered on this device |
| Digital signatures | Sign with a certificate (.p12/.pfx) or a self-signed ID created in the app; certify documents; trusted timestamps and long-term validation (PAdES B-T, B-LT and B-LTA); trust chains checked against bundled and user-added roots; later edits are appended so signatures stay valid |
| OCR | Recognize text on scanned pages and add an invisible, searchable, selectable text layer, entirely on-device; twelve Western European languages, detected automatically (English built in, others downloaded on request); crooked scans straightened first |
| Redact | Mark areas, text selections, search terms or patterns (emails, phone/card numbers, dates, URLs), then apply. Only the covered content is removed. |
| Accessibility | Check against PDF/UA; tag untagged documents automatically (headings, paragraphs, figures, links, form fields); edit tag types, reading order and alternate text |
| Archive | Save as PDF/A-2b or 3b (validated with veraPDF) and run a quick PDF/A check |
| Sanitize | Remove metadata, hidden text and layers, scripts, attachments, comments and earlier revisions |
| Stamp | Headers, footers, page numbers, Bates numbering and watermarks, written into the page |
| Protect | Open password-protected PDFs; add, change or remove AES-256 passwords and permissions |
| Compress | Lossless clean-up, or image downsampling and re-compression |
| Bookmarks & files | Add, rename and delete bookmarks; page labels; attach, extract and remove embedded files |
| Convert | Open Word, Excel, PowerPoint, EPUB, HTML, text and images as PDF; export Word (paragraphs, headings, images and tables), Excel (detected tables, numbers as numbers), PNG, text or HTML |
| Properties | Title, author, subject and keywords |
| Undo | Unlimited undo and redo for every change |

Changes are saved into the existing file, so links, bookmarks, form fields, tags and comments are
preserved when you reorganize pages. Annotations are standard PDF annotations that Acrobat and other
viewers can display and reply to.

## Design

The interface is modelled on [Obsidian](https://obsidian.md): its neutral base color scale, thin
[Lucide](https://lucide.dev) icons, a ribbon, icon-tabbed collapsible sidebars, a workspace tab bar and
view header, a floating status bar, a command palette (`Ctrl+P`) and a settings modal (`Ctrl+,`), in
light and dark themes. OpenQuire's twist is an amber "highlighter ink" accent (other accents are in
Settings), pages laid on a dot-grid desk, and a floating tool dock in the style of Obsidian Canvas.

## Getting started

```sh
npm install
npm run dev      # start the app at http://localhost:5173
npm test         # engine tests (run in Node)
npm run build    # production build in dist/ (static files, host anywhere)
```

Requires Node 20+ and a current Chrome, Edge, Firefox or Safari.

## Command line and Node

The same engine runs without a browser. `cli/` builds the `openquire` package: a command-line tool
(`openquire redact --pattern email ./folder`, `stamp`, `ocr`, `sign`, `run workflow.json`, `merge`,
`compress`, `pdfa`, `tag`, `export`) and a Node library exporting the `Engine`. Build it with
`npm run build:cli` and run `node cli/dist/openquire.mjs --help`. See [cli/README.md](cli/README.md).

## Translating

All interface text lives in `src/i18n/en.ts`. To add a language, copy it (for example to `fr.ts`),
translate every entry, and register it in `src/i18n/index.ts`. Entries with counts or names are
functions, so each language controls its own plurals and word order, and TypeScript reports anything
missing.

## How it works

- `src/engine/core.ts` is the whole PDF engine: a class wrapping MuPDF that owns the open document.
  It has no browser dependencies and is covered by `tests/engine.test.ts`.
- `src/engine/worker.ts` runs the engine in a Web Worker; `src/engine/client.ts` exposes it to the UI
  as an async proxy and schedules page renders so visible pages come first.
- Every change is a MuPDF journal operation, which is what makes undo/redo work across all features.
- The UI (`src/App.tsx`, `src/components/`) renders page bitmaps from the worker and draws
  interaction overlays (selection, handles, form inputs, editors) on top.
- `src/engine/signing.ts` creates digital IDs and signs (CMS / `adbe.pkcs7.detached`, SHA-256) and
  verifies PDFs with node-forge, writing each signature as an incremental update.
- `src/ocr.ts` runs Tesseract (WebAssembly) on page renders; `npm run assets` copies its engine and
  English data into `public/ocr` so nothing is fetched from a CDN.

## Known limitations

- **Text editing** falls back to a standard font when the original font is not embedded or is missing
  characters for the new text.
- **Revocation checks** (OCSP and CRL) can't run from a web page, because certificate authorities don't
  allow cross-origin requests. The desktop app and command-line tool (0.6) will do them. Signing a
  password-protected document requires removing the password first.
- **Automatic tagging** recognises headings, paragraphs and figures, but not tables or lists, and reading
  order follows the content order. Review the result in the Accessibility panel.
- **OCR** covers Western European languages only, because its text layer uses the standard Latin fonts.
- **Office conversion** is basic: complex layouts, and some formatting such as bold headings, may not survive.
- **Word export** rebuilds the document as flowing text, so complex layouts (columns, text wrapped around pictures) come out simplified.
- **Large downloads:** the WebAssembly engine is about 10 MB (4.8 MB gzipped) on first load; OCR
  fetches a further 15 MB the first time it's used.

## Roadmap

See [ROADMAP.md](ROADMAP.md). In short: reliability and hosting (0.2), paragraph editing and a form
designer (0.3), long-term signatures and accessibility (0.4), compare and recorded workflows (0.5),
the command-line tool and desktop app (0.6), and a plugin API (1.0).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). OpenQuire is built on MuPDF, which is
licensed under the AGPL by Artifex Software. If you run a modified version as a network service, the
AGPL requires you to offer its source code to your users.
