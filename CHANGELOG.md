# Changelog

OpenQuire follows [semantic versioning](https://semver.org) from 1.0. The plugin API is versioned
separately; see the [plugin documentation](https://akilfernando.dev/openquire/docs/plugins.html#versioning).

## 1.0.0

Extensibility.

- Plugin API (version 1): commands, sidebar panes, dock tools, export formats and workflow steps,
  each plugin sandboxed in its own worker with permissions the user approves.
- Themes and CSS snippets on top of the design tokens.
- Custom hotkeys for any command.
- Saved workspace layouts; the desktop app reopens the documents that were open.
- Documentation for plugin and theme authors, published with the site.

## 0.6.0

Platforms.

- Command-line tool and Node library (`openquire` on npm, in `cli/`).
- Desktop app for Windows, macOS and Linux: native open and save in place, file associations,
  recent files, smart cards and hardware tokens (PKCS#11), and installed LibreOffice and Tesseract.
- Phone layout.

## 0.5.0

Beyond Acrobat.

- Workspace tabs and side-by-side view.
- Document comparison: changed, added, removed and moved text, and changed graphics.
- Recorded workflows and batch processing.
- OCR in twelve languages with automatic detection, and straightening of crooked scans.
- Export to Word and Excel, with table detection.
- Optional AI assistant, off by default, with consent before every request.

## 0.4.0

Trust and compliance.

- Long-term signatures: timestamps, certification, revocation data, document timestamps (PAdES
  B-T, B-LT, B-LTA), and trust checking against bundled and user-added roots.
- PDF/A-2b and 3b conversion, validated with veraPDF.
- Accessibility: a PDF/UA checker, automatic tagging, and a tag and reading-order editor.

## 0.3.0

- Paragraph editing in the document's own fonts; image editing; links; page labels.
- Form designer and automatic field detection.
- Sanitizing.

## 0.2.0

- Reliability and performance on large documents, offline support, and hosting on GitHub Pages.
