# browser-smoke

Headless-Chrome smokes that drive a real chan test server end to end: build the SPA + binary, seed a throwaway workspace, launch `chan serve`, run every check under `checks/`, and write structured results.

## Run

```
make browser-smoke-deps                  # once per container
node scripts/e2e/browser-smoke/run.mjs
```

The harness's own npm dependencies self-install on first run (`npm install` in this directory), but Chrome is not among them: `puppeteer-core` drives a browser, it does not ship one. `make browser-smoke-deps` runs [`provision.sh`](provision.sh), which installs the shared libraries Chrome links against and downloads Chrome into the cache location the runner reads. The project's build containers carry the Rust and Node toolchains and no browser at all, so a container is unrunnable until that target has run in it; the host keeps no toolchain by policy and is not where this suite runs. `provision.sh` is the single list of those dependencies, so an sdme rootfs that prefers them baked in `COPY`s and `RUN`s it rather than restating the set.

The full run builds `web/` and `cargo build -p chan` first; set `SMOKE_SKIP_BUILD=1` when the binary and bundle are already current.

## Environment

- `SMOKE_OUT_DIR`: output directory for `results.json` + screenshots (default: a fresh `/tmp/chan-browser-smoke-*`).
- `CHAN_BIN`: chan binary (default `<repo>/target/debug/chan`).
- `CHAN_ECHO_EXTENSION_BIN`: echo extension fixture (default `<repo>/target/debug/examples/echo-extension`).
- `CHROME_BIN`: Chrome executable (default: newest `~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome`).
- `SMOKE_SKIP_BUILD=1`: skip the web + cargo builds; when the extension check is selected, both `CHAN_BIN` and `CHAN_ECHO_EXTENSION_BIN` must already be current.
- `SMOKE_ONLY=50,101`: run only the checks whose filenames start with one of the comma-separated prefixes (lexical filename-prefix match).
- `TMPDIR`: the throwaway workspace is created under the OS tmpdir; a stray `.git` in `/tmp` makes chan's vcs-parent check refuse it, so point `TMPDIR` at a clean directory when that happens.

## Exit status

`0` every selected check ran and passed, `1` at least one check failed, `2` the environment cannot exercise the suite at all, following the same convention as `webview-flip-render.py` and `terminal-pixels.py`. A skip is not a pass, so the two nonzero codes are kept apart: `1` is a defect to chase and `2` is an environment to fix.

`provision.sh` uses the same three codes, and **`make` erases the distinction**: GNU make exits `2` for any recipe failure, so `make browser-smoke-deps` returning 2 means only "it failed": the provisioner's own `1` (it tried and could not) and `2` (this environment is not provisionable) both arrive as make's 2. Run `scripts/e2e/browser-smoke/provision.sh` directly whenever a caller needs to tell those apart; the make target is a convenience, not the interface.

The run exits `2`, before it builds or starts anything, when no Chrome is found, when the Chrome it found will not start (the stock container state: the browser links against `libnss3` and `libasound2` and the rootfs carries neither, so the dynamic linker kills it at exec), when `CHAN_BIN` names no binary, or when `SMOKE_ONLY` selects no check. That last one is the same defect in miniature: a filter matching nothing used to build the tree, run zero checks, and report `ALL GREEN`.

A check that calls `ctx.skip` did not run and so cannot have passed, but its precondition is absent rather than broken, so it does not fail the run. It is named on the verdict line and counted in `results.json` as `skipped`, never left to be inferred from the absence of a line.

## Checks

Files under `checks/` run in sorted filename order. The sort is LEXICAL, not numeric: `100-*` and `110-*` run right after `10-*`, while numbered tail slots `94` through `99` run after `90-*`. The destructive `98-workspace-root-loss` check is the sole ordering exception and the runner pins it last so no later check inherits a missing workspace. Pick a prefix with the lexical order and raw `SMOKE_ONLY` prefix matching in mind. Each default-exports `{ name, run(ctx) }`; `run` throws (or returns) and may record intermediate evidence:

- `ctx.page`: a puppeteer page already on the workspace window.
- `ctx.serverUrl`, `ctx.workspaceDir`, `ctx.outDir`, `ctx.downloadDir`
- `ctx.chanBin`, `ctx.serverPid`, `ctx.controlSocket`
- `ctx.shot(name, page = ctx.page)`: screenshot into the out dir (auto-recorded). A check driving its own page passes it explicitly.
- `ctx.pollFile(path, timeoutMs)`: wait for a file to exist + settle.
- `ctx.waitWindowLive(windowId, timeoutMs)`: wait until the SERVER can address that window. Mandatory between opening a window and driving it with `cs` / `chan shell`, and not the same thing as `.pane` appearing: `.pane` is the client rendering its own state, while a `--window` command reaches the window through the server's session registry, which it joins when its session socket registers. Skip this and the check races a `window "..." is not connected` refusal.
- `ctx.skip(reason)`: mark the check skipped (e.g. a peer surface not merged yet).
- `ctx.assertPdf(bytes, { pages, orientation, minInkRatio })`: pdf-lib byte assertions (page count, A4 dims, per-page nonzero raster ink).
- `ctx.assertNoDuplicateBands(bytes)`: fails when the head band of a page also appears on the previous page (pagination duplication). Only meaningful for documents whose content does not repeat itself.
- `ctx.latencyProxy(latencyMs)`: a TCP delay proxy in front of the server (WebSockets included; CDP network emulation cannot delay them). Returns `{ url, setLatency, close }`; the check drives its own page against `url` and must `close()` the handle.

A check asserts a property, not a rate. A wall-clock threshold with no slack fails on a loaded host. A check whose external precondition is absent calls `ctx.skip`, it does not fail.

That rule reaches page loads too, and `waitUntil: "networkidle2"` breaks it. This application holds live WebSockets for terminals, documents and presence, so its network never goes quiet on purpose; the wait then measures how loaded the host is, times out at 60s, and reports it as a navigation failure with every content assertion still correct. Open a window with `waitUntil: "domcontentloaded"` and then wait for the property the check actually depends on.

**The property, not a property.** Nearly every check here already waited for `.pane` on the line after the rate wait, which makes the rate wait look redundant. It was not, for any check that then drives the window from outside the page: those depend on a second, unnamed property, the server being able to address the window, that `networkidle2` had been supplying by accident, because a quiet network implies the session socket finished registering. Removing the rate wait without naming that property turns a reliable check into one that intermittently loses a `--window` command to `window "..." is not connected`. Use `ctx.waitWindowLive` there, and when auditing a wait, ask what the next twenty lines actually consume rather than whether some assertion follows.

A load whose readiness is not a single selector states its own barrier, as `98-workspace-root-loss` does by polling `/api/index/status` for a doc count, and `107-terminal-rename-inventory` does by holding two co-viewing pages until they render the same pane ids. Reach for `networkidle2` only against a page that has no live transports at all, and say in place what bounds it.

A check passes alone and in any suite position, so verify a new check both ways before trusting it. Two shared browser resources leak across checks and are the usual cause of a check that is green alone and red in a suite: Chrome caps the resource timing buffer at 250 entries, so a check reading `performance.getEntriesByName` clears the buffer first or its entry is silently dropped; and a pane side flip animates for 520ms with the pane header rotated out of the viewport, so a click during it fails as not clickable. Note also that `SMOKE_ONLY` matches filename PREFIXES, so `10` selects `100` through `104` as well as `10`.

`results.json` is written after `teardownServer`, so a teardown that throws takes the results file, the `ALL GREEN` / `N FAILURE(S)` line, and the exit code with it. The run's screenshots still land in the output directory, but its verdict does not, and a full run is exactly where that hurts because `98-workspace-root-loss` deletes the workspace root the teardown then reads. Treat an output directory holding screenshots and no `results.json` as a lost verdict, not as a pass, and read the console transcript for the per-check lines.

Add a new check by dropping a numbered file into `checks/`; nothing else needs editing.

## Terminal socket and PTY tools

`lib/terminal-cut-proxy.mjs` and `lib/terminal-fixture.mjs` support owner-run replay checks without a browser. Install with `npm ci --prefix scripts/e2e/browser-smoke`, then run `node --test scripts/e2e/browser-smoke/lib/terminal-cut-proxy.test.mjs` from the repository root. These tests establish tool behavior; they do not mount the terminal page or prove what a renderer paints. Both modules are named ESM exports. The proxy requires `ws`; the fixture process uses Node built-ins only.

### Proxy lifetime and calls

`await startTerminalCutProxy({ targetUrl, path, session, ordinal = 1, deadlineMs = 5000, maxQueueBytes = 8388608, maxQueueMessages = 4096, maxTraceBytes = 67108864 })` starts an ephemeral loopback listener and returns `{ url, records, arm, acknowledge, waitForCut, waitForRecord, close }`. `targetUrl` must be a bare `http://127.0.0.1:PORT` origin without user information, query or fragment. `path` starts with `/` and contains no `?`; `session` is a nonempty string. The ordinal and all limits are positive safe integers. `url` is the listening HTTP origin; replace its scheme with `ws:` for WebSockets. Selection matches the exact pathname and `session` query value. Only matching upgrades increment the connection ordinal. HTTP and other sockets pass through without trace records. Credentials travel upstream in memory; do not log caller URLs or headers.

`arm({ boundary, bytes, frames, ordinal, sessionOrdinal = 1 })` returns undefined and arms one cut. On the first arm, omitted `ordinal` uses the start option. On subsequent arms it selects the next matching connection after all connections already seen. An explicit ordinal can select a future connection or a live connection whose selected session has not yet been dequeued. Session ordinals are positive, one-based counts of `session` messages on that socket, including messages before any arm. For example, `{ boundary: "after-session", ordinal: 1, sessionOrdinal: 2 }` selects a restart's session on the first socket. Only one arm may be pending; another is permitted after its receipt completes. Each successful arm gets a one-based `arm` identifier. A recovery connection stays unarmed unless explicitly selected by a later call.

- `before-session`: Holds the selected session. With no preceding delivery, cuts immediately. Otherwise waits for acknowledgement of the last preceding delivery, including any reset bytes.
- `after-session`: Delivers the selected session, holds subsequent messages, and waits for its acknowledgement.
- `inside-replay`: Delivers exactly `bytes` binary replay bytes, where `0 < bytes < session.replay_bytes`, then waits for the last fragment's acknowledgement. Splits a source message if necessary and holds its suffix in byte order.
- `after-replay-frame`: Delivers the advertised replay, then counts whole messages before ready, regardless of their payload or type. `frames` is a positive safe integer. The selected counted message is delivered and acknowledged before cutting; its successors stay withheld. Session and messages carrying replay bytes are excluded from the count. With zero replay, counting starts immediately after session. Ready is never counted or forwarded; reaching it before the requested count refuses the cut. This arm does not split a source message at the replay's end.
- `before-ready`: Delivers every message before the selected session's ready, including all replay, alternate-screen and mode bytes. Holds ready and waits for the last preceding delivery's acknowledgement. Works when `replay_bytes` is zero.
- `after-ready`: Delivers ready, holds subsequent messages, and waits for ready's acknowledgement.

The proxy forwards upstream payloads and types; it never fabricates a control frame. An inside-replay offset equal to the replay length is invalid; use `before-ready` for a complete replay. That boundary also includes mode bytes between replay and ready.

`acknowledge({ connection, frame, drained = false })` returns undefined. `connection` is the matching connection ordinal and `frame` is its one-based forwarded message number, including split fragments. Acknowledgements must increase and cannot exceed the forwarded count. Call only after the client's message handler returns; set `drained` only after the parser's write callbacks finish. The proxy records `Boolean(drained)` as the controller's assertion; it cannot establish parser completion itself. An acknowledgement equal to the awaited boundary frame starts the cut. Unarmed forwarding needs no acknowledgement until a later `before-session` arm requires the last preceding delivery to be acknowledged, even if that delivery preceded the arm.

`await waitForCut()` returns the current arm's receipt after both selected sockets close. Each call captures the current arm's promise; retain it if another arm will follow. Before the first arm it rejects `NOT_ARMED`. After a failure, a new call rejects that failure even when an earlier receipt exists. An already resolved promise cannot report a later failure; inspect records or make a new call before accepting a run.

`await waitForRecord(predicate, timeoutMs = deadlineMs)` returns the first existing matching record, or waits for a new matching record. Use a nonthrowing predicate and a positive timeout. Existing records remain searchable after failure or closure. Without an existing match, a failure rejects the wait, closure rejects `PROXY_CLOSED`, and its own deadline rejects `RECORD_TIMEOUT`. Filter by `arm` or connection to avoid matching an earlier cut.

`await close()` is idempotent and closes the listener, WebSocket server, matching peers and all tracked HTTP/pass-through sockets. Always call it in `finally`, including after failure. Closing an unfinished arm rejects its cut promise with `PROXY_CLOSED_BEFORE_CUT`; pending record waits reject `PROXY_CLOSED`. Startup, shutdown and calls return promises where shown; validation in `arm` and `acknowledge` throws synchronously.

The arm's `deadlineMs` begins at `arm()`, spans earlier connections and redials, and does not restart on progress. Expiry is `NO_SELECTED_SOCKET` if the selected connection never arrived, `ACK_TIMEOUT` if a delivery is awaiting acknowledgement, or `FRAME_TIMEOUT` otherwise. Each upstream handshake has its own `deadlineMs`. When a cut begins, the arm timer is cleared and a new `deadlineMs` bounds closure of both sockets. `waitForRecord` starts its separate timeout at that call. Timers fail a missing event; elapsed time never places a cut.

A cut calls `terminate()` on both WebSockets without sending close frames. The client sees an abnormal closure, not a server close code. A first-session before-session cut completes the client's handshake and delivers no application message. Matching connections terminate the other half on an ordinary close, so server close codes are not propagated. An upstream handshake refusal destroys the downstream socket rather than forwarding its HTTP status. The two `ws` endpoints handle ping/pong independently. HTTP errors before response headers produce 502; errors after headers destroy only that response.

### Proxy records, receipts and failures

`records` is a live array owned by the proxy. Treat it as read-only and save it in the caller's run directory; the proxy writes no files. Every record has `event`. Only `since`, `generation`, `cols` and `rows` query values are retained, as strings; headers and other query fields are omitted. Terminal payloads are still recorded and can contain application data.

- `connection`: `{ connection, path, session, query }`, recorded at each matching upgrade. `query` includes only the allowed keys actually present.
- `frame`: `{ connection, direction, frame, binary, length, bytes, type, source, offset }`.
- `ack`: `{ connection, frame, drained }`.
- `end`: `{ connection, code }`, a locally ended unarmed pair. Codes are `CLIENT_CLOSED_BEFORE_CUT`, `UPSTREAM_CLOSED_BEFORE_CUT`, `FORWARD_FAILED`, `CLIENT_ERROR` and `UPSTREAM_ERROR`; the close codes also describe recovery connections after a cut. Other pairs can emit these records after a run-wide `failure` as their sockets close.
- `cut`: Every receipt field below, alongside `event: "cut"`.
- `failure`: `{ code }`, at most one per proxy, including failures after a completed cut.

A frame's `direction` is `received` from upstream or `forwarded` to the client. Client-to-upstream messages are forwarded but not traced. `frame` increases independently per connection and direction. `binary` preserves the message type; `length` is payload bytes and `bytes` is base64. `type` is the parsed text JSON's `type` member or null, and null for binary. `source` is null for received frames and the originating received frame number for forwarded frames. `offset` is the byte offset inside that source, zero except for a split suffix. A forwarded record precedes the send attempt: it does not prove receipt or parser completion.

Every receipt contains:

- `arm`, `boundary`, `connection`, `sessionOrdinal`: the arm identifier, boundary name, matching connection ordinal and session ordinal.
- `upstreamFrame`: the received frame number at the boundary: session for before/after-session, the last source binary message for inside-replay, the counted message for after-replay-frame, or ready for before/after-ready.
- `receivedBytes`, `forwardedBytes`: payload totals on that connection when the cut begins, counted as frames are recorded, including earlier sessions on the socket.
- `replayBytes`: the selected session's `replay_bytes`, undefined if that message omits the member, so JSON serialization omits it. Every receipt follows observation of the selected session.
- `replayForwarded`: binary bytes delivered while the selected session is armed, capped at `replayBytes`; mode/prelude bytes beyond that count are excluded.
- `lastAcknowledged`: null or `{ frame, drained }` for the last accepted acknowledgement on that connection.
- `held`: queued messages in order, each `{ source, binary, offset, length, bytes }`, with base64 payload. Before-session starts with session; before-ready starts with ready; an inside-replay split starts with the withheld suffix and its source offset.
- `disconnect`: `{ client: "closed", upstream: "closed" }`; no receipt is published before both close.

`receivedBytes` and `held` depend on how far upstream intake ran before the acknowledgement and must not be compared across runs for equality. The other fields follow the selected arm and delivered message sequence, but frame numbers and byte totals can also differ if the upstream changes message segmentation or payloads. `drained` reflects the controller's supplied assertion.

The held queue checks its byte/message bounds before insertion; one in-flight send is outside that queue. `maxTraceBytes` counts received and forwarded payload bytes across all matching connections, so a fully forwarded byte counts twice. `maxQueueBytes` also bounds client-to-upstream buffered input. A resource failure records its code, discards held queues, stops matching peers and prevents further matching output. Receipts remain in records. A close or transport error on an unarmed pair ends that pair locally, before or after a receipt; a failure on the selected armed pair fails the run. An unarmed upstream close discards frames still queued for its client. A selected client that vanishes before its WebSocket upgrade refuses the cut with `CLIENT_CLOSED_BEFORE_CUT`, without a receipt. Replace a failed proxy rather than rearming it.

Tool-coded errors are `Error` objects whose `message` and `code` equal the listed code. Native URL, socket and filesystem errors may also propagate.

- `LOOPBACK_ORIGIN_REQUIRED`: Target is not the required loopback HTTP origin.
- `INVALID_SELECTION_OR_LIMIT`: Invalid start path, session, ordinal or limits.
- `CONTROLLER_DISARMED`: Closed/failed proxy, pending arm, absent past connection, or selected session already dequeued.
- `INVALID_BOUNDARY`: Unknown boundary, invalid inside-replay offset, or invalid after-replay-frame count. Both arguments require positive safe integers.
- `INVALID_ARM_SELECTION`: Arm connection/session ordinal is not a positive safe integer.
- `INVALID_ACK`: No live matching peer, cutting/closed/failed proxy, or nonpositive, stale, noninteger or over-range frame number.
- `NOT_ARMED`: Cut wait before any successful arm.
- `PROXY_CLOSED_BEFORE_CUT`, `PROXY_CLOSED`: Closure interrupts a cut or a record wait respectively.
- `RECORD_TIMEOUT`: Record predicate did not match within its timeout.
- `NO_SELECTED_SOCKET`, `FRAME_TIMEOUT`, `ACK_TIMEOUT`: Arm deadline expires in the states described above.
- `INVALID_REPLAY_BOUNDARY`: Selected session has an invalid replay count or the inside-replay offset is at/past its end. The after-replay-frame arm requires a nonnegative safe integer replay count.
- `INVALID_POST_REPLAY_BOUNDARY`: Ready arrived before the requested post-replay frame count; it is not forwarded.
- `QUEUE_LIMIT`, `TRACE_LIMIT`, `INPUT_QUEUE_LIMIT`: Held output, traced payload or buffered input exceeds its bound.
- `FORWARD_FAILED`, `CLIENT_ERROR`, `UPSTREAM_ERROR`: A send, downstream socket or upstream socket fails.
- `CLIENT_CLOSED_BEFORE_CUT`, `UPSTREAM_CLOSED_BEFORE_CUT`: Selected armed pair closes before its cut; an unselected pair records a local end instead.
- `DISCONNECT_TIMEOUT`: Both selected sockets did not close before the cut's closure deadline.

### Fixture lifetime, records and commands

`await startTerminalFixture({ logPath, deadlineMs = 5000 })` opens a private ephemeral loopback control listener and returns `{ command, env, records, ready, send, waitFor, close }`. `logPath` is a new absolute path in the caller's run directory and `deadlineMs` a positive safe integer. The fixture opens the byte log exclusively with mode 0600 and refuses to overwrite it. `command` is shell-quoted `exec '<node>' '<fixture path>'`. `env` contains `TERMINAL_FIXTURE_PORT`, `TERMINAL_FIXTURE_TOKEN` and `TERMINAL_FIXTURE_LOG`; supply these only to the run-owned terminal, never the hosting devserver. Do not persist the token.

`await ready()` returns the recorded hello identity. `await waitFor(predicate)` returns the first existing or future matching record; supply a nonthrowing predicate. Each unmatched wait starts its own `deadlineMs` and rejects `FIXTURE_EVENT_TIMEOUT`. Existing records remain searchable after failure/stop. `await send(op, args = {})` first waits for hello, then sends `{ ...args, op, id }` with an increasing id and starts a separate command deadline. It resolves with the reply's `value`, or rejects with the reply's code. A slow first command can therefore span a hello deadline and a command deadline. No clock causes fixture output.

`await close()` is idempotent, stops the controller listener and control sockets, and rejects pending commands and unmatched waits with `FIXTURE_STOPPED`. The first control failure is retained and rejects pending/later sends and unmatched waits. A command deadline rejects `FIXTURE_COMMAND_TIMEOUT`; a later reply to that expired id fails the controller with `UNEXPECTED_REPLY`. Size deadlines for the requested row count. Closing the controller disconnects the fixture; `send("stop")` asks it to fsync, reply and end its socket. After that reply, close the controller and reap the run-owned process; do not wait for further records, because socket closure can set `FIXTURE_DISCONNECTED`.

The live `records` array contains `{ type: "hello", pid, tty, raw, cols, rows }` without the token, `{ type: "keys", base64 }` for raw input bytes, and `{ type: "reply", id, ok: true, value }` or `{ type: "reply", id, ok: false, code }`. Save it separately from the emitted-byte log. Every successful command returns `{ offset, sha256, row, alternate, barrier }`: total emitted bytes, lowercase hex SHA-256 of all those bytes, next row number, alternate-screen boolean, and held barrier name or null. Commands execute serially. Each emission writes the log first and stdout second, then advances the hash and offset.

Names and prefixes match `^[A-Za-z0-9_-]{1,80}$`. In the byte descriptions below, `\r`, `\n` and `\x1b` denote CR, LF and ESC bytes; other characters are literal UTF-8.

- `rows`, `{ prefix, count }`: `PREFIX:NNNNNNNN\r\n` per row, counter starts at zero and is padded to at least eight digits. Integer count 1..100000; counter is shared across prefixes.
- `marker`, `{ name }`: `MARKER:NAME\r\n`.
- `bytes`, `{ base64 }`: Decoded bytes unchanged. Padded standard base64 without whitespace; empty string is allowed.
- `alternate`, `{ enabled }`: Boolean true emits `\x1b[?1049h`, false emits `\x1b[?1049l`; updates `alternate`.
- `redraw`, `{ name }`: `\x1b[2J\x1b[HSCREEN:NAME\r\n`; requires alternate screen.
- `barrier`, `{ name }`: No bytes; fsyncs log and holds the named barrier. A second barrier while one is held refuses `INVALID_BARRIER`.
- `resume`, `{ name }`: No bytes; releases the matching held barrier. With no barrier held it refuses `BARRIER_MISMATCH`.
- `stop`: No bytes; fsyncs log, replies with snapshot and ends the fixture.

A held barrier refuses every valid emitting command with `BARRIER_HELD`. Validation occurs first, so an invalid command can report its own error while held. A barrier proves stdout completion and fsync, not consumption by the server or renderer; independently observe a marker, attach cursor and parser completion.

Control messages are newline-delimited JSON. Before splitting lines, either endpoint refuses when its pending decoded string exceeds 1048576 JavaScript characters. This is a buffered-input cap, so one chunk containing many lines can also exceed it. Keep individual base64 commands comfortably below the cap.

Command refusal codes are `INVALID_ROWS`, `INVALID_NAME`, `INVALID_BYTES`, `INVALID_ALTERNATE`, `INVALID_REDRAW`, `INVALID_BARRIER`, `BARRIER_MISMATCH`, `BARRIER_HELD` and `UNKNOWN_COMMAND`, with the constraints described above. Command I/O errors retain a native `code` when present, otherwise use `FIXTURE_IO_FAILED`.

Controller errors are `INVALID_FIXTURE_OPTIONS`; `FIXTURE_IDENTITY_REFUSED` for a second peer, wrong token or non-hello first message; `UNEXPECTED_REPLY`; `FIXTURE_DISCONNECTED`; `FIXTURE_STOPPED`; `FIXTURE_EVENT_TIMEOUT`; `FIXTURE_COMMAND_TIMEOUT`; `CONTROL_LIMIT`; `INVALID_CONTROL` for invalid JSON or a failing receive callback; and `CONTROL_SOCKET_ERROR`.

`runTerminalFixture({ port, token, logPath, input = process.stdin, output = process.stdout })` is the exported process entry and resolves when its control connection ends. Both streams must be TTYs and input must support `setRawMode`; otherwise it rejects `PTY_REQUIRED`. Port is an integer 1..65535, token nonempty, and log path absolute, otherwise `INVALID_FIXTURE_OPTIONS`. The exclusive log open can reject native `EEXIST`. It restores the original raw-input setting and closes the log on normal control teardown. Direct CLI invocation reads the three environment variables; a rejected run writes `terminal fixture: CODE\n` to stderr and exits 1 (`FAILED` when no code exists). That diagnostic reaches the PTY but is outside the emitted-byte log.

### Creating a terminal for a run

Use a run-owned `chan` server with a throwaway home/workspace. `seedWorkspace()`, `launchServer(bin, workspace, log)` and `teardownServer(bin, server.child, workspace, server.chanHome, log)` are exported by `lib/server.mjs`. `log` is a function called with one line of text; `launchServer` returns `{ child, url, stderrLines, chanHome }`, with `url` a promise. Obtain the origin and the bearer token from `new URL(await server.url)`; its token query key is `t`. Redact credentials before saving server output. Always tear down only the server/processes that the run created.

Create the fixture controller, then POST to `{origin}/api/terminals` with `authorization: Bearer TOKEN`, `content-type: application/json`, and body `{ name, command: "stty -opost -echo && " + fixture.command, env: fixture.env }`. Require HTTP 201; the JSON member `session` is the terminal id. The POSIX wrapper requires `stty`: raw input alone does not disable output newline translation, so successful `stty -opost -echo` is required for byte equality. Await `fixture.ready()` and verify `tty`, `raw` and geometry.

Attach `/api/terminal/ws` with query keys `t`, `session`, `since`, `cols`, `rows`, and `generation` when redialing a known generation. Start the proxy with `path: "/api/terminal/ws"` and that session id, then connect to its origin. Use the cursor for bytes actually consumed, rather than adopting the advertised end cursor for a replay that was cut before delivery. Persist sanitized proxy records, cut receipts, fixture records and the emitted-byte log. Finally stop the fixture, close its controller and the proxy, close owned client sockets, and reap the terminal and throwaway server even when an assertion fails.

## Terminal page replay in Node

`REPLAY_CASES=alternate-screen REPLAY_OUT=/absolute/new/output node scripts/e2e/browser-smoke/terminal-replay-node.mjs` runs the real `TerminalTab.svelte` with a real xterm parser over real WebSockets against a throwaway debug server and the cutting proxy. Install the existing web and browser-smoke dependencies and build `target/debug/chan` first; `CHAN_BIN` selects another debug binary. No browser is downloaded. The dedicated `vitest.replay.config.ts` selects `TerminalTab.replay.e2e.ts`; ordinary web tests do not select it.

The alternate-screen case writes 5,000 distinct normal rows and a prompt, enters the alternate screen, disconnects, cuts the page's next attach after its processed session and before ready, awaits its own redial, then exits to the normal prompt. Assertions compare the fixture's byte log, upstream frames, actual client deliveries and parser-completed normal rows and cursors. The DOM terminal is a stand-in around the real parser. The controller supplies no replay policy and never calls the page's reconnect function.

The normal-screen case writes 5,000 rows and a prompt, then holds the next attach after its session while the fixture emits seven additional rows and a marker. The cut waits until the proxy has received that delta without delivering it to the page. Recovery must replay the fixture's whole byte log and show every baseline and withheld row once, with the expected cursor and no missed-byte notice. Select it with `REPLAY_CASES=normal-screen`, or select both screen cases with `REPLAY_CASES=alternate-screen,normal-screen`.

`REPLAY_CASES=keyboard-modes` runs three required arms: a normal-screen reset whose negotiation bytes have left the ring, an alternate-screen reconnect, and a mode change withheld until recovery replay. It invokes the page's registered key handler for Ctrl+Enter and Shift+Enter, compares the actual raw PTY input before and after cuts, and verifies that replayed mode changes override saved state. Parser snapshots establish completion; every nonempty replay is compared with the fixture's exact retained byte suffix. Wire comparisons freeze the received-frame prefix before reading the proxy records, so later resize frames cannot change the comparison's endpoint.

`REPLAY_CASES=overflow` fills the ring with carriage returns between old markers and retained rows, keeping the old rows visible in the parser before the cut. Recovery must deliver the fixture's exact retained suffix, remove those old markers, and leave exactly one notice above the retained rows. Its loss count is independently computed from the fixture's total bytes and the replay actually delivered; subsequent live output must preserve that notice.

`REPLAY_CASES=attach-windows` exercises ordinary normal-screen disconnects before session and after ready. The first preserves the consumed cursor, generation, complete history and parser cursor through a dial that delivers no session. The second withholds new fixture output behind an acknowledged, drained ready, then requires an exact suffix-only replay with the original history intact. Its result enumerates every required attach subcase; the group remains incomplete while any arm has not run.

The attach-window case also cuts a full replay at an interior prefix, inside a UTF-8 character, inside an escape sequence, and after its last byte before ready. Each is the second cut after an interrupted session, so both redials must abandon the earlier cursor. The controller arms the next boundary as the preceding cut receipt resolves; no elapsed delay places it. Exact delivered prefixes, complete recovery bytes, parsed rows and cursors are compared with the fixture log and the drained baseline. Acknowledgements are serialized and assert parser completion at the selected prefix.

Repeated before-session failures follow an interrupted normal replay and an alternate-screen attach. Recovery must keep requesting a fresh replay until ready. Alternate arms also cut before session, before ready after prelude and mode reassert, and after ready; they compare the prelude bytes, private modes, keyboard protocol and raw PTY key bytes while preserving every normal row. A controlled redraw and return to the normal prompt verify both buffers. The cut strictly between the alternate prelude and mode reassert remains not run because the proxy has no such arm.

The driver starts a fresh fixture, proxy, server and test process for each case, records their evidence in a case-named subdirectory, and writes the aggregate `results.json` even when a runner fails. Acceptance requires every required case and named subcase exactly once and passed, plus successful runners and cleanup. Missing attach-window arms and the unimplemented restart case keep the driver exit code at 2 and `accepted` false even when the implemented cases pass. Each case directory holds `vitest.log`, its named result JSON and the byte, frame and parser receipts. Painted pixels, trusted browser key delivery, the ghostty renderer's own input path, native webviews and fd-store restoration with an attached page are not exercised.
