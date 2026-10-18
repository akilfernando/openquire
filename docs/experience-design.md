# OpenQuire experience design

Status: design proposal, 18 October 2026. Implementation is planned, not shipped.
Baseline reviewed: main `8157d39` (through #61). This brief supersedes the earlier
experience-package order in next-phase.md; reliability and release gates remain.

## Product promise

A considered workspace for everyday PDF work: easy to enter, comfortable to read
in, capable when needed, and clear about what happened to your document. Breadth
comes from discoverable tasks and dependable results. Keep the document central,
AI optional, providers equally welcome, and privacy choices understandable.

## Review findings

Observed in the local browser at approximately 518 px width, dark theme:

- Welcome leads with a privacy slogan, an AI-disable control and Claude Desktop
  setup. It asks users to understand integrations before doing PDF work.
- AI Settings hides provider configuration until AI is enabled. Its visible
  controls emphasize two opposite toggles and Claude Desktop, obscuring the
  provider-neutral connection work already shipped.
- Settings navigation wraps nine categories across rows above a scrolling form.
- The blank-document workspace exposes seventeen tool icons in a wrapping dock,
  alongside separate navigation, save and active-tool rows.
- Home has a prominent introductory card and six task groups. Source inspection
  confirms recent files come after all tool groups.

These are observations, not a human usability study. Desktop layout was reviewed
in source, not visually certified in this pass. No real documents or provider
credentials were used. Existing automated tests do not establish human acceptance.

## Editorial rule: help users act

Explain the task, the choice and the consequence. Implementation detail should
appear only when it changes a decision the user must make. Use three levels:

1. **At the point of action:** short labels, necessary inputs, current state and
   consequential warnings. A normal setting should seldom need a paragraph.
2. **On request:** a short explanation under Help, Details or Advanced. Keep help
   beside the relevant control; avoid repeating it throughout the application.
3. **Documentation and diagnostics:** protocols, storage mechanics, compatibility
   details, setup commands and troubleshooting evidence.

Examples of proposed copy (not all represent implemented controls):

| Situation | Primary interface | Details when needed |
| --- | --- | --- |
| First run | Open a PDF. Your files are processed on this device. | Privacy documentation and optional network features |
| AI entry | Add an AI provider | Provider-specific setup instructions |
| Model-list check | Models loaded / Could not load models | What was checked; inference has not been tested |
| External assistant | Use OpenQuire with your assistant | Client-specific MCP setup and directory access |
| Disclosure approval | Send these pages to [provider]? | Exact included text/images and destination; available before approval |
| Saved connection | Saved on this device | Credential storage and removal details |
| Export | Download prepared | Format options and limitations relevant to the output |

Do not hide consent scope, destructive effects, unsaved changes or failures in
help. Avoid claims such as “air-gapped”, “zero cloud uploads” or “100% local” as
blanket product assurances when optional network features exist. Describe the
actual behavior of the action. A model-list check must not produce an unqualified
“Connected” or “Ready” badge. Do not label a browser download as a confirmed save.

## Shared visual foundation

- Retain OpenQuire's amber identity, using it for primary actions and selection.
  Use warm neutral surfaces in light mode and legible charcoal layers in dark.
- Make the PDF the brightest and most prominent surface in the workspace. Remove
  or substantially quiet the decorative desk grid in the default reading view.
- Establish a small reusable set of page, panel, card, field, status and dialog
  patterns. Avoid a separate bordered card for every explanatory sentence.
- Use system fonts, clear heading/body/caption hierarchy, consistent icon strokes,
  and the existing spacing tokens. Use visible text for major destinations.
- Keep one primary action per local decision. Secondary actions remain legible;
  amber is not a substitute for hierarchy. Status always includes text or shape.
- Prefer restrained transitions; honor reduced motion. No remote font dependency,
  ornamental animation or new UI framework is needed for this phase.
- Preserve custom accent/theme support. Verify stock themes and a representative
  custom accent; do not silently discard user appearance settings.

## Screen and journey design

### Welcome

One short welcome screen: product name, a single useful sentence, primary
“Open a PDF”, secondary “Explore tools”, and a quiet optional AI setup link.
Closing or skipping must lead to a fully useful application. Keep first run
versioned so established users are not repeatedly onboarded.

AI setup is a separate, resumable flow invoked when wanted. Do not scan desktop
assistants before the user chooses external-assistant setup. Preserve existing
AI-disabled users' preference; migration must not enable AI or network requests.

### Home

Returning users see Open a file, Create a PDF, and recent documents first. First
run replaces the empty recent section with a useful opening/drop affordance.
Retain the current privacy rules for recent paths; do not add document previews
or persisted contents simply for visual effect.

Keep the six existing tool groups, but make search return actual task names with
a short outcome description. A selected task carries intent through file opening
and focuses its controls. It never runs a mutation automatically. Unsupported
tasks and format limitations must not be advertised as available.

Reduce promotional copy and oversized hero space. Provide a persistent, labelled
Home destination without closing documents or losing their state.

### PDF workspace

Proposed desktop hierarchy:

```text
Home   document tabs                                      Settings
File name / save state       Undo  Redo          Save / Export
Read   Annotate   Edit   Organize   Fill & sign   More tools
Pages / outline |             PDF             | task panel
               |                             | when needed
Page navigation / zoom                       Operation status
```

This is a hierarchy sketch, not a commitment to four permanently stacked rows.
Prototype the combined header at real laptop sizes and reduce chrome height.

Read is the quiet default. Task selection reveals a small relevant toolbar and
optional panel. Selected-object properties appear contextually. Retain shortcuts
and command search for experienced users. Every existing tool needs an explicit
destination before the old dock is removed; do not hide frequent commands several
levels deep or lose split-view behavior.

Left navigation holds pages/outline/search; the right panel holds the current
task, comments or AI. Avoid simultaneous narrow drawers. Always retain document
identity, unsaved state and save access. Switching modes/panels must preserve
selection, zoom, scroll, pending input and undo history where applicable.

Marking redaction and applying permanent redaction remain distinct. Whiteout
must retain its warning that it does not remove sensitive content. Visible polish
must not weaken save, mutation, disclosure or operation guards.

### Settings

Use a larger, coherent settings surface with a stable desktop category list and
a category index/detail navigation on phones. Include a visible Back control and
restore focus/scroll when returning to the category index. Avoid wrapped tab bars.

Proposed grouping, retaining every current setting:

- General & appearance: theme, accent and interface preferences.
- Reading & editing: existing comments and text-recognition preferences.
- Signatures: identities and certificate settings.
- Privacy & data: recovery, saved data and AI availability preference.
- AI & connections: in-app providers and external assistants as distinct sections.
- Shortcuts; Extensions; About.

Use short field labels, immediate validation and predictable save feedback.
Advanced configuration is collapsed initially. Dangerous data actions retain
their explicit scope. Build reusable settings components before migrating forms.

### AI & connections

Show saved providers and an Add provider action even while in-app AI is off,
unless the user has explicitly chosen to hide AI features. Do not require enabling
requests simply to inspect configuration. Show one clear “Use AI in OpenQuire”
control; place the stronger hide/disable preference in Privacy & data with a
clear route back. Do not conflate these two existing preferences during migration.

Give Anthropic, OpenAI, Google AI, xAI, Ollama and custom services the same card
structure and setup quality. Let the user select their provider; don't recommend
one by default or infer account identity from an API-key prefix.

Setup: choose provider → enter required connection details → choose a model →
review and save. Only expose custom endpoints where needed, with an Advanced
route for overrides. Model discovery is an explicit network action. Manual model
entry remains available. Never show fake signed-in states or subscription buttons
for unavailable authentication flows. Saving a configuration need not send data.

Cards show provider, selected model and concise, accurate state: Not configured,
Saved, Checking, Models loaded, or Needs attention. Details show endpoint,
check scope, failure recovery and disconnect. Preserve existing encrypted profiles,
credential hydration guards, consent invalidation and private-data purge behavior.

In-document AI begins with useful actions such as asking about selected text.
Keep provider/model visible and show the actual material being sent before
approval. Conversation context and page selection must be understandable without
knowing token budgets or transport protocols. Cancellation and partial results
must accurately reflect supported behavior.

External assistants get their own setup entry. Explain “Use OpenQuire's PDF tools
from your assistant”; choose the client before showing technical setup. Display
only supported setup paths. Current file-based MCP cannot access unsaved viewer
work; explain that limitation when selecting files, not on the welcome screen.
API billing, subscription sign-in and external-client connections are separate
capabilities. Planned bridges/authentication remain out of this UI delivery scope.

## Responsiveness and feedback

- Wide screens: document plus optional side panels. Medium screens: prioritize
  document width and collapse secondary navigation. Phones: one task drawer at
  a time, labelled compact actions, no wrapping seventeen-icon dock.
- Validate 360, 390, 768, 1024 and 1440 px widths, short landscape heights, 200%
  browser zoom, long filenames/translations and software-keyboard obstruction.
- Target 44 px touch controls; ensure keyboard reachability, visible focus, Escape
  and correct focus restoration. No tooltip-only instructions on touch devices.
- Use one predictable location for operation progress. Preserve progress during
  panel changes; report partial work, cancellation, failure and recovery in place.
  Short completion notices should not conceal persistent errors or dirty state.
- Measure opening, first page rendering and interaction latency against the same
  fixtures and environments as existing benchmarks. Record medians and variation
  before choosing budgets. CSS responsiveness and runtime speed are separate checks.

## Focused delivery order

| Package | Visible outcome | Required evidence |
| --- | --- | --- |
| 1. Shared shell and welcome | Consistent typography/components; concise welcome; useful non-AI path | First-run/returning/AI-disabled flows; keyboard/focus; light/dark screenshots at phone and desktop sizes |
| 2. Settings and connection setup | Clear categories; saved provider cards; guided provider-neutral setup; progressive disclosure | All six providers; migration/reload/disconnect; no unsolicited network calls; stale checks/consent/purge regressions; mobile navigation |
| 3. Reading workspace and contextual tools | Clear Home route, quieter reading, grouped tools and contextual properties | Complete old-to-new command mapping; selection/undo/save/split-view regressions; page/outline keyboard use; visible state during operations |
| 4. Home and task continuity | Compact document hub; recent-first return; specific task search and routing | Cancelled/failed picker does not retain intent; no automatic mutation; empty/recent/search states and narrow layouts |
| 5. Integration and performance pass | Cohesive loading/error/partial-result behavior; polished responsive transitions | Cross-browser suites, accessibility audit, benchmark comparison and representative visual journey review |

Each package includes its visual work and copy review, rather than deferring those
to a final polish PR. Share before/after screenshots of actual implemented screens.
Prefer focused implementation PRs; no large rewrite of App, the PDF engine or AI
transport solely to achieve this design. Update this brief when a prototype or
test demonstrates a better interaction.

Acceptance for the whole experience: a new user can open, read, annotate and save
without encountering AI setup; a returning user can find a document and task
quickly; a user of any supported provider can configure it through the same
quality of flow; every material state is understandable without protocol knowledge.

Automated evidence must be listed separately from human testing. Real provider
accounts, native dialogs, mobile touch acceptance and independent viewers remain
NOT RUN until actually exercised. Release/version reconciliation follows this work;
this plan authorizes no npm or desktop publication.
