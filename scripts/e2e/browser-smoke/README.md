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

`lib/terminal-cut-proxy.mjs` and `lib/terminal-fixture.mjs` support owner-run replay checks without a browser. Run their deterministic peer tests with `node --test scripts/e2e/browser-smoke/lib/terminal-cut-proxy.test.mjs` from the repository root after `npm ci --prefix scripts/e2e/browser-smoke`. These tests establish tool behavior; they do not mount the terminal page or prove what a renderer paints.

`await startTerminalCutProxy({ targetUrl, path, session, ordinal: 1 })` listens on an ephemeral loopback port and returns `url`, `records`, `arm`, `acknowledge`, `waitForRecord`, `waitForCut` and async `close`. The target must be a bare `http://127.0.0.1:PORT` origin. Selection uses an exact socket pathname, the `session` query value, and an ordinal counted only among matching connections. Other HTTP requests and sockets pass through. Credentials travel upstream in memory; records retain only the selected path, session and `since`, `generation`, `cols` and `rows` query fields.

Call `arm({ boundary, bytes })` before the selected connection opens. One proxy permits one arm and one cut; recovery connections cannot inherit it. The boundaries are:

- `before-session`: withhold the upstream session message and disconnect.
- `after-session`: forward session, hold subsequent messages, then disconnect when that delivery is acknowledged.
- `inside-replay`: forward exactly `bytes` replay payload bytes, with `0 < bytes < session.replay_bytes`, then await acknowledgement of the last delivered fragment. A source binary message is split when necessary; its withheld suffix stays in byte order.
- `after-ready`: forward ready, hold later messages, then disconnect when ready is acknowledged.

Call `acknowledge({ connection, frame, drained })` only after the client's message handler returns. `frame` is the one-based downstream message number on that connection, including split deliveries. Set `drained` only after the parser's write callbacks finish; the proxy records this assertion and does not infer it. Receipt of a TCP write is insufficient. Unarmed forwarding does not wait for acknowledgements. `waitForRecord(predicate)` observes existing or future records; `waitForCut()` resolves only after both selected sockets close. The cut receipt gives upstream frame number, total received and forwarded payload bytes, replay count and delivered offset, last acknowledgement, held messages with base64 payloads and offsets, and disconnect completion. Frame records retain exact upstream and downstream payloads, types and ordinals. Save `records` and the receipt in the caller's run directory; the proxy writes no files itself.

Missing selection, missing frame and missing acknowledgement fail with distinct `NO_SELECTED_SOCKET`, `FRAME_TIMEOUT` and `ACK_TIMEOUT` codes. Deadlines bound failures and never select a cut. An invalid replay offset, stale acknowledgement, reused controller, overflowing queue or trace also refuses. Defaults are a 5-second deadline, 8 MiB/4096 held messages and 64 MiB of traced payload; callers can set `deadlineMs`, `maxQueueBytes`, `maxQueueMessages` and `maxTraceBytes`. Always await `close()` to close the listener and all owned sockets, including on failure.

`await startTerminalFixture({ logPath, deadlineMs: 5000 })` opens a private loopback control endpoint. Start a test terminal with `stty -opost -echo && ${fixture.command}` and its returned `env`, then await `ready()` and assert its raw PTY identity and geometry. The fixture program needs Node's built-in modules only; the POSIX launch wrapper requires `stty`. Node's raw input setting does not disable the PTY's output newline translation, so the wrapper's successful `stty` is a required precondition for byte equality. Its command is shell-quoted; the environment belongs solely to the terminal it starts. `logPath` must be a new absolute path in the caller's run directory: the fixture refuses to overwrite it and appends every emitted byte. Save the controller's `records` separately for command replies, barrier hashes and raw key receipts.

Use `send(op, args)` for `rows` (`prefix`, `count`, monotonically numbered), `marker` (`name`), `bytes` (`base64`, including ANSI modes), `alternate` (`enabled`), `redraw` (`name`, alternate screen only), `barrier` (`name`), `resume` (the same `name`) and `stop`. Replies include emitted byte offset, SHA-256, next row number, alternate-screen state and held barrier. A barrier follows stdout completion and fsync of the byte log; further output refuses until resumed. It does not prove that a server or page consumed those bytes: independently observe the marker, attach cursor and parser completion. `waitFor(predicate)` observes records, including `{ type: "keys", base64 }`. Names and prefixes accept ASCII letters, digits, underscores and hyphens, up to 80 characters. Invalid commands, mismatched barriers, missing peers and missing replies refuse. `send("stop")` ends the fixture; always await controller `close()` and reap the run-owned terminal/process during teardown.
