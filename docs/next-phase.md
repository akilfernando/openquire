# Next phase: a polished, dependable PDF workspace

## Active experience phase — 18 October 2026

PRs #49–55 are integrated. Main at `4251b7b` passed post-merge CI, native
contracts, package consumers, filesystem checks, desktop packaging and Pages.
The earlier plan below is retained as reliability context; its completed packages
are not new work. Human desktop/mobile and independent-viewer acceptance is NOT RUN.

The product direction is a cohesive, aesthetically considered local-first PDF
workspace. Preserve AGPL openness, on-device processing, explicit optional AI
consent and the canonical Node CLI/library and MCP. Communicate breadth through
clear task discovery and precise capability descriptions.

1. **Visual foundation and home/tool discovery (active):** neutral layered
   surfaces, restrained amber, consistent spacing, responsive task groups,
   searchable guidance, existing open/blank/recent entry points. No automatic
   destructive operation after opening a file. Validate both themes, keyboard
   expansion/search, narrow layouts, accessibility and document lifecycle tests.
2. **Workspace refinement (planned):** contextual controls, consistent panels,
   document navigation, visible selection/save state. Apply shared controls
   incrementally; preserve existing engine and save contracts.
3. **Operation feedback (planned):** unify progress, safe-boundary stopping,
   partial results and retry across conversion, export, OCR and PDF/A. Address
   native reads and single-file interruption according to actual support.
4. **Fidelity and inclusive performance (planned):** extend difficult-document
   fixtures, sidebar/thumbnail keyboard navigation, contrast coverage and
   comparable measurements before numerical performance budgets.
5. **Release delivery (planned, requested by user):** audit npm and GitHub
   releases against main; reconcile version policy and capability/release notes;
   validate installed package consumers and exact release artifacts. Publish an
   updated npm package at a suitable validated milestone. GitHub desktop release
   delivery remains gated by real OS/viewer acceptance. Automated packaging is
   not human acceptance. Record source commits and checksums for artifacts.

Deliver focused PRs with regression evidence. The first slice adds a task
catalogue with honest setup guidance; contextual routing to an individual tool
and broader workspace restyling remain subsequent work. No universal PDF fidelity
claim, new AI provider, marketplace or native parity expansion is included.

Visual rules: document-first hierarchy; shared spacing/surface/focus tokens;
legible light/dark themes; clearly labelled controls; designed empty/error/busy
states; no ornamental motion; existing recent-file privacy behavior retained.

Release audit on 18 October: npm latest is `1.0.2`; GitHub latest `v1.0.2`
targets `bf31cc6` and includes desktop assets named `0.1.0`. A separate
`desktop-v1.0.0` draft exists. Do not publish or overwrite that draft incidentally;
reconcile the intended artifact identities as part of release preparation.

## Earlier reliability phase


## Intent and current state

OpenQuire is an AGPL local-first PDF suite aiming to cover everyday Acrobat-style work while offering private on-device processing, reusable automation and extensibility. React presents a MuPDF WebAssembly engine through workers; Tauri supplies desktop integration; the Node CLI/library and MCP expose automation. Optional AI is explicitly opt-in. The native Rust CLI is a separate experimental subset, not a parity replacement.

On 16 October 2026, PR #49 at `03a4741` was merged into main as `ba894f5`. It contains the completed reliability implementation: saved revisions and close guards, safe desktop replacement, encrypted opt-in recovery, ordered private settings and purge, MCP output boundaries, truthful native failures, independent PDF output checks, batch progress/stop/reporting, and package smoke tests. Its six workflows pass: 181 unit tests, 64 browser tests, Rust tests, Node 20/22 installed consumers and three-platform archives/installers. One live TSA test is opt-in and skipped. These are candidate results, not evidence of a released build.

Public npm latest was 1.0.2 in the registry audit; source CLI targets 1.0.3; app/Tauri/Rust manifests use 0.1.0. Historical roadmap milestones do not establish release identity or complete interoperability. Actual desktop dialogs, external-viewer trust acceptance and a representative human pilot remain unverified.

## Close the current phase

1. Completed: integrated #49 and closed the superseded focused #40–43 and #45–48 PRs. Their review context remains available.
2. Verify CI and deployment on the resulting main commit. Close superseded focused PRs only after integration.
3. Preserve the tested commit, workflow links and installer identities in the release record. Current CI artifacts have limited retention.
4. Run the pilot below and fix release blockers before package/release publication. Code integration and release acceptance are separate statuses.

## Goal and priority

Make review/comment/save, fill/sign/verify, and batch redact/stamp predictable on representative documents. The first priority is content correctness and preservation; second is usable recovery and cancellation; third is measured performance and accessibility. Avoid another broad feature expansion before these workflows have evidence.

| Order | Work package and owner | Deliverables | Acceptance |
| --- | --- | --- | --- |
| P0, first | PDF correctness — main Sol | Reproduce text spanning separate BT/ET objects; choose and implement geometry-aware matching that preserves page/line boundaries. Extend corpus for nested form XObjects, OCR layers, hidden content and signed histories. | Positive and negative matches prevent joining unrelated columns/lines; Engine, packaged Node CLI and MCP agree; Poppler plus decompressed-object inspection finds no applied redaction target or older sensitive revision. Marking alone is not removal. |
| P0, parallel | Desktop and viewer pilot — main Sol coordinates; human tester executes OS/viewer tasks | Versioned checklist and result log for Windows/macOS/Linux; independent PDF viewer checks; reproducible failures converted into regression cases. | Cancel Save As preserves dirty state; failed/locked save preserves original; Save/Discard/Keep works on window close; saved annotations/form appearances reopen; certificate integrity and trust results are distinguished. No unresolved data-loss or redaction blockers. |
| P0, after correctness | Native capability boundary — main Sol | Run the same applicable fixtures through native CLI. For unsupported redaction/signature/history behavior, explicitly reject before writes or implement parity with evidence. | Supported operations meet their semantic contracts; unsupported cases return a nonzero status, preserve originals and create no misleading result. Documentation matches tested scope. |
| P1, parallel after interfaces settle | Shared fixture consolidation — bounded Luna tasks reviewed by Sol | Extract existing hidden-content and PDF/A builders with provenance and generation instructions; reuse existing suites. | Existing sanitization and veraPDF checks remain passing; fixtures are reusable without weakening assertions or adding customer documents. |
| P1, after pilot findings | Long-running operation lifecycle — main Sol | Inventory OCR/conversion/batch cancellation; extend safe-boundary cancellation and stage progress where missing, with actionable per-file retry context. | Cancellation never labels partial work complete; current-file completion is explicit; UI remains usable; retry does not silently overwrite or duplicate output. Existing batch behavior is retained. |
| P1, baseline first | Performance and accessibility — main Sol; bounded Luna measurement/checks | Repeatable small/large/mixed scanned document benchmarks, memory measurements, keyboard/focus audit and browser coverage inventory; choose fixes from measured bottlenecks. | Record device/browser, fixture sizes, open/render/edit/save times and peak memory. Agree numerical budgets from baseline before implementation; reject regressions against those budgets. Core flows work with keyboard and narrow screens; expand Firefox/WebKit tests where supported. |
| P0, last | Release identity and delivery — main Sol | Reconcile app/CLI version policy, release notes and capability matrix; rerun registry audit; validate artifacts built from the intended release commit. | Every shipped artifact maps to its source commit and tested capabilities; clean npm installation and all supported desktop packages pass; human pilot result attached. Publication is an explicit delivery action. |

The native capability decision can be developed alongside canonical correctness, but its final contract depends on the shared fixtures. Performance work begins with measurement, not an unbounded rewrite.

## Pilot protocol

The [import lifecycle assessment and initial performance/accessibility baselines](workflow-baselines.md)
record the next focused package, measurement method and remaining gaps. Single-file
conversion interruption and browser peak-memory budgets remain unverified.
The [browser baseline protocol](browser-baselines.md) adds repeated fresh-context/
warm-worker samples, sampled Linux browser-process memory and focused Firefox/WebKit
save/import/keyboard checks. Human pilot acceptance remains separate.

Use the [pilot result template](pilot-results.md), initially marked NOT RUN. Use synthetic or explicitly shareable files. Record OS/browser/viewer versions, source commit, fixture identity, exact steps, expected and actual behavior, output verification and a linked defect for every failure.

- Contract: open, annotate, edit, save, retain the download on mobile, reopen in a second viewer.
- Form/signature: populate a rotated form, sign with a test identity, independently check appearance/integrity and trust; compare ordinary later edits with destructive redaction.
- Desktop: real native dialogs, source-file replacement, locked destination and window close for all three OSes.
- Batch: mixed valid, protected and corrupt inputs; stop between files; inspect all completed outputs and retry only failed/skipped files.
- Recovery: opt in, edit, terminate/restart, restore/discard, opt out and purge; verify storage-unavailable feedback and preservation of ordinary editing.

A human check cannot be marked passed by a mocked bridge or producer-engine reopen. Automated checks support, but do not substitute for, these observations.

## Team and execution

Main Sol owns architectural decisions, engine and document lifecycle changes, App integration, defect triage and final review. Keep one active owner for shared files. Delegate to Luna only bounded fixture extraction, a specified regression test, capability inventory, documentation consistency or CI evidence collection. Each task has named files, expected behavior and a completion check; Sol integrates and reviews it.

Deliver one focused package at a time with its regression evidence. Start canonical redaction reproduction and pilot preparation together; use those results to prioritize subsequent implementation. Avoid date estimates until representative fixtures and human test availability are known.

## Completion and exclusions

The phase is complete when the three user workflows pass automated and recorded pilot acceptance on identified artifacts, no known data-loss/redaction release blocker remains, and capability/version documentation matches delivery. Record lower-priority defects explicitly rather than claiming universal PDF compatibility.

Defer new AI providers, a plugin marketplace, new broad export formats, native mobile packaging and complete native-engine parity. Existing functionality may receive targeted fixes when these workflows require them.

Evidence: [PR #49](https://github.com/akilfernando/openquire/pull/49), [phase tracker #44](https://github.com/akilfernando/openquire/issues/44), [capability matrix](reliability-phase.md), [fixture inventory](../tests/fixtures/README.md).
## Home and discovery implementation evidence

The first slice replaces the empty workspace with a responsive home, six searchable
task groups and expandable instructions. Open, blank document, command palette and
recent files use existing App callbacks. New copy remains in the message catalogue.
The PDF engine, save lifecycle and native bridge are unchanged.

Production build and 33 targeted home/document-lifecycle browser cases passed on
Windows across Chromium, Firefox and WebKit. Light/dark, 1440/390 pixel layouts,
keyboard disclosure, search/no-results and serious/critical axe checks are covered.
Desktop light and narrow dark screenshots were inspected; a search-field cascade
conflict was corrected. The new suite stores screenshots as review evidence, not
pixel-diff baselines. Full-suite and candidate CI results belong in the PR/tracker.
Human touch/desktop/viewer acceptance remains NOT RUN.
