# browser-smoke

Headless-Chrome smokes that drive a real chan test server end to end:
build the SPA + binary, seed a throwaway workspace, launch `chan open`,
run every check under `checks/`, and write structured results.

## Run

```
node scripts/e2e/browser-smoke/run.mjs
```

Dependencies self-install on first run (`npm install` in this
directory). The full run builds `web/` and `cargo build -p chan` first;
set `SMOKE_SKIP_BUILD=1` when the binary and bundle are already
current.

## Environment

- `SMOKE_OUT_DIR`: output directory for `results.json` + screenshots
  (default: a fresh `/tmp/chan-browser-smoke-*`).
- `CHAN_BIN`: chan binary (default `<repo>/target/debug/chan`).
- `CHROME_BIN`: Chrome executable (default: newest
  `~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome`).
- `SMOKE_SKIP_BUILD=1`: skip the web + cargo builds.
- `SMOKE_ONLY=NN`: run only the checks whose filename starts with the
  given prefix (a lexical filename-prefix match, e.g. `SMOKE_ONLY=96`).

Exit code is nonzero when any check fails; skipped checks (a surface
not yet landed) do not fail the run but are reported in
`results.json`.

## Checks

Files under `checks/` run in sorted filename order. The sort is
LEXICAL, not numeric: `100-*` and `110-*` run right after `10-*`, and
the true tail slots are `96`/`97`/`98` (after `95-*`). Pick a number
with the lexical order in mind. Each default-
exports `{ name, run(ctx) }`; `run` throws (or returns) and may record
intermediate evidence:

- `ctx.page`: a puppeteer page already on the workspace window.
- `ctx.serverUrl`, `ctx.workspaceDir`, `ctx.outDir`, `ctx.downloadDir`
- `ctx.chanBin`, `ctx.serverPid`, `ctx.controlSocket`
- `ctx.shot(name, page = ctx.page)`: screenshot into the out dir
  (auto-recorded). A check driving its own page passes it explicitly.
- `ctx.pollFile(path, timeoutMs)`: wait for a file to exist + settle.
- `ctx.skip(reason)`: mark the check skipped (e.g. a peer surface not
  merged yet).
- `ctx.assertPdf(bytes, { pages, orientation, minInkRatio })`: pdf-lib
  byte assertions (page count, A4 dims, per-page nonzero raster ink).
- `ctx.assertNoDuplicateBands(bytes)`: fails when the head band of a
  page also appears on the previous page (pagination duplication).
  Only meaningful for documents whose content does not repeat itself.

Add a new check by dropping a numbered file into `checks/`; nothing
else needs editing.
