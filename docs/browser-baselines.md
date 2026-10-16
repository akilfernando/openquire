# Cross-browser checks and repeatable browser measurements

This package follows the initial engine-only measurements in
[workflow-baselines.md](workflow-baselines.md). It adds evidence for choosing
future performance/accessibility work, without changing PDF features or claiming
human desktop/mobile/viewer acceptance.

## Keyboard regression and browser scope

The Settings focus-return regression failed in Chromium, Firefox and WebKit on
the parent implementation. `IconButton` was defined inside `App`, so every App
render remounted the opener. The focus trap captured a disconnected button and
could not restore focus. Hoisting that component preserves the DOM identity.

The regression checks both Tab directions and focus return after Escape at desktop
and narrow widths. A second check covers dock arrows, Home and End. The existing
workspace axe baseline now rejects serious/critical WCAG A/AA violations and keeps
the full violation evidence attachment for investigation.

The complete app suite remains Chromium. Firefox and WebKit run a focused set:
workspace axe checks at both widths, keyboard tests, all import stop/error/password
contracts and all document save/dirty/close race tests. This does not establish
full browser parity, real touch-device acceptance, every theme/accent contrast
combination or a complete sidebar/thumbnail keyboard audit.

Run `npm run build`, `npx playwright install chromium firefox webkit`, then
`npm run test:e2e`. On Linux use Playwright's documented `--with-deps` installation
as CI does. WebKit automation is not a test of a particular installed Safari build.

## Browser measurement protocol

Run `npm run build` then `npm run benchmark:browser`. It uses a separate preview
server on port 4174, one worker, no retries and Chromium only. Avoid simultaneous
CPU-heavy tests when collecting comparable measurements. The benchmark is part of
full CI; successful runs retain raw JSON as `browser-baselines` artifacts for 30 days.

Each small (2-page), large (1,000-page), and mixed scan/text (100-page) fixture starts
a new browser. Three trials each create a fresh context, open/edit/save/close the
file, and repeat using the same page and worker. Thus each fixture has three
fresh-context and three warm-worker samples. The mixed fixture starts with an
image-only page; alternate pages contain synthetic text. Documents are generated
from repository code, not customer inputs.

Every output is downloaded fully and parsed with pdf-lib to confirm the page count
and retained annotation. Metrics include:

- `firstCanvasMs`: file submission start to the first actual page-canvas draw,
  observed by forwarding the real canvas `drawImage` call unchanged. This is not
  a screen presentation timestamp, total-document render time or isolated engine time.
- `openUiMs`: file submission through the automation-observed rendered workspace.
- `editUiMs`: selecting/placing a sticky note through the dirty-state acknowledgement.
- `saveDownloadMs`: clicking Save through completed download streaming.

UI timings include browser/automation scheduling and worker transport. Fresh
contexts do not clear OS disk caches or start a new browser process per sample.
The first sample may include additional browser/WASM initialization. Keep raw
samples and compare like-for-like medians, rather than treating one minimum as a budget.

JSON records the source commit and dirty-checkout flag, OS, CPU, system RAM,
browser version, viewport, input/output bytes, trial and profile. A dirty working
tree or mismatched production build is unsuitable as a release baseline; build
immediately before measurement. CI builds its checked-out source before measuring.

## Memory method and limits

Linux samples `/proc` RSS for the explicitly launched browser root PID and its
descendants, including renderer processes hosting workers, every 100 ms. The JSON
reports the highest observed sum and sample count over all trials of that fixture.
Unit coverage checks descendant inclusion, names containing parentheses/spaces,
unrelated processes and unavailable data. Linux runs fail if no measurement is
available. Windows currently reports memory as unavailable, not zero.

This is an **observed process-tree RSS high-water sample**, not an exact peak,
unique physical allocation or JS-only heap metric. Shared pages can be counted by
several processes; short-lived spikes and already-exited subprocesses can be missed.
It excludes the test runner, fixture generation and preview server. Browser allocator
and cache retention between trials is included. Exact peak attribution and
representative lower-memory devices remain follow-ups.

No hard numerical performance gate is introduced from a single machine or CI run.
Use the existing engine edit guard and correctness tests while collecting stable,
comparable baselines. Set budgets before selecting performance optimizations.

## First isolated local run

17 October 2026, clean source `e450c81b79351d8c12e09a078da920f6678fa322`,
Windows, i9-13900H, 33,957,584,896 bytes system RAM, Chromium 153.0.8010.12,
1440×1000. No other test suite ran concurrently. The production runtime matches
this implementation; later commits record this evidence only.
[Raw samples](baselines/windows-browser-e450c81.json) retain all 18 measurements.

Median milliseconds, three samples per row:

| Fixture | Profile | UI open | First canvas | Note edit | Save/download |
| --- | --- | ---: | ---: | ---: | ---: |
| 2-page text | Fresh context | 437 | 401 | 230 | 168 |
| 2-page text | Warm worker | 75 | 58 | 338 | 148 |
| 1,000-page text | Fresh context | 1,048 | 932 | 302 | 360 |
| 1,000-page text | Warm worker | 323 | 272 | 238 | 361 |
| 100-page mixed scan/text | Fresh context | 690 | 566 | 147 | 260 |
| 100-page mixed scan/text | Warm worker | 298 | 230 | 210 | 235 |

These include automation overhead and show why fresh-context and warm-worker
results must remain separate. Windows memory remains explicitly unavailable;
Linux CI supplies the process-tree samples. More devices and repeated independent
runs are needed before inferring regressions or choosing a performance rewrite.
