# Check 62 asks for a file chooser without a user gesture

Status: accepted for v0.103.0 by the lead's disposition of 2026-10-07 at the cut; the test-only repair is being built.

## Finding

At the rc1 pin `781ea1391`, the whole-suite leg of the 57-leg browser matrix, 52 checks, had one failed check: `62-binary-transfer-streaming`, ordinal 36. Its 256-file probe waited 15 seconds for a chooser at line 873 and failed with `Waiting for FileChooser failed: 15000ms exceeded`, 161 seconds into the check. The page console said `File chooser dialog can only be shown with a user activation`, 5.3 seconds after the check's last click at line 807. Between that click and the chooser command the check waited for queued uploads to finish and wrote 256 probe files of 256 KiB each, 64 MiB in all. The check had taken about 144 seconds to reach the chooser against about 99 seconds when run alone; the whole-suite leg ran near the guest's memory cap, which it met repeatedly, without an OOM kill. The same check passed alone thirteen minutes later and in the green whole run at `7fa1676c3`. In `chooser-rc1-01`, a constructed baseline with a six-second pause reproduced the chooser timeout and user-activation warning (verifier `matched`). The paused repair's in-page call passed the chooser without that warning, then the check failed at its thirty-second upload wait at line 905 (`coalescing probe upload did not finish`); the driver stopped before the committed unpaused repair ran.

The records are the `rawexp-781ea139-01` export (SHA-256 `0418b3fbc4349b69914be8a48a7356a190633c218f8702742abfcfdcccf9bf6a`), `dev/v0103-team/reports/diagnostics-Diagnostics103-check62-raw-context-781ea139.md`, and Review103's reading in `dev/v0103-team/tasks/task-Review103-Lead103-304.md`. Diagnostics' extracted log context is `dev/v0103-team/evidence/Diagnostics103/matrix-781ea139-redread-02/check62-run-log-context.txt`; the failure screenshot shows the Transfers panel and no chooser. Reconnect103's constructed run is recorded in `dev/v0103-team/tasks/task-Reconnect103-Lead103-90.md` and `dev/v0103-team/evidence/Reconnect103/check62-chooser-rc1/chooser-rc1-01.summary.txt`.

## Reading and constructed chooser result

Review103 read the delay from the last click to the chooser command and the console warning as a race inside the check that load exposed: the command can run after the page's user activation is gone. The constructed baseline reproduced the chooser refusal after a six-second pause, and the in-page call got the paused repair past that chooser; the later upload wait still needs its own cause read from the records. At rc1, the check file was the same blob as at the green candidate, and the rc1 changes did not touch its upload or command path, so Review does not assign this red to the rc1 product change. The 404, 413 and aborted-upload 500 lines and the memory-cap sample do not individually explain the refusal. A command-driven upload with no recent gesture also exposes a separate possible product question, outside this test-only repair.

## Repair

At the 256-file probe, the repair makes an in-page call immediately before asking the command to open the chooser. The constructed run showed that call got the paused check past the chooser; the upload, streaming and coalescing assertions remain the check's own. Reconnect103's one-line check change is in `scripts/e2e/browser-smoke/checks/62-binary-transfer-streaming.mjs`; this item selects no product change.

## Acceptance

1. Met for the chooser: the constructed six-second paused baseline failed at the chooser wait with the warning, and the paused repair passed the chooser without that warning. The paused repair did not pass the whole check; it failed at the thirty-second upload wait. Retain both console and frame records.
2. Open: the repaired check passes alone without the pause at its committed tip.
3. Open: read the cause of the paused repair's upload wait failure from its frame and log records before this item closes.
4. Retain a whole-suite result at the GA commit's tree, or record the second whole rc1 run's actual result as it stands. Keep the first rc1 red beside either result; a later green run does not erase it or substitute for the constructed pair.
