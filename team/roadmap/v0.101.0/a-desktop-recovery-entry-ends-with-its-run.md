# A local desktop window's recovery entry can become unreachable after a restart

Status: raised for a decision on 2026-09-29 by the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 2, older than that range, with the lead's notes, which raise it with a code map first). Read at `e07f3862f`; that a webview keeps `localStorage` for an origin that includes its port is the platform's rule and not read in code; not run. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a window's unsaved input can become unreachable at the desktop's next start, with a code map first, as the lead's notes ask.

## What was seen

Lines at `e07f3862f`. The recovery buffer, where a window that goes now leaves each tab's unsaved input, is the page's `localStorage`, keyed by the workspace's root and the file's path (`writeEditorBuffer` and `bufferKey`, `web/packages/workspace-app/src/state/editorBuffer.ts:158-194`). The desktop's embedded server binds a loopback port that the system picks at each launch (`desktop/src-tauri/src/embedded.rs:157`), a local window loads its page from that address (`desktop/src-tauri/src/serve.rs:319-320`), and the desktop's own comment says that this per-launch origin keeps `localStorage` from surviving a restart (`embedded.rs:110-111`). When a later run binds a different port, its page has a different origin and cannot read the old entry, so the next open of the file offers nothing from it. The recovery reader does not transfer entries between origins; this does not establish that the old storage was erased or that every restart picks a different port. `web/packages/workspace-app/src/editor/design.md:88` and the changelog (`CHANGELOG.md:73`) say so.

The fix round's report says what a store that outlives the run would have to be reachable from (`dev/v0101-team/reports/report-Frontend-33.md`, "Ruling 7"): on the desktop, the host's IPC with a new command in its access list; in a browser, a route of the server; each asynchronous, where the write happens as a window goes.

## Desired contract

An entry that a local desktop window leaves as it goes is offered by the next open of the file in a later run of the desktop.

## What to do

A code map first, of the recovery buffer's writers and readers and of what the page can reach as it goes. Then a store that outlives the run, or a stable origin for local windows, with its cost stated.

## Boundaries

`web/packages/workspace-app/src/state/editorBuffer.ts` and its callers, and the desktop's embedded server or window build if the origin changes, with their tests.

## Acceptance

1. An entry written by a local window's close is offered at the next open of the file after the desktop restarts; pinned where a test can reach the store, and shown on a display.
