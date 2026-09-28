# The desktop's probe takes a gateway's 404 as ready, so a window can load the gateway's not-found page during a tunnel's gap

Status: raised for a decision on 2026-09-28 by the lead, from a reading of the gateway's answers made while the roadmap commit of the landing before was drafted (`dev/v0101-team/for-host-2026-09-27.md` in the development tree, the entry of 07:52Z); the builder of the desktop's fifth fix round read the same at its tip for an open window's retarget (`dev/v0101-team/reports/report-Services-29.md`, "Gateway 404 reading requested at dispatch"). Read again at `7957bccef` and not run; what an engine shows is inferred. Recommendation: accept for v0.101.0.

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
