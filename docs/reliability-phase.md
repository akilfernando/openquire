# Reliability phase: capability and release evidence

These changes are under review in issue #44. This document describes the proposed
integrated behavior, not a claim that an npm release or desktop installer already
contains it. Check the commit and package version you actually run.

## Capability matrix

| Operation | Browser / desktop UI | Node CLI and npm Engine | MCP | Native Rust CLI |
| --- | --- | --- | --- | --- |
| Read, inspect, merge, stamp | MuPDF engine; UI controls | Full engine and CLI commands | Scoped tools for inspection and page organization | Experimental PDF subset; `info` reports uninspected capabilities as unknown |
| Redact | Mark, review, apply, save | Terms/patterns and workflows | Derived output within allowed directories | Refused before writes; use Node or the app for permanent redaction |
| Signed input after redaction | Full rewrite discards earlier revisions and invalidates original signatures | Same engine contract | Same engine contract | Not claimed to meet this contract |
| OCR, PDF/A, tagging, compression | Supported with feature-specific limitations in README | TypeScript/MuPDF implementation; PDF/A checked with veraPDF | Accessibility inspection; use the Node CLI for broader operations | Refused with a nonzero exit before output writes |
| DOCX / XLSX export | Simplified reconstruction of text, tables and images | Supported; existing tests parse real containers | Markdown export; Office export is not an MCP tool | Refused; TXT and escaped HTML supported |
| Certificate signing | Browser software ID; desktop also exposes smart-card integration | Software IDs, timestamps and validation features subject to network policy | Explicit confirmation required | RSA/SHA-256 software ID path; encrypted/already-signed inputs and timestamp option refused |
| Recorded workflows | Full supported app steps; batch progress, per-file report, stop between files | Node implementation supports canonical workflow steps | Operations exposed as individual tools | Metadata-only `setMeta` workflows; other steps refused before processing |
| File save and close | Browser prepares downloads; desktop replaces a complete flushed candidate, with Windows rollback backup. Saved revisions and unsaved guards apply per tab | File output behavior is command-specific | New outputs use exclusive creation unless overwrite is explicitly allowed | Not covered by desktop replacement guarantees |
| Recovery | Explicit opt-in; encrypted local checkpoints, newest 3, 16 MiB/document and 32 MiB total, 7 days. Password-protected inputs skipped | No automatic document checkpoints | No automatic document checkpoints | No automatic document checkpoints |

MCP path checks prevent ordinary traversal and symlink escapes. They do not provide
an operating-system sandbox against an adversary concurrently changing directory
entries. Explicit overwrite is not an atomic replacement guarantee. Desktop saves
serialize one app process; external editors and directory durability after power
loss remain outside that guarantee.

Recovery may lag edits. Restoring creates an unsaved document. Missing keys,
storage/quota failures and oversized documents require an explicit file save.
Disabling recovery removes checkpoints; private-data purge deletes the device key
and checkpoint database. Local encryption protects stored values, not a running
app against scripts with access to its own origin.

## Evidence sources

- #40: install the packed npm artifact into a clean consumer on Node 20/22;
  smoke CLI help/version and library PDF redact/save/reopen/TXT; publish that exact
  checked tarball only through the release workflow.
- #41: native CLI refusal/no-write, output format and error-propagation tests.
- #42: Linux/Windows path and output-collision regressions.
- #43: vault-key races, settings ordering, stale hydration and awaited purge.
- #45: real filesystem tests on Linux/macOS/Windows, injected write/commit
  failures, concurrent complete outputs and Windows backup recovery.
- #46: revision/undo/branch tests and browser close/save/tab-switch races.
- #47: common redaction inputs through Engine, Node CLI and MCP; independent
  Poppler text, pdf-lib object inspection and OpenSSL CMS verification. Reused
  OCR, Office and archive fixtures retain their existing checks.
- #48: encrypted recovery storage, stale/opted-out writes, failed replacement,
  missing key, retention limits, purge and restore/disable UI regressions.
- Integrated checks: batch cancellation/report contracts; mobile-width
  annotation/form/image-signature save and reopen inspected using pdf-lib.

The generated corpus and its gaps are documented in
[`tests/fixtures/README.md`](../tests/fixtures/README.md). Independent parsing
checks semantics covered by each test; it is not a claim of universal PDF
interoperability or signature trust.

## Component and publication identity

Source manifests currently use app/Tauri/Rust workspace version **0.1.0** and
npm package `openquire` version **1.0.3**. These identify distinct artifacts;
matching a release tag alone does not establish their feature parity.
The read-only **npm registry evidence** workflow records current public dist-tags,
version and distribution integrity. Its successful result is required to state
publication status; an open issue or an inaccessible web page is not evidence
that the package is unpublished. No package publication is performed by this PR.

The [registry audit on 16 October 2026](https://github.com/akilfernando/openquire/actions/runs/38883315921)
reported public `latest` as **1.0.2**, while the source manifest targets **1.0.3**.
Installing `openquire@latest` therefore does not install this development branch.

## Final pilot and release gates

- [ ] Integrated full CI, tarball consumer smoke, all platform builds and filesystem checks pass on the intended merge commit.
- [ ] Inspect the registry evidence and reconcile source/package versions before publishing.
- [ ] On Windows/macOS/Linux, open a real file, edit, cancel Save As, save in place and reopen independently. Test close-window Save/Discard/Keep editing and a locked destination.
- [ ] In a mobile browser, review a contract, add a comment, fill a form, save, retain the download and reopen it in a second viewer.
- [ ] Fill and certificate-sign a form; verify it in an independent viewer with the intended trust chain. Confirm ordinary edits versus destructive redaction behavior.
- [ ] Batch redact and stamp representative files, stop mid-batch, inspect every completed output and retry failures. Include complex embedded fonts and protected/corrupt inputs.
- [ ] Enable recovery, make changes, terminate the app, restore/discard after restart, then test opt-out and private-data purge. Check bounded retention and unavailable-storage messages.
- [ ] Record pilot findings, fix release blockers and approve the reviewed merge/release artifact.

Automated checks are reported separately from these human pilot tasks. No human
pilot or external-viewer acceptance is implied by a green browser test run.

## Native cryptographic contracts

Native signing is checked with an independent PDF parser and OpenSSL, including a rotated form with existing fields and appearances. The native CMS verifier supports detached, single-signer RSA/SHA-256 messages and checks both signed attributes and the supplied content digest. Unsupported or malformed structures return errors. Signature validity and digest validity must both pass; neither establishes certificate trust, revocation or a trusted signing time. The verifier returns no inferred signing time.

Native redaction is disabled in both the CLI and Rust core API until it meets the shared permanent-removal contract. The previous implementation edited individual encoded text operands and could retain old streams. Use the canonical Node/MuPDF engine or app. Rust redaction entry points now return an error without mutating the document; callers must handle the Result.

