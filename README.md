# OpenQuire

A free, open source PDF suite that runs entirely in your browser. Files are processed on your
device by [MuPDF](https://mupdf.com/) compiled to WebAssembly and are never uploaded anywhere.

## Features

| Area | What you can do |
| --- | --- |
| View | Fast, accurate rendering, zoom, thumbnails, find with match navigation, text selection and copy |
| Edit | Edit existing lines of text in place; text boxes; images; whiteout |
| Comment | Highlight, underline and strike through text; sticky notes; pen, rectangles, ellipses, arrows; threaded replies; comments panel with filtering |
| Organize | Merge PDFs and other files, drag to reorder, rotate, delete, extract, insert blank pages, crop |
| Split | By page ranges (`1-3, 4-6, 7-`) or every page, as a zip; each part keeps its structure |
| Forms | Fill text fields, checkboxes, radio buttons and dropdowns directly on the page; flatten |
| Sign | Draw, type or upload a signature, remembered on this device |
| Digital signatures | Sign with a certificate (.p12/.pfx) or a self-signed ID created in the app; visible or invisible; multiple signatures; validity panel that detects tampering. Later edits are appended so signatures stay valid. |
| OCR | Recognize text on scanned pages (English) and add an invisible, searchable, selectable text layer, entirely on-device |
| Redact | Mark areas, text selections, search terms or patterns (emails, phone/card numbers, dates, URLs), then apply. Only the covered content is removed. |
| Stamp | Headers, footers, page numbers, Bates numbering and watermarks, written into the page |
| Protect | Open password-protected PDFs; add, change or remove AES-256 passwords and permissions |
| Compress | Lossless clean-up, or image downsampling and re-compression |
| Bookmarks & files | Add, rename and delete bookmarks; attach, extract and remove embedded files |
| Convert | Open Word, Excel, PowerPoint, EPUB, HTML, text and images as PDF; export PNG, text or HTML |
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

- **Text editing** works one line at a time and uses the closest standard font (Helvetica, Times or
  Courier), with Western European characters only.
- **Digital signatures** check integrity and the signer's certificate, but not trust chains, revocation
  or timestamps (no LTV). Signatures are `adbe.pkcs7.detached`, not PAdES baseline profiles. Signing a
  password-protected document requires removing the password first.
- **OCR** is English only, and its text uses the standard Latin font set.
- **Office conversion** is basic: complex layouts, and some formatting such as bold headings, may not survive.
- **No PDF to Word** export.
- **No accessibility tagging** or PDF/A validation.
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
