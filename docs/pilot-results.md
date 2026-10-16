# Desktop and independent-viewer pilot

Status: NOT RUN. Automated CI is recorded separately. This template makes no claim of human acceptance.

Record tester/date, source commit, artifact filename and digest, OS/device, browser and PDF viewer versions for each run. Use synthetic or explicitly shareable documents. Attach output evidence and defect links without private document contents.

| Scenario | Platforms | Expected observation | Status / evidence |
| --- | --- | --- | --- |
| Open/edit/cancel Save As | Windows, macOS, Linux | Cancel writes nothing; edits stay visible and unsaved | NOT RUN |
| Save in place/reopen | Windows, macOS, Linux | Second viewer shows edited content and appearances | NOT RUN |
| Locked destination | Windows, macOS, Linux where locking applies | Error is actionable; original remains readable and unchanged; edits remain unsaved | NOT RUN |
| Window close: Save, Discard, Keep | Windows, macOS, Linux | Each choice has its stated effect; failed/cancelled save keeps document open | NOT RUN |
| Review/comment/fill/download | Mobile browser | Download retained on device; second viewer shows comments and field values | NOT RUN |
| Certificate signature | Independent viewer with recorded trust root | Integrity and trust result recorded separately; ordinary edits versus destructive redaction behave as documented | NOT RUN |
| Mixed batch and stop | Desktop or browser | Current file completes; remaining files skipped; report matches outputs; each completed PDF inspected | NOT RUN |
| Recovery after termination | Desktop or browser | Opt-in checkpoint restores as unsaved; discard/opt-out remove checkpoints; ordinary save still works when recovery unavailable | NOT RUN |
| Private-data purge | Desktop or browser | Stored checkpoints and credentials removed; restart does not restore deleted values | NOT RUN |

For failures record exact steps, expected/actual results and a linked issue. Do not check off other platforms based on one platform passing.
