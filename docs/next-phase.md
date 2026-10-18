# Next phase: a polished, dependable PDF workspace

## Whole-app experience review — 18 October 2026

The next implementation sequence is defined in [experience-design.md](experience-design.md).
It covers welcome, Home, the PDF workspace, Settings, provider setup, responsive
behavior and shared visual/editorial rules. The review found that the provider
foundation is not yet expressed through a coherent setup experience: onboarding
still emphasizes Claude Desktop, provider controls are hidden until AI is enabled,
and narrow Settings navigation and the full tool dock remain visually crowded.

Design rule: lead with the task, choice and consequence. Put implementation
details in contextual help, Advanced or documentation; keep essential consent,
unsaved-state and destructive-action information visible at the point of action.

The design brief is complete. The first welcome/foundation package is implemented in #63; exact validation
and integration evidence is tracked in issue #44. Other
redesigned screens remain **planned, not implemented**.
Deliver in focused packages: (1) shared shell and concise welcome, (2) Settings and
guided provider connections, (3) reading workspace and contextual tools, (4) Home
and task continuity, (5) cross-screen feedback and performance review. Each package
includes actual before/after visual evidence, copy review and regression coverage.
This replaces the earlier experience-package order below, which remains as history.
Existing reliability work, provider security boundaries and human release gates
continue to apply. No feature/release publication is implied by this design review.

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

## Contextual workspace refinement — 18 October 2026

Active package: labelled Tools entry point, searchable document-tool sections,
page-selection context, active-tool instructions and an explicit unsaved-state
indicator. Search reveals existing controls; it does not execute an operation.
Search uses localized section names and word-prefix keywords (Word does not match
password). Sections stay mounted so entered values survive filtering. Clearing
search restores the section disclosure state. Closing Tools returns keyboard
focus to its opener. The document state comes from the existing revision tracker;
“No unsaved changes” does not assert that a browser download was retained on disk.

Validation includes all three browser engines, light/dark and narrow/desktop
layouts, search/no-results, preserved split ranges, keyboard focus return, axe,
and edit/undo state changes. Candidate evidence will be recorded in issue #44.
Human OS/viewer acceptance remains separate and NOT RUN. Broader contextual
routing from Home, panel consistency and operation feedback remain follow-ups.

## Post-merge validation follow-up — 18 October 2026

PR #57 post-merge CI (39114314952) found Firefox light-theme contrast failures
while section text was fading in. The final color already meets contrast; keep
text opaque throughout the reveal motion instead of relaxing axe checks.
The save lifecycle test now polls the beforeunload guard because the saved
revision can render before asynchronous save cleanup completes. The guard
itself is unchanged. Candidate results are tracked in issue #44.

## Home routing and operation feedback — 18 October 2026

Home task cards now carry the chosen group through file opening: Edit selects
its existing tool; the other groups expand the relevant Tools sections and focus
the first heading. Narrow layouts close the opposite drawer. Routing is scoped
to that import; cancellation and failure consume the intent, and ordinary Open
starts without it. No conversion, signature, redaction or other mutation runs
merely because a group was chosen. Search and manual section controls remain
available, with fields preserved during filtering.

Text, HTML and PNG exports now report completion consistently with Office and
Markdown exports. The message says “Download prepared” because browser download
retention is outside the app's control. Busy, completion and failure feedback
share a polite live region; the existing operation guard and error handling stay
in place. This package does not add cancellation to indivisible export work.

Cross-browser regressions cover every Home group on narrow layouts, picker
cancellation, unchanged source revisions, download names, completion/error
announcements and the save cleanup race. Full local/candidate results belong in
issue #44. Native dialogs and independent-viewer acceptance remain NOT RUN.

Desktop completion for the six Export-section formats now awaits the native
Save As dialog and actual write. Cancellation reports that no file was saved;
write failures flow through the operation error handler. The pending-work guard
remains active through delayed writes. A Tauri mock covers cancellation, held
writes, successful text output and failure; this is automated contract evidence,
not human dialog acceptance. Other output paths (for example PDF/A and batch)
remain a separate lifecycle audit.

## Provider-neutral AI and desktop MCP phase — 18 October 2026

The next phase treats Anthropic/Claude, OpenAI, Google AI/Gemini, xAI/Grok,
Ollama and custom compatible services as equal choices. Keep all AI opt-in and
keep document disclosure approval independent of the selected provider.

### Package 1: provider connection foundation (merged in #60)

Use one endpoint resolver for model discovery, connection checks, consent labels
and inference. Repair the empty OpenAI endpoint falling through to Ollama.
Add named Gemini and Grok choices using their documented compatibility endpoints,
and a custom provider choice. Provider/endpoint changes clear the old key and
model; key prefixes must not silently change provider. Preserve existing explicit
OpenAI-compatible endpoint configurations. Report model-list failures honestly,
ignore stale asynchronous results, and do not replace a user's selected model on
refresh. Connection checks verify model-catalogue access, not inference or billing.

Validation uses mocked provider HTTP contracts and cross-browser Settings flows;
no live account, billable inference or human desktop acceptance is implied.
Settings now adapts to narrow screens, the model refresh control has an explicit
accessible name, and saved manual model selections remain visible after reopening.
Local build and 21 AI unit tests pass. The full local unit run has 197 passes,
six skips and five environment failures from missing Poppler/OpenSSL on PATH;
Post-merge CI passed 204 unit tests, 179 browser tests without retries, Rust tests,
three benchmarks and the independent PDF contracts. All packaging workflows and
Pages deployment passed. Detailed evidence is tracked in issue #44.
Compatibility references checked 18 October 2026:
- https://developers.openai.com/api/reference/resources/chat
- https://ai.google.dev/gemini-api/docs/openai
- https://docs.x.ai/developers/rest-api-reference/inference

### Package 2: saved connections and diagnostics (merged in #61)

Each provider retains one connection (key, endpoint and model), restoring it when
selected. Existing active settings migrate without requiring key re-entry. The
saved connection map is a single encrypted envelope using the existing device
vault; active legacy key storage remains encrypted too. Endpoint/model fields in
the legacy active settings remain plain preferences. This is device storage, not
an independent password-protected vault or protection from code running in the app.

Provider changes reset remembered document-disclosure consent. Endpoint changes
clear the key/model for that connection. Disconnect forgets only the selected
connection and turns AI off; revoking the actual API key remains a provider-account
action. Private-data purge removes all profiles, including across open tabs, and
invalidates pending writes. Switching and checks wait for credential hydration.
Encryption failures keep profiles in memory only and show an in-dialog warning.

The same cancellable, 20-second catalogue check is used for every provider.
Diagnostics distinguish access denial, quota/rate limits, missing catalogues,
provider outages and network/URL/CORS failures without echoing provider error
bodies. Text, image and billing capabilities stay explicitly untested; catalogue
presence is not a capability guarantee. No billable inference is introduced.

Validation covers encrypted persistence, legacy hydration, stale saves and purge,
all six provider switches, reload/disconnect, cancellation, safe diagnostics,
storage failure, accessibility and narrow light/dark layouts. Final evidence and
remaining limitations belong in issue #44. Live account validation remains NOT RUN.

### Subsequent focused packages (planned)

1. Capability-aware model choices and bounded inference diagnostics/cancellation.
   Verify each provider with an approved minimal
   live request before claiming end-to-end account support. Do not infer image or
   structured-output support from a model's name or presence in a catalogue.
2. Client-neutral MCP distribution and diagnostics: pinned/current package,
   Claude and ChatGPT/Codex setup, directory boundaries and actual handshake checks.
3. Opt-in authenticated bridge to the running desktop app: active-document reads
   first, then reviewed mutations with expected revisions, undo, dirty state and
   serialized operations. The current file-oriented MCP cannot see unsaved UI work.
4. Official subscription authentication where supported. ChatGPT plan OAuth is
   separate from API keys and from the MCP client connection. Apply the same UX
   principles to any other provider offering an official supported subscription
   flow; do not assume Claude/Gemini/Grok subscriptions grant API access. Do not
   borrow another application's credentials.

Release reconciliation follows validated package evidence. Human native dialogs,
mobile and independent-viewer acceptance remain NOT RUN. npm and desktop releases
remain unpublished; no sign-in or user-client configuration changes are included
in the connection foundation package.

## Shared entry surfaces and welcome — #63

The first experience package introduces shared heading/action/button patterns used
by Home and Welcome. The welcome now leads with Open a PDF and Explore tools,
with a quiet optional AI link to the AI Settings category. It performs no assistant
scan and does not change AI preferences. Existing assistant setup remains available
from Settings and command search, separate from first run. Show welcome in command
search lets established users revisit the screen without clearing their data.

The existing onboarding marker remains compatible. Closing, Escape and choosing an
entry action dismiss the welcome; cancelling file selection leaves Home usable.
Previously disabled AI stays disabled and hides the optional link. Light/dark and
short-screen layouts retain clear actions and keyboard focus.

Validation covers Chromium, Firefox and WebKit, axe checks, light/dark screenshots,
primary focus, cancelled pickers, existing preferences and revisiting welcome over
an unsaved document. Exact build and full-suite results are tracked in issue #44
and the implementation PR. The broader Settings,
provider-card and viewer redesigns remain planned. Human native/mobile acceptance
and live provider inference remain NOT RUN; no package/release was published.

## Settings and guided connections — candidate implementation

Settings now uses a stable desktop category rail and a full-screen category/detail
flow on narrow displays, with Back navigation and restored category focus/scroll.
The shared heading, surface and action patterns extend into AI & connections.
Essential privacy choices remain available in Privacy & Security; hiding AI does
not delete saved connections or claim to isolate the whole application from a network.

All six providers use the same cards and two-step setup. Draft key/endpoint/model
changes remain in memory until Save and select; cancelling leaves saved profiles
unchanged. Endpoint edits clear the draft key/model. Loading models is explicit,
works while AI is off, and preserves a manually entered model. No automatic model
request runs when opening Settings, switching a saved provider or saving a draft.
The model step shows the destination; Advanced and Details hold technical options
and the limits of catalogue checks. External assistant setup remains separate.

Credential hydration gates setup. Existing encryption, consent invalidation,
disconnect and session-only storage fallback remain in place. Private-data purge
invalidates drafts and pending checks, including first connections with no prior
saved fields. Drafts cannot be saved across a changed privacy revision. Selected
connections are not presented as verified inference or subscription accounts.

Validation covers provider parity, encrypted reload, cancelled drafts/checks,
stale results, endpoint changes, hidden AI, delayed hydration, cross-tab purge,
short mobile navigation, keyboard focus and light/dark accessibility. Exact local,
candidate and post-merge results belong in issue #44 and the focused PR. Human
OS/mobile acceptance and live-provider inference remain NOT RUN. No release is
published by this work.


### Optional AI connection discovery — candidate implementation

Settings → AI & connections → Find connections offers a user-started search with
real per-check progress, restrained animation and reduced-motion support. Manual
setup stays available before, during and after discovery. Opening the wizard,
welcome or Settings never starts a scan.

Two checks finish independently: desktop app/config markers (Claude Desktop,
ChatGPT Desktop, Cursor, Codex and Claude Code command files), and the model
catalogue at http://localhost:11434/v1. The latter sends no keys, refuses redirects
and omits credentials. Both checks are bounded to five seconds. Stop, close,
manual handoff and private-data purge invalidate pending results. Browser users
can check local models but cannot inspect installed applications.

Results claim only App files found, Configuration found or Catalogue reached.
A local result opens an unsaved Ollama-compatible setup draft with explicit model
choice. Nothing automatically links, enables AI or uses a subscription. Claude
Desktop offers a copyable setup command scoped to the current directory; this
wizard no longer writes external configuration itself. Other detected assistants
explain that connection is not implemented. No Codex/Claude Code account-backed
inference is claimed.

Validation covers explicit start, partial results, cancellation, late results,
timeout, closure/purge, manual handoff, unchanged saved settings, mobile light/dark
layouts, reduced motion and accessibility. Native fake-directory tests cover
command files versus directories without executing tools. Exact local and GitHub
evidence belongs in issue #44 and the focused PR. Live-provider inference and
human native/mobile acceptance remain NOT RUN. No release is published.

### Desktop updates — test release published

The default update preference is **Notify me** for new installations and existing
installations without a saved preference. Background checks should announce an
available update; installation requires the user's choice. Automatic updates and
manual-only checks are explicit alternatives, and saved choices are preserved.
Automatic installation must wait until documents and ongoing work are safely
closed. Manual-only mode must not initiate background checks.

The updater is implemented locally with daily background checks, explicit manual
checks, progress and retry feedback under Settings > About, and an in-app update
notice. Installation atomically blocks new work and waits for all documents,
operations, native file pickers/reads, settings writes and dialogs to finish. Changing mode revokes a pending
automatic installation. The signed desktop feed is separate from npm releases;
artifact signatures bind the advertised version as well as the downloaded bytes.

Local validation: production build, 27 updater/preference/settings-storage/signature unit
tests, 30 native-bridge browser checks across Chromium, Firefox and WebKit, 11 Windows native tests,
and the installed Node 1.0.3 package consumer passed. Real signed-file verification
rejects byte tampering and version substitution. Full candidate CI and signed
installer builds passed, followed by successful post-merge CI (39147697447) and
desktop builds (39147697446). Exact evidence is recorded in issue #44.
Human installed-app update/restart acceptance and live-provider inference remain
NOT RUN. The published desktop test release is 0.2.0 (tag desktop-v0.2.0-rc.1);
future feed promotions must use a strictly greater app version, including the
subsequent stable release. The release includes the canonical Node 1.0.3 tarball; npm publication remains separate.
See [desktop update delivery](desktop-updates.md) for signing and promotion.


### Desktop assistant connection buttons — active implementation

Discovery is followed by an explicit **Connect Claude Desktop** action. The user
chooses a folder for PDF tools; cancelling leaves external configuration alone.
Setup preserves unrelated settings, refuses malformed configuration, keeps a
backup and reports configuration success as **Setup saved**, with restart/check
instructions. It does not claim a successful MCP handshake or AI inference.
Node.js 20+ with npm is required; the configuration uses the released canonical
Node 1.0.3 package rather than the older npm latest or experimental Rust CLI.
The copyable command remains under Manual setup. Discovery alone stays read-only.

Next, implement Codex PDF-tool setup through its supported MCP interface, with
matching folder scope, error handling and verification. This is separate from
bringing account-backed AI into OpenQuire. OpenAI now documents an official
[ChatGPT plan usage flow for open-source/local apps](https://developers.openai.com/siwc/token-sharing-open-source).
Evaluate its preview limits, explicit OAuth consent, secure token storage,
refresh/disconnect and inference contracts in a separate focused package before
promising availability. Do not import Codex or Claude login credentials. Other
providers retain equally accessible manual API/local-model setup.

Local validation: production build, five discovery unit tests, 14 Windows native
tests, and a real MCP initialize/tools-list smoke test against the released 1.0.3
package (11 tools) passed. All 45 discovery/connection checks passed across
Chromium, Firefox and WebKit. Candidate delivery evidence belongs in issue #44.
Installed Claude acceptance, Codex button setup and account-backed inference are
not completed by this checkpoint.


### Codex connection and desktop 0.2.1 — active implementation

Codex joins Claude Desktop in the discovery wizard with the same Connect button,
folder choice, manual fallback, error/retry feedback and restart instructions.
Its supported `mcp_servers.openquire` configuration is added to `config.toml`,
preserving other servers, settings and comments. An explicit CODEX_HOME is
respected. Configuration is backed up and atomically replaced; malformed or
conflicting remote entries are refused. No account credentials are inspected.

Desktop 0.2.1 is the intended signed test update containing both connection
buttons. Notify me remains the default. Publish a clearly labelled prerelease
only after candidate checks and signature verification pass, then promote its
verified feed so installed 0.2.0 users can elect to update. Human installed-client
acceptance remains separate from automated bridge/MCP tests. Release and test
evidence will be recorded in issue #44; nothing in this checkpoint claims
ChatGPT/Claude subscription inference inside OpenQuire.


Local 0.2.1 validation: production build, 19 focused discovery/updater/signature
unit tests, native connection/configuration tests, and 90 targeted cross-browser
connection/updater cases passed (three missing-mock mobile failures corrected;
six mobile cases rerun successfully). The installed Codex CLI parsed a fresh
configuration generated by the native handler in an isolated CODEX_HOME, and
that same launch configuration completed MCP initialize/tools-list with 11
tools from Node 1.0.3. Real user configurations were not changed. Candidate and
signed-release validation remain pending at this checkpoint.

### Desktop close correction (18 October 2026)

Installed-app feedback identified a title-bar X that did not close the window.
Tauri's JavaScript close-request listener calls window.destroy() after our guard
allows closing; the main-window capability permitted close but omitted destroy.
The focused correction grants that permission without changing the dirty-document
or active-operation guards. Real-SDK IPC regression tests failed before the
correction and passed afterward. Windows cargo check, production build and 11
Chromium save/lifecycle checks passed, including cancelled save, keep editing,
save-and-close, discard-and-close and active export protection.

Broader local validation: 232 tests passed initially; corpus tests required
Poppler/OpenSSL on PATH. After providing the installed tools, four corpus cases
still failed because their test path extraction splits only on forward slashes.
This is a separate Windows test-harness issue. Installed-app acceptance of the
close correction and release delivery remain pending.

### Clearer desktop AI connections — 0.2.2 candidate

Add a dedicated ChatGPT Desktop connection button using the documented local
MCP configuration shared with Codex, without requiring Codex CLI installation.
The supported interface is ChatGPT Desktop Settings > MCP servers, on the same
local host; ChatGPT web does not consume this configuration. Source checked on
18 October 2026: https://learn.chatgpt.com/docs/extend/mcp.

Claude, ChatGPT and Codex guidance now explains the outcome (using PDF tools
from chats), the folder choice, what is saved and how to finish/check setup in
the other app. Detailed privacy/runtime notes and manual setup stay collapsed.
Setup saved is not a claim of a verified live connection or subscription-powered
inference within OpenQuire. Save files before asking the external assistant to
work on them and reopen externally changed files.

Discovery keeps its real scan visible for at least 900 ms, without invented
findings or percentages. Stop, close, privacy cancellation and manual provider
setup remain available; reduced-motion behavior is preserved. Native unit and
browser validation are in progress. Installed ChatGPT/Claude acceptance and
0.2.2 release delivery are pending and will be recorded in issue #44.

Local candidate validation completed: production build, 10 native discovery/
configuration tests and all 75 discovery browser checks across Chromium,
Firefox and WebKit passed. The browser checks include fast scans, cancellation,
ChatGPT setup/retry, existing Claude/Codex flows, mobile layout, reduced motion
and automated accessibility. Initial selector/clock test failures were corrected
and the complete 75-case suite passed on rerun. Human client handshakes remain
NOT RUN; configuration writing and mocked UI checks do not establish them.
