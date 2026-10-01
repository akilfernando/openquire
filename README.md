# OpenQuire

A free, open source PDF suite that runs entirely in your browser. Files are processed
on your device and never uploaded anywhere.

## Features

| Area | What you can do |
| --- | --- |
| View | Continuous scrolling, zoom, thumbnails, text search |
| Organize | Merge PDFs and images, drag to reorder, rotate, delete, extract, insert blank pages |
| Split | By page ranges (`1-3, 4-6, 7-`) or one file per page, downloaded as a zip |
| Annotate | Highlight, freehand drawing, text, images/stamps, whiteout; move, resize, recolour, undo/redo |
| Sign | Draw a signature and place it on any page |
| Redact | Black boxes that really remove the content underneath (the page is rasterized on save) |
| Forms | Fill text fields, checkboxes, dropdowns and radio groups; optionally flatten |
| Stamp | Diagonal watermarks and page numbers |
| Compress | Three levels of image-based compression (best for scans) |
| Convert | Images → PDF, PDF → PNG, PDF → plain text |
| Properties | Edit title, author, subject and keywords |

## Getting started

```sh
npm install
npm run dev      # start the app at http://localhost:5173
npm test         # unit tests for the export engine
npm run build    # production build in dist/ (static files, host anywhere)
```

Requires Node 20+ and a current Chrome, Edge, Firefox or Safari.

## How it works

- [pdf.js](https://mozilla.github.io/pdf.js/) renders pages; [pdf-lib](https://pdf-lib.js.org/) writes the output.
- The working document is a list of page entries (`src/lib/types.ts`), each pointing at a page of a
  source PDF plus pending rotation and annotations. Merging, reordering and deleting only edit that
  list, so every operation is instant and undoable.
- `src/lib/exporter.ts` turns the list into a PDF when you save. It has no browser dependencies and is
  covered by `tests/exporter.test.ts`.

## Known limitations

- Password-protected PDFs can't be opened, and output can't be encrypted.
- Interactive form fields, bookmarks and links survive only when pages keep their original order
  from a single file and nothing is redacted. Otherwise fill and flatten forms before reorganizing.
- Compression rasterizes pages, so text is no longer selectable and vector-only PDFs may grow.
- Added text uses Helvetica and supports Latin (WinAnsi) characters only.
- Existing text in a PDF can't be edited directly; use whiteout plus a text box.

## Roadmap

OCR for scanned documents, encryption and password removal, selectable text layer and text-markup
highlights, in-place text editing, digital (certificate) signatures, PDF/A export, Office conversions,
side-by-side document compare, and a desktop build.

## License

[MIT](LICENSE)
