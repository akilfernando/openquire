# Import lifecycle and initial baselines

Follow-up: [cross-browser checks and repeated browser measurements](browser-baselines.md)
adds focused Firefox/WebKit coverage, a focus-return regression fix and Linux
browser process-tree RSS sampling. The observations below describe the initial
16 October run and retain its original limits.

Measured on 16 October 2026 from main `2e4cefc` before the import changes (engine),
and this work package (browser). No human pilot or release acceptance is implied.

## Lifecycle assessment and selected package

Open/Add pages reads and converts each file before publishing it. MuPDF conversion
is synchronous within the shared engine worker; native LibreOffice conversion is
one awaited command. Interrupting either mid-file is not currently safe. Previously
one failure abandoned remaining inputs, there was no selection progress/stop, and
derived PDFs opened with a saved revision despite no PDF output being retained.

The selected package adds file progress, stop after the current file, continued
processing after per-file errors, and completed/failed/skipped results with retry
guidance. Completed tabs/appends stay available. Converted inputs open unsaved;
ordinary PDFs retain their existing saved state. Add pages captures the target
document before asynchronous reads. Password cancellation skips that file; the
password dialog takes precedence over import progress. A pending stop finishes
the current file, including password interaction; it does not kill shared workers
or native tools. Retrying completed inputs can duplicate tabs/pages, so results
explicitly instruct retrying only failed/skipped inputs.

Remaining work: native picker/path reads happen before this progress UI and can
fail before import begins; native tools lack intermediate stage progress; conversion
within a large single file cannot stop between pages. Exports and PDF/A remain
single-operation busy states without safe cancellation. Batch still finishes its
current file; OCR retains its separate page-boundary stop contract. These are
planned follow-ups, not active work or claims of supported cancellation.

## Engine performance

Run `OPENQUIRE_BASELINE=1 npx vitest run tests/baselines.test.ts` (PowerShell:
`$env:OPENQUIRE_BASELINE='1'; npx vitest run tests/baselines.test.ts`). Record CPU,
OS and Node version printed alongside results. The generated fixtures contain
synthetic text; mixed scans reuse the invoice scan on alternate pages. Each
operation runs once, sequentially in one process, at render scale 1. No OCR runs.

Windows, Intel Core i9-13900H, Node 24.21.0, first run:

| Fixture | Pages | Bytes | Open ms | Render ms | Edit ms | Save ms | Sampled process RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Small text | 2 | 1,062 | 39.33 | 19.59 | 13.39 | 6.16 | 137 |
| Large text | 1,000 | 350,079 | 47.99 | 4.34 | 10.54 | 189.48 | 152 |
| Mixed text/scan | 100 | 1,045,445 | 24.10 | 22.42 | 1.31 | 19.79 | 163 |

RSS is sampled after operations, includes fixture generation, and carries process
allocator/WASM high-water effects across cases. It is **not peak memory**, per-file
allocation, or browser worker memory. Cold initialization affects the small case.
Collect repeated cold/warm runs, browser input-to-paint timings and worker/process
peak memory on representative lower-memory devices before setting hard budgets.
Keep the existing 100 ms fastest-of-three engine annotation guard; these initial
measurements do not justify performance implementation changes or universal limits.

## Accessibility and coverage

Run `npm run build` then `npx playwright test e2e/baselines.spec.ts --workers=1`.
Chromium 153.0.8010.12 at 1440×1000 and 390×1000 reported zero WCAG 2 A/AA axe
violations on the loaded report workspace. Twelve successive Tab presses stayed
inside Settings; Escape dismissed it at both widths. Each run attaches JSON with
browser version, width and violations. The baseline reports violations rather than
silently treating an audit run as a universal accessibility pass.

Existing browser coverage includes onboarding, selected settings/signing/plugin
dialogs, phone review/form/signature saves and workspace keyboard shortcuts. The
configured browser project is Chromium only. Firefox/WebKit, complete dock/sidebar/
thumbnail keyboard traversal, focus restoration and all theme/accent contrast
combinations remain unmeasured. Real mobile and desktop native dialogs and external
viewers remain NOT RUN in `pilot-results.md`.

## Local validation

The lockfile install, production build and canonical CLI build pass on Windows.
The complete Chromium suite passed 70 tests; an additional protected-input
cancellation regression passes in the focused import suite. Two import scheduling
unit regressions pass. The full local unit run has 187 passes, five failures due
to missing Poppler/OpenSSL executables, and six platform/opt-in/native/baseline
skips. Independent PDF contracts therefore require the configured CI toolchain;
they are not recorded as passing locally. Windows filesystem-link tests pass
outside the restricted sandbox. Recovery test bundle URLs now use `fileURLToPath`
so the full browser suite can run on Windows.

`npm ci` reports eight dependency audit findings (four moderate, two high, two
critical). Dependency remediation is separate from this lifecycle package; the
lockfile is unchanged.
