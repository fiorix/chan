# A reloaded window can come back focused on another pane than it saved

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): a reload brings a window back on the pane it had focused, since a focus move reaches the address at the end of its event, within a budget of 80 address writes in any 10.25 s that stays under WebKit's limit, and a move past the budget reaches it once the budget refills; the session save and the address's precedence at a reload are unchanged (`v0131/reloadfocus` at `86558efe9`, merged as `951d81bbd`). Read by workspace-app tests with 21 mutations, by check 262 in a guest's Chrome on both terminal backends, red at the base and green at the tip, and on chan-desktop under WebKitGTK in the desktop guest, where the base restored the older pane in all four immediate trials and the tip in none. A reload in the middle of a burst past the budget can still come back on an older pane; WKWebView on macOS was not observed, and the owner's batch reads it as check 8.

Record before the release: built and verified in Chrome and WebKitGTK on 2026-11-14; awaiting review.

Record: observed on 2026-11-13 while building browser check 226 of the [pane-focus keyboard](../done/moving-pane-focus-to-a-file-browser-leaves-the-keyboard-in-the-terminal.md) row, in a guest's Chrome against the guest's own server, on both terminal backends; the cause is not read.

## What is there now

A window keeps its layout in two places, both written from one effect in `App.svelte` that reads `layout.activePaneId` among the rest: the address's hash (`s=`, written by `persistStateToHash` in `state/store.svelte.ts` after a 150 ms debounce through `history.replaceState`, skipped when the address would not change) and the server's session for the window (`PUT /api/session`, after 750 ms). The serialized layout marks the focused pane's leaf with `f: 1`. A reload restores from the hash first; the session's reconcile keeps the local focus while its pane survives (`reconcileLayout` in `state/tabs.svelte.ts`). A window opened again by its id alone, with no hash, restores from the session.

Two readings, both with a terminal in the top pane and a file browser in the bottom one:

- A plain sequence (a press on the terminal, a reload, a press on the browser's status line, a reload): before each reload the hash and the session both named the pane pressed last, and the reload restored it, with the keyboard in that pane.
- After check 226's arms (left and right presses into the terminal, the terminal's menu, Next pane, Hybrid Nav's commits, presses on the browser pane's strip and tab, arrows in the browser), a press on the browser's status line left the session naming the browser's pane and the hash naming the terminal's. The reload restored the terminal's pane, and the keyboard followed it there. The same window opened again by its id restored the browser's pane.

So after something in that sequence the hash stops following the focused pane while the session does. Which arm, and why, is not read: the hash write may be skipped, refused (the store's comment names WebKit's limit on `replaceState` calls, and Chrome has one of its own), or overwritten by a later write of an older layout.

## Desired contract

1. A reload restores the pane the window had focused, as a window opened again by its id does.

## Boundaries

- The hash write and the reload's restore in the workspace app. The session save and the reconcile are the reference, not the subject.

## Acceptance

1. A reading first: the arm of check 226's sequence after which the hash stops naming the focused pane, and the mechanism, with a control that keeps the hash current.
2. Then a browser check, red on today's code, that runs that arm, presses on another pane, reloads, and reads the focused pane and where the keyboard is.

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, point 10) on 2026-11-14: "as you recommend". The reading's outcomes are ruled in advance:

- The write is skipped by the no-change test against a stale address, or overwritten by a later write of an older layout: fixed in `persistStateToHash` and its scheduler (`state/store.svelte.ts`), browser check red first.
- The browser refuses `replaceState` after a burst (the store's comment names WebKit's limit): a trailing write once the limit's window has passed.
- Pane ids renumbering at a restore is the cause (v0.130.0's record: pane-1 came back as pane-3): fixed in the restore, inside this row's boundary.
- Not reproduced in 20 runs of check 226's sequence on both backends at the base: the row closes withdrawn with the runs, keeping the sequence-then-reload assertion as a check shown red by a mutation that stales the hash.
- Any fix that needs the session to outrank the hash at a reload goes back to the owner.


## Reading, 2026-11-14

At `23ee2e97b3b5d1eb50ccc78a3a4cc90cf2bda660`, the complete rerun of check 226's sequence reproduced the focus mismatch in 20/20 trials on each terminal backend. Before reload, browser DOM focus and keyboard ownership agreed with the saved session, while the hash still named the terminal. All 40 outgoing documents recorded a successful hash write to browser focus during `beforeunload`; all 40 new documents arrived with the older terminal hash and restored terminal focus and keyboard. Both delayed controls kept browser focus. The first run completed 38 sequences with the same result; two ghostty trials failed during setup and are incomplete. No history write was refused in these readings. Evidence: `dev/v0131-team/evidence/Ops131/J32/`, with the event extraction in `dev/v0131-team/evidence/Edit131/readings/results-summary.json`.

The final browser chrome press changes focus inside the hash writer's 150 ms debounce. The trace supports a reload destination captured before the outgoing flush; it does not directly observe Chromium's navigation internals. Pane renumbering happens after the stale focus is already present in the arriving hash. The scheduler is not permanently stopped, and the session need not outrank the hash to fix this timing gap.

The user-reload diagnostic at `fa3960841de0d55c106656a7fc2e80ddafe0b5c8` completed 12/12 trials: eight immediate sequence trials, two per backend with `location.reload()` and two per backend with Puppeteer's reload, all restored the older terminal focus; four delayed controls preserved browser focus. This establishes the failure with a page-native reload as well as CDP. The diagnostic exited 1 at its focus-contract assertion, with no history errors or cleanup failures. Evidence: `dev/v0131-team/evidence/Ops131/J46/` and `dev/v0131-team/evidence/Edit131/reload-method/parent-summary.json`.

The scheduler ruling of 2026-11-14 gives focused-pane changes a write at the end of their event within a measured history budget; after exhaustion, the 150 ms trailing debounce waits for capacity to return. Other layout changes keep their debounce and the exit flush remains. The arriving hash stays authoritative for a reload. An immediate reload during an exhausted-budget burst is outside the focus guarantee; it can restore the last focus in the address.

Two isolated native history probes measured admission and recovery before choosing the budget. Each write changed the hash, read it back, and distinguished an exception from a silent refusal. The second cycle began with one already-admitted recovery write. Chrome ran with Puppeteer's default IPC-flood-protection bypass removed and its actual launch flags checked.

| Engine | First burst admitted | Second burst admitted | Refusal | Recovery after first refusal |
| --- | ---: | ---: | --- | --- |
| WebKitGTK 2.52.6 | 100 | 99 | `SecurityError` | First cycle: after 9,816 ms, by 10,068 ms; second: after 9,828 ms, by 10,080 ms |
| Chrome 156.0.8078.80 | 200 | 199 | Returned without changing the hash | First cycle: after 9,757.9 ms, by 10,008.2 ms; second: after 9,756.8 ms, by 10,007.0 ms |

WebKitGTK's stricter result sets the budget: 80 ordinary changed-URL writes in a rolling 10,250 ms window, with two more slots reserved for page exit. This leaves headroom below the observed 100-call limit and waits beyond both measured recovery bounds. Equal URLs consume no slot. The completed probes exited 0; the first Chrome wrapper exited 1 before observing anything because it omitted `await` on Puppeteer's asynchronous `defaultArgs`, and its corrected wrapper passed the installed-API check before the native probe. Evidence: `dev/v0131-team/evidence/Ops131/J53/`, `dev/v0131-team/evidence/Ops131/J55/`, and the scripts, oracle mutation logs and compact readings under `dev/v0131-team/evidence/Edit131/history-budget/`.


## Built, 2026-11-14

A focused-pane effect now schedules a microtask hash write. Ordinary layout changes keep the 150 ms trailing debounce. The store accounts for every successful changed-URL layout write against the shared rolling budget, with two slots used only by the App's exit handler; explicit visibility writes use ordinary capacity. A blocked write queues the latest live state for the later of the quiet interval and the next available slot. A native exception or silent refusal waits another window before retrying. No-op writes are free, explicit flushes cancel queued focus work, and CLI reload metadata changes only alongside an accepted hash. The manual and workspace app design describe the rule and the exceptional burst interval. The session save and restore precedence are unchanged.

Red-first tests failed five assertions at the base, including a mounted App whose focused pane and URL disagreed before any timer. The final focused run passes 18 tests in two files; an earlier related run passes 84 tests in six files. Across 101 synchronous focus mutations the writer makes one write; across 101 events 10 ms apart it admits 80, then writes the latest state after refill; across 101 events 160 ms apart all 101 reach the hash at their event boundaries. Hybrid Nav previews write nothing, and its commit writes once. The tests also cover shared accounting, rolling expiry after the exit reserve, the quiet interval near refill, both native refusal forms with and without later input, metadata pairing, cancellation, no-op capacity and the mounted App's unload/pagehide handlers. Evidence: `dev/v0131-team/evidence/Edit131/reloadfocus/`, with the final 18-test result in `mutations/restored.log` and the related run in `hash-focus-green-2.log`.

All 21 isolated guard mutations failed on assertions and restored the original source hashes: focus effect and timing, budget admission and accounting, window and quiet interval, reserve admission and rolling expiry, cancellation, native refusal detection/cooldown/retry, queued refill, metadata pairing, unexpected errors, the mounted exit handler and no-op dedup. Parent review read every failing assertion and independently verified both restored production hashes. Evidence: `dev/v0131-team/evidence/Edit131/reloadfocus/mutations/`, including `results.tsv`, per-mutation logs and restoration records. Final workspace typecheck reports zero errors and zero warnings; diff, shell and workflow checks exit 0 before commit. J61 gates committed `3f2ce98709697d390980b4b261ad1f66c12870c3`: `make web-check`, `make web-marketing-check`, `make shell-check`, `make workflow-check`, `git diff --check` and both JavaScript instrument syntax checks all exit 0, with a clean tree before and after. Each command's log and status is under `dev/v0131-team/evidence/Ops131/J61/`.

Permanent browser check 262 at the base exits 1 at its reload-focus contract assertion: both terminal backends restore the older terminal hash and keyboard after a browser focus click followed by `location.reload()`. All four trials are observed; both delayed controls preserve browser focus, with no sequence, cleanup or page errors. The immediate intervals are 12.9 ms on xterm and 15.0 ms on ghostty. The check retains the full keyboard/PTY sequence, verifies a new document before readback and records outgoing, incoming and restored semantic focus. Parent review read the JSON and all four screenshots. Evidence: `dev/v0131-team/evidence/Ops131/J60/` and `dev/v0131-team/evidence/Edit131/browser-reload/base-summary.json`. The earlier J58 run is retained as incomplete: a same-document hash change satisfied its control's navigation wait, so the reader was corrected before the valid base run. J62 runs the identical instrument at the committed tip and exits 0: all four trials retain browser hash, focus and keyboard, including both delayed controls, with no sequence, cleanup or page errors.

The native WebKitGTK 2.52.6 reading uses the same frozen harness at base and tip. J57 exits 2 because xclip is unavailable; it is not a product failure. After that prerequisite is installed, J101 reruns the unchanged base products: both delayed controls hold, and all four immediate right/left trials across xterm and ghostty restore the stale terminal hash, focus and keyboard (exit 1). J63 builds the committed tip and all six trials hold (exit 0). Tip immediate trusted-click-to-reload intervals are 1 and 0 ms on xterm, 1 and 7 ms on ghostty; delayed controls are 401 and 400 ms. The outgoing hash and the restored focus name the browser (this harness reads no incoming hash; check 262 does), native hash writes succeed, and setup and cleanup complete. Raw JSON, six screenshots, source/binary/bundle hashes and actual build/driver statuses are under `dev/v0131-team/evidence/Ops131/J101/` and `dev/v0131-team/evidence/Ops131/J63/run/`.

The final evidence descendant changes only this row, under the lead's documentation-only gate ruling. The native guest and browser proofs establish the measured reload path on both terminal backends; they do not establish macOS WKWebView behavior or extend the focus guarantee into an exhausted write budget. The explicit burst limitation and hash/session precedence remain as documented above.
