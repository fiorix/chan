# The desktop's probe takes a gateway's 404 as ready, so a window can load the gateway's not-found page during a tunnel's gap

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the lead, from a reading of the gateway's answers made while the roadmap commit of the landing before was drafted (`dev/v0101-team/for-host-2026-09-27.md` in the development tree, the entry of 07:52Z); the builder of the desktop's fifth fix round read the same at its tip for an open window's retarget (`dev/v0101-team/reports/report-Services-29.md`, "Gateway 404 reading requested at dispatch"). Read again at `7957bccef` and not run; what an engine shows is inferred. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: its fix reverses a rule that a landed item chose on purpose, that a gateway's 401, 403 and 404 prove that the gate answered ([desktop-window-outage-lifecycle](../done/desktop-window-outage-lifecycle.md)). The shape is not ruled: a bound on the desktop's side, under which a gateway's 404 is not ready for a bounded number of attempts and the window navigates as today after them, or a not-found answer that the gateway marks as its own for a tunnel that is gone, which changes the gateway's contract. When it was raised the lead recommended accepting it for v0.101.0. It is not part of v0.101.0.

On 2026-10-03 the owner ruled, as the lead recommended: the desktop-side bound. A gateway 404 is not ready for a bounded number of attempts, after the code map this item asks for first. The gateway's contract does not change.

## What was seen

**The probe.** The desktop probes a window's target with one function, for the connecting page and for the retarget of an open window (`probe_url`, `desktop/src-tauri/src/main.rs:3634-3680`; the retarget's call, `desktop/src-tauri/src/serve.rs:471-472`). It counts an answer as ready unless it is a 503, or a 502 or a 504 from a gateway target (`probe_response_reachable`, `main.rs:3623-3632`), so a 404 from a gateway is ready. That is the rule the desktop's outage item chose, which reads a gateway's 404 as the gate having answered ([desktop-window-outage-lifecycle](../done/desktop-window-outage-lifecycle.md), "The connecting probe discriminates").

**What a gateway answers in a tunnel's gap.** A request for a devserver the gateway holds no live tunnel for is answered by `not_found_response` (`gateway/crates/devserver-proxy/src/proxy.rs:306-311`; the registry keeps no entry for a tunnel that disconnected, `gateway/crates/devserver-proxy/src/registry.rs:44-55`): a 404 that is an HTML page titled "workspace not found" to a request that accepts HTML, and JSON otherwise (`proxy.rs:2057-2082`, the title at `:2091`). A 502 or a 504 comes only from a tunnel it still holds (`proxy_http`, from `:1344`, its 502s through `Error::Upstream` at `:1366`, `:1381` and `:1432`, its 504s at `:1368`, `:1383` and `:1436`; `gateway/crates/devserver-proxy/src/error.rs:27-30`).

**So during a tunnel's gap,** while the devserver behind a gateway restarts or its machine reboots:

- A window on its connecting page probes, reads the 404 as ready and navigates to its tenant's page (`desktop/src/connecting.js:169`), and that page load gets the gateway's HTML not-found page (inferred).
- An open window's retarget probes once, reads the 404 as ready and navigates in place (`retarget_window`, `serve.rs:427-443`). A navigation whose ticket is still current settles as applied, with the attempt's key recorded as loaded and no retry deadline (`finish_retarget`, `desktop/src-tauri/src/window_watcher_wiring.rs:547-557`; `RemoteLaunch::retry_deadline`, `:198-206`), so nothing tries again until the window's key changes or the user presses Reload. That the navigation's own request meets the gap and lands on the not-found page is inferred.

The gateway's page has no SPA and no close handler, and nothing retargets a window left on it: the "blind probe" failure the outage item removed for 502, 503 and 504 (`done/desktop-window-outage-lifecycle.md`, "Verified current state").

## Desired contract

A desktop window whose gateway target is in a tunnel's gap waits on its connecting page, or keeps the page it has, until the devserver answers, and is never navigated to the gateway's not-found page because a probe read that page as ready.

## What to do

A code map first: which answers a gateway gives the desktop's probe, which carries the window's cookies (a tunnel that is gone, a session that is stale, a tenant that is missing), and whether the wire tells them apart. Then, as suggestions: the gateway marks its own not-found answer so that the probe can read it, or the probe asks something that tells a gone tunnel from a tenant's own 404; or the desktop takes a gateway's 404 as not ready for a bounded number of attempts. Red first: the classifier and a retarget, each given the gateway's own answer for a gone tunnel, taking it as not ready.

## Boundaries

`desktop/src-tauri/src/main.rs` (`probe_url`, `probe_response_reachable`), the retarget's reading of the probe in `desktop/src-tauri/src/serve.rs` and `window_watcher_wiring.rs`, and the gateway's `not_found_response` if its answer is marked there, with their tests. The outage item's other contracts do not change.

## Acceptance

1. A gateway target in a tunnel's gap is not ready to the connecting page's probe or to a retarget's, pinned red first with the gateway's own answer.
2. A gateway target that answers its tenant's page is still ready, and a loopback target is classified as now.
3. A reading on a display: a devserver behind a gateway restarted with windows open, and each window on its page again once the tunnel is back.

## Code map of 2026-10-03

Read in the code on the v0.102.0 integration branch by a builder and not run: no gateway, desktop or tunnel was driven.

The gateway answers the probe the same way for a tunnel that is gone and for a session that is absent, expired, revoked or another devserver's: its own 404 through `not_found_response` (`gateway/crates/devserver-proxy/src/proxy.rs:293-311`, `:407-421`, `:2057-2091`), as JSON or as an HTML page by the request's `Accept`, with no mark of the cause, since the gate hides on purpose whether a devserver exists (`proxy.rs:51-55`). A tenant that is not mounted is forwarded to the host, whose root fallback answers with the launcher, normally a 200, so it reads as ready. A mounted tenant's own 404 is forwarded with no mark either. A tunnel the gateway still holds and cannot use answers 502 or 504. So the wire does not tell a gone tunnel from a stale session, and a 404 carries no reliable provenance.

Of this item's three suggestions, a mark on the gateway's own 404 would mark both of those causes and weaken what the gate hides, and no endpoint on the public path tells them apart; each changes the gateway's contract, which the owner ruled out. The bound on the desktop's side is the one to build.

The lead ruled its shape the same day, inside the owner's ruling and the owner's to overturn. The count lives in the desktop's Rust beside the classifier, keyed by window and target, so the connecting page and an open window's retarget share one rule and `desktop/src/connecting.js` is not touched. A gateway's 404 is not ready for the first 15 probes of a window's target and is taken as it is today after them; any other answer resets the count. At the pace the map read for each caller, that is about 30 seconds on the connecting page, inside its 20 attempts, and a few minutes for an open window, which keeps its page meanwhile; the build confirms both. So the desired contract's "never" holds during the bound and not past it: a gap that outlasts the bound still navigates, which is the fallback the owner ruled.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff, which found nothing above low. This record was written that day from those.

The desktop keeps a saturating count of consecutive gateway 404s per window label and target URL, beside its probe's classifier (`AppState`, `probe_result_for`, `desktop/src-tauri/src/main.rs`). A gateway target's 404 reads as not ready for the first fifteen probes of that key and as reachable from the sixteenth, until any other outcome for the key resets the count; a transport failure resets it too; a loopback 404 is never counted. Both callers go through the same seam: the connecting page, which probes every two seconds and twenty times at most, so the sixteenth answer falls about thirty seconds in; and an open window's retarget, one probe per dispatch fifteen seconds apart, so about four minutes. A destroyed window's entries are removed; the key holds a URL that can carry a token and is never logged. The retarget's driver still holds no loop and no budget of its own. The classifier's and the retarget's pins hold the first and the sixteenth probe, two windows and two targets apart, the reset, the cleanup, and the guards for 200, 502, 503, 504, a transport failure and loopback. `desktop/design.md` says so.

Left: acceptance 3, a reading on the owner's display. Read by the review and not run: a probe in flight when its window is destroyed can put one count back, so a reopened window of the same label starts one probe short of the bound; nothing caps the map but a destroy and a reset, so a page that probes many distinct gateway URLs grows it for the window's life.

On 2026-10-04 the lead moved the row to cut: every pin of the build above is on the v0.102.0 integration branch, and what is left, acceptance 3's reading on a display, is the owner's, listed for the owner's next decision file. This row is complete short of that reading.
