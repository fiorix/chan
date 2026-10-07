# No client reads the code that a stopping devserver answers

Status: withdrawn, and it did not ship: the real-stop measurement is partial (connection errors and a failed connecting-page attempt after a process exit, no coded `devserver_stopping` 503 observed by a client) and no client change was approved; closed at [v0.103.0](../../release/release-v0.103.0.md) by the owner's ruling of 2026-10-07 that no row that can close is carried, which that report records.

Record before the release: real-stop measurement is partial. Workspace and launcher requests after process exit showed connection errors; a selected native connecting page displayed a failed stopped-server attempt. No coded shutdown response or selected-page recovery was observed. No client change is approved.

## Owner decision, 2026-10-06

Measure a disposable devserver's actual stop with the browser connecting-page wait, desktop probe and workspace API callers. Distinguish coded devserver_stopping 503 responses from connection failures and record what each client shows. Use the observations to propose client behavior; do not infer a rule for every 503 from this code.

## Browser measurement, 2026-10-06

At `b8d2dd7d51b1b5d4896fd02f94f14d1b4c5b03dd`, one headless Chromium 154 workspace observation recorded healthy responses from the app's workspace bootstrap and File Browser directory request, then sent SIGTERM to its disposable devserver. The process exited before the subsequent directory click. The app's one request for that directory failed with `net::ERR_CONNECTION_REFUSED`, and the expanded row displayed `Failed to fetch`. Its denominator is one target request, one transport failure and zero HTTP responses. Four library window-feed reconnect attempts also failed at the transport layer; those are separate requests, not tenant responses.

This establishes a visible workspace error after an actual process exit. It observed no coded `devserver_stopping` 503, no library error-only 503 and no request inside the stopping gate's lifetime. It gives neither a response rate nor evidence of how the client handles the shutdown code. The run used a two-CPU, four-GiB guest with resource records; it reached the memory cap without OOM and was not a quiet latency comparison. Independent review accepted the source, binary and fixture identities, healthy controls, event order, result and cleanup. This is Chromium evidence, separate from native WebKitGTK observations and the earlier synthetic wire sample.

The separately attempted launcher observation failed its instrument's healthy page-check precondition before the measured Open action or stop. A terminal record was created and its popup rendered, but the expected app-owned page-check request was absent from the recorded stream. Cleanup succeeded; the missing request's cause remains unresolved. That attempt supplies no connecting-page or launcher stop verdict, and a later pass would not erase it. The browser connecting-page measurement remains open; the native probe is recorded separately below, and no client repair is selected by this partial result.

A later Chromium launcher arm at the same `b8d2dd7d51b1b5d4896fd02f94f14d1b4c5b03dd` proved a real browser-origin host terminal row, an actionable Open control, its click and a planned SIGTERM of the disposable devserver 33 ms after the click; the child exited six milliseconds after the signal. The sole classified tenant page GET began about 22 ms before SIGTERM, received HTTP 200 headers, then ended with `net::ERR_ABORTED` 17 ms before SIGTERM. Neither its headers nor its abort are post-stop evidence. Seven later library-feed WebSocket closures are separate from that tenant GET. The popup remained open for the 62-second observation with no classified document response or connecting state (`open-unclassified`); no post-stop tenant request, coded `devserver_stopping` 503 or client recovery was observed. Independent review accepted the click-then-stop instrumentation and event order while leaving client shutdown behavior unclassified. This recorded-load result is separate from the workspace post-exit observation and the earlier launcher instrument failures: the original missing healthy request, the later arm that never clicked, and the changing-target failure. A deliberate missing-target control validated only the instrument's refusal path. No response rate, universal 503 rule or client repair follows from this partial measurement.

A distinct launcher arm at that same source delivered SIGTERM one millisecond before the real Open click. The child exit callback arrived five milliseconds after the signal; the app-owned Fetch for the exact selected terminal page began 8.351 ms after that callback and failed with `net::ERR_CONNECTION_REFUSED`, without HTTP headers or a body code. The launcher visibly showed `Failed to fetch`. The popup opened and closed, but its only saved state was unreadable; neither its document state nor a connecting-page transition was classified. Independent review accepted the real row, holder and action controls, frozen product and fixture identities, event order and cleanup. This is one post-exit request and one transport failure under recorded load, with zero HTTP responses. It establishes the visible launcher error, not handling of an in-gate 503, recovery, or the cause of the popup's transition. The earlier arms and their limitations remain separate evidence; no further client behavior or response rate is inferred.

## Native connecting-page measurement, 2026-10-06

In one Linux WebKitGTK desktop observation at `a64c6184739aa9b7c4c85f00124ef56292277b02`, using the separately pinned `b79fda81d` observation fixture, the disposable devserver exited after SIGKILL before the selected persisted window was deliberately hidden and reopened. The old X window disappeared after Hide; Open of that same record produced a new X window. A native Tauri connecting page matched to the selected window, library and origin showed attempt 1 and the visible row `attempt 1: could not connect` before restart began. The page-to-X association is indirect; deliberate Hide/Open explains this X replacement and does not show spontaneous window loss. Independent artifact readings accept this bounded stopped-server page observation.

The run ended inconclusive for recovery: after the devserver listened and the workspace mounted, the reader did not observe a matched SPA on the selected inspector socket within 60 seconds. A companion Tauri SPA on a different socket is weaker evidence and does not satisfy that selected-page predicate. The retained page row supports a source-backed connecting-page probe-branch reading, not a captured `probe_url` IPC return or request/body trace. No coded `devserver_stopping` 503, raw response body, same-run slow-restore-to-X join or selected-page recovery was observed. This partial measurement supplies no response rate, client behavior rule or repair decision.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: carried into v0.103.0 at the v0.102.0 GA on 2026-10-05 with its measurement not taken; nothing of it was built.

Record before the release: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. It is the cost written under What shipped in [a-stopping-devserver-says-it-is-restoring](a-stopping-devserver-says-it-is-restoring.md), which no item held. The builder's report names it as a residual (`dev/v0101-team/reports/report-Services-40.md` in the development tree, "The clients of the 503 and the launcher routes, at the tip" and "Residuals"), and a reading of the ledger on 2026-09-29 searched `web`, `desktop`, `crates/chan` and `crates/chan-shell` at `4c4ada0a1` and found no reader (`dev/v0101-team/machine-move/lead38-recon-5-runtime-launcher-drawing.md`, T5, part c). Read, not run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: the measurement is accepted, of how often a real stop reaches a client as the 503, taken by the team. A build is ruled after it.

## What was seen

From the stop signal on, a devserver's gate answers a tenant's request with 503, the sentence `the devserver is stopping`, the code `devserver_stopping` and no `Retry-After`, where a devserver that starts answers 503 with `Retry-After: 1`; the shape is the lead's ruling, which the owner confirmed as built on 2026-09-29, so that a client can wait out a start and give up on a stop without reading words. The build is on the integration branch and not on `main`.

No client branches on the code. By the builder's report, whose lines are at its lane's tip:

- **The shared wait of a browser window for its page** retries the stop's answer every second for sixty seconds, since it retries every 503 and reads a missing header as one second (`web/packages/web-shared/src/window-page.ts:81-95`). The report notes that it "could give up on `devserver_stopping` through the refusal it already holds".
- **The desktop's probe** reads the status alone.
- **The workspace app's callers of `isTransientApiError`** still take the stop as transient.

So a desktop window on its connecting page and a browser window in the shared wait tell a stop from a start by nothing.

Not established: how often the code reaches a client at all. A refusal reaches a client only when its request is dispatched after the coordinator has entered its stopping phase and before its connection shuts down, so by a reading of the framework's source most clients of a stopping devserver meet a closed or refused connection and not the 503; that was never measured, and on 2026-09-29 the owner ruled who measures it (in the item above). What each client should show at a stop is in no record.

## Desired contract

A client that receives a stopping devserver's refusal tells it from a starting devserver's by its code, and does not wait it out as it waits out a start.

## What to do

Decide, after the measurement of what a real stop answers, since it says how many clients the code reaches. The records name no shape beyond the report's note on the shared wait.

## Boundaries

By the report's citations: `web/packages/web-shared/src/window-page.ts`, the desktop's probe, and the workspace app's callers of `isTransientApiError`, with their tests. What the devserver answers is [a-stopping-devserver-says-it-is-restoring](a-stopping-devserver-says-it-is-restoring.md)'s, and the refusal's envelope is [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md)'s.

## Acceptance

1. The owner's decision is recorded, with the measurement it rests on.
2. If it is built: each client that reads a devserver's 503 has a pin of what it does with the code `devserver_stopping`, red first.
