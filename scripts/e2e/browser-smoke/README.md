# browser-smoke

Headless-Chrome smokes that drive a real chan test server end to end: build the SPA + binary, seed a throwaway workspace, launch `chan open`, run every check under `checks/`, and write structured results.

## Run

```
node scripts/e2e/browser-smoke/run.mjs
```

Dependencies self-install on first run (`npm install` in this directory). The full run builds `web/` and `cargo build -p chan` first; set `SMOKE_SKIP_BUILD=1` when the binary and bundle are already current.

## Environment

- `SMOKE_OUT_DIR`: output directory for `results.json` + screenshots (default: a fresh `/tmp/chan-browser-smoke-*`).
- `CHAN_BIN`: chan binary (default `<repo>/target/debug/chan`).
- `CHROME_BIN`: Chrome executable (default: newest `~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome`).
- `SMOKE_SKIP_BUILD=1`: skip the web + cargo builds.
- `SMOKE_ONLY=50,101`: run only the checks whose filenames start with one of the comma-separated prefixes (lexical filename-prefix match).
- `TMPDIR`: the throwaway workspace is created under the OS tmpdir; a stray `.git` in `/tmp` makes chan's vcs-parent check refuse it, so point `TMPDIR` at a clean directory when that happens.

Exit code is nonzero when any check fails; skipped checks (a surface not yet landed) do not fail the run but are reported in `results.json`.

## Checks

Files under `checks/` run in sorted filename order. The sort is LEXICAL, not numeric: `100-*` and `110-*` run right after `10-*`, while numbered tail slots `94` through `99` run after `90-*`. The destructive `98-workspace-root-loss` check is the sole ordering exception and the runner pins it last so no later check inherits a missing workspace. Pick a prefix with the lexical order and raw `SMOKE_ONLY` prefix matching in mind. Each default-exports `{ name, run(ctx) }`; `run` throws (or returns) and may record intermediate evidence:

- `ctx.page`: a puppeteer page already on the workspace window.
- `ctx.serverUrl`, `ctx.workspaceDir`, `ctx.outDir`, `ctx.downloadDir`
- `ctx.chanBin`, `ctx.serverPid`, `ctx.controlSocket`
- `ctx.shot(name, page = ctx.page)`: screenshot into the out dir (auto-recorded). A check driving its own page passes it explicitly.
- `ctx.pollFile(path, timeoutMs)`: wait for a file to exist + settle.
- `ctx.skip(reason)`: mark the check skipped (e.g. a peer surface not merged yet).
- `ctx.assertPdf(bytes, { pages, orientation, minInkRatio })`: pdf-lib byte assertions (page count, A4 dims, per-page nonzero raster ink).
- `ctx.assertNoDuplicateBands(bytes)`: fails when the head band of a page also appears on the previous page (pagination duplication). Only meaningful for documents whose content does not repeat itself.
- `ctx.latencyProxy(latencyMs)`: a TCP delay proxy in front of the server (WebSockets included; CDP network emulation cannot delay them). Returns `{ url, setLatency, close }`; the check drives its own page against `url` and must `close()` the handle.

A check asserts a property, not a rate. A wall-clock threshold with no slack fails on a loaded host. A check whose external precondition is absent calls `ctx.skip`, it does not fail.

A check passes alone and in any suite position, so verify a new check both ways before trusting it. Two shared browser resources leak across checks and are the usual cause of a check that is green alone and red in a suite: Chrome caps the resource timing buffer at 250 entries, so a check reading `performance.getEntriesByName` clears the buffer first or its entry is silently dropped; and a pane side flip animates for 520ms with the pane header rotated out of the viewport, so a click during it fails as not clickable. Note also that `SMOKE_ONLY` matches filename PREFIXES, so `10` selects `100` through `104` as well as `10`.

`results.json` is written after `teardownServer`, so a teardown that throws takes the results file, the `ALL GREEN` / `N FAILURE(S)` line, and the exit code with it. The run's screenshots still land in the output directory, but its verdict does not, and a full run is exactly where that hurts because `98-workspace-root-loss` deletes the workspace root the teardown then reads. Treat an output directory holding screenshots and no `results.json` as a lost verdict, not as a pass, and read the console transcript for the per-check lines.

Add a new check by dropping a numbered file into `checks/`; nothing else needs editing.
