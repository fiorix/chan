# A download whose client stops reading ends after its 200 header with a classification nobody has read

Status: closed on 2026-10-21 by the reading; the section Read 2026-10-21 holds the record.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

A download answered 200 streams its body; a client that stops reading mid-body ends the stream with a body error after the header. Whether the server's trace layer logs that end at ERROR, as it logs a failed response, is not read (the runtime seat's note at the stall item's design, 2026-10-16).

## Desired contract

A client's own silence on a download it asked for is not a server error in the log; the line that records it says what the client did and what was sent.

## What to do

Read the classification at source and in a constructed run; if it is an ERROR line for a client's own silence, map it as the upload stall is mapped, below ERROR with the bytes sent.

## Acceptance

1. The reading, constructed: a download client that stops reading past the bound, the server log's line quoted.
2. A repair and its pin if the line is an ERROR for a client's silence.

## Read 2026-10-21

A constructed reading at `e547dcb2829e1929b7ea489c9481d1f7fa8d31ec` served `GET /api/fs/large.bin?download=1` through the workspace router over guest-loopback HTTP/1. The disposable file held 33,554,432 bytes, the isolated transfer lane had a 500 ms no-progress bound, and the client requested a 65,536-byte receive buffer. Each real client read the 200 header and 7,904 file bytes, then either stopped reading with its socket open or closed mid-body. A global tracing subscriber captured event levels, targets and fields before the first traced request. A constructed 503 response and a failing 200 response body supplied positive controls before the two real downloads.

The silent client's lane released from `(1,0)` to `(0,0)` at an observed 500 ms while the socket and response body remained open. At that point the body had yielded 3,145,728 bytes to the HTTP stack and no body error. Resuming reads exposed `transfer aborted before completion` and ended an incomplete response: the client received 3,604,480 bytes, while the body observer counted 3,670,016 bytes yielded. Yielded bytes are not delivered bytes. Closing the other socket released the body and lane at an observed 0 ms after close, rounded to whole milliseconds; its body had yielded 1,245,184 bytes and the observer received no body error because hyper dropped it. Watch notifications and body-drop notifications ended the waits; no sleep controlled their order. These times are contended observations under 2 CPUs and 6 GiB, not latency guarantees.

The following lines are verbatim from the capture's level/target/field formatter, not the CLI stderr formatter. In order they show the resumed stalled download's connection failure, the peer close, the response event shared by both real downloads, and the 503 positive control:

```text
TRACE axum::serve {"message": "failed to serve connection: error from user's Body stream"}
TRACE axum::serve {"message": "failed to serve connection: error writing a body to connection"}
DEBUG tower_http::trace::on_response {"latency": "0 ms", "message": "finished processing request", "status": "200"}
ERROR tower_http::trace::on_failure {"classification": "Status code: 503 Service Unavailable", "latency": "0 ms", "message": "response failed"}
```

Neither client end logs an ERROR. The 503 control does, proving that the capture sees the failure level. The constructed failing 200 body returned `constructed body failure` to its consumer without an ERROR event. The real download's DEBUG response event describes production of its 200 response, not completion of its body. No line at the bound names the client's silence or the bytes sent. The end is logged at TRACE with a generic message, after the client resumes polling in the silent arm; its connection line contains no route, status, stall bound or byte count. The request span's redacted URI is present in source, but the event capture does not reconstruct span nesting. The slot's release does not imply that a client which remains silent has received a completed response or that its HTTP connection has closed.

At source, both tenant routers use `TraceLayer::new_for_http()` with only their redacted request-span builder. In tower-http 0.6.10, `ServerErrorsAsFailures` returns a header-time `Ready` classification with `NeverClassifyEos`: a 5xx is a failure, a 200 is not. The trace response wrapper therefore holds no end-of-stream classifier, and a later body error never reaches `on_failure`. That callback's default ERROR level still applies to status and service failures it receives. Axum 0.8.9 records a failed connection result with `trace!`. `download_body` drains queued bytes before mapping `Cancelled`, `ClientCancelled` and `Stalled` to the one generic I/O error `transfer aborted before completion`. `Cancelled` includes shutdown and panic, so relabeling that entire outcome as client silence would be incorrect.

Evidence is under `dev/v0109-team/evidence/Runtime109/dlstal/`. `commands.md` records the exact invocations and their true statuses. The guest source inventory (`inventory.sh`), constructed reading (`read-1.sh`), evidence export (`export.sh`) and archive/source verification (`verify-export.py`) each exited 0, with their `.log` and `.status` records. Inside the reading, `cargo fmt --all` and `cargo test -p chan-server --lib dlstal_socket_reading -- --test-threads=2 --nocapture` each exited 0: one test passed its four arms, zero failed or ignored, and 2,370 unrelated tests were filtered. The status-reader's intentional `sh -c 'exit 7'` returned 7 and its detector passed. `exported/read-1/` holds the per-command logs and statuses, captured lines, exact temporary test patch and original/final revisions; `exported/dependencies/` holds the pinned classifier, trace and axum source. Both host cgroup reads exited 0 and recorded no OOM, with nonzero historical memory pressure and throttling.

The temporary test module and its declaration were saved and reversed with `git apply --check --reverse` and `git apply --reverse`, both exit 0. Export and verification confirmed clean host and guest checkouts at the original revision. The patch SHA-256 is `79aeacb12f8047b6ade86e945c6d388651d4828a42c3df64fbb775ae11d9973a`; the exported `reading.tar` SHA-256 is `1174a883708f5f5b5ee77ba6b7f29ccb03bb3938dc937c94096ad9385d86e395`. No product source changed and no full suite, browser, native, tunnel, HTTP/2 or other download-surface run is claimed.

Acceptance 1 is met by the constructed reading and quoted lines. Acceptance 2's condition is false: no ERROR line records the client's silence, so no classification repair is required. The desired cause/bytes sentence describes the conditional repair, not an additional requirement after this reading. A release-time accounting line is not built in this version; it needs a separate item if the owner wants it.

## Lead's rulings 2026-10-21

> acceptance 1 is met and acceptance 2's condition is false (no ERROR line records a client's silence), so the row closes on the reading

> the desired contract's second sentence (a line that says what the client did and what was sent) described the repair the row expected and is not owed without it

> a release-time accounting line is a new row for the owner to raise if the owner wants it
