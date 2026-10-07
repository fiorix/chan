# Check 62 asks for a file chooser without a user gesture

Status: accepted for v0.103.0 by the lead's disposition of 2026-10-07 at the cut; the test-only repair is being built.

## Finding

At the rc1 pin `781ea1391`, the browser matrix's 57-leg whole run had one failed check: `62-binary-transfer-streaming`, ordinal 36. Its 256-file probe waited 15 seconds for a chooser at line 873 and failed with `Waiting for FileChooser failed: 15000ms exceeded`, 161 seconds into the check. The page console said `File chooser dialog can only be shown with a user activation`, 5.3 seconds after the check's last click at line 807. Between that click and the chooser command the check waited for queued uploads to finish and wrote 256 probe files of 256 KiB each, 64 MiB in all. The check had taken about 144 seconds to reach the chooser against about 99 seconds when run alone; the whole run was at the guest's memory cap, without an OOM kill. The same check passed alone thirteen minutes later and in the green whole run at `7fa1676c3`.

The records are the `rawexp-781ea139-01` export (SHA-256 `0418b3fbc4349b69914be8a48a7356a190633c218f8702742abfcfdcccf9bf6a`), `dev/v0103-team/reports/diagnostics-Diagnostics103-check62-raw-context-781ea139.md`, and Review103's reading in `dev/v0103-team/tasks/task-Review103-Lead103-304.md`. Diagnostics' extracted log context is `dev/v0103-team/evidence/Diagnostics103/matrix-781ea139-redread-02/check62-run-log-context.txt`; the failure screenshot shows the Transfers panel and no chooser.

## Reading, not yet a reproduced cause

Review103 reads the delay from the last click to the chooser command and the console warning as a race inside the check that load exposed: the command can run after the page's user activation is gone. That is a source-and-record reading, not a result of a forcing run. The check file is the same blob as at the green candidate, and the rc1 changes did not touch its upload or command path, so Review does not assign this red to the rc1 product change. The 404, 413 and aborted-upload 500 lines and the memory-cap sample do not individually explain the refusal. A command-driven upload with no recent gesture also exposes a separate possible product question, outside this test-only repair.

## Repair

At the 256-file probe, the check will make an in-page call immediately before asking the command to open the chooser. The constructed pair will test whether that call supplies the activation the chooser needs; the upload, streaming and coalescing assertions remain the check's own. Reconnect103 builds the one-line check change in `scripts/e2e/browser-smoke/checks/62-binary-transfer-streaming.mjs`; this item selects no product change.

## Acceptance

1. A constructed run with a six-second pause before the chooser command fails at the chooser wait; a run with the same pause and the in-page call passes that wait and the check. Retain both console and frame records.
2. The repaired check passes alone without the pause at its committed tip.
3. Retain a whole-suite result at the GA commit's tree, or record the second whole rc1 run's actual result as it stands. Keep the first rc1 red beside either result; a later green run does not erase it or substitute for the constructed pair.
