# End-to-end suites

Everything under `scripts/e2e/` is owner-run. None of it is wired into `make pre-push` or a CI workflow: these suites build a real binary, drive a real server over a real filesystem, and some of them are destructive or need a live agent sitting at a terminal. Run them by judgment, typically after a coding session large enough that unit and integration tests would not notice a behavioral regression.

A scenario graduates into the gate only after it has proven stable across several sessions on more than one host. Until then, do not wire one of these into `make pre-push` or a workflow.

## Suites

- **`browser-smoke/`** drives a real chan server through headless Chrome: build the SPA and binary, seed a throwaway workspace, launch `chan open`, run every check under `checks/`, write `results.json` plus screenshots. `SMOKE_ONLY=` filters by filename prefix. See [`browser-smoke/README.md`](browser-smoke/README.md) for the check API and the environment.
- **`storm-check.sh`** overflows the host's real inotify queue and asserts rebuild-storm convergence. `CHAN_STORM_ACCEPTANCE=1` scales it to the full torrent.
- **`terminal-queue-drain.sh`** validates chronological `cs terminal write` batching against a live agent. Run it from a chan terminal whose `CHAN_CONTROL_SOCKET` targets the server under test, over a workspace that agent already trusts.
- **`gateway-zone.sh`** exercises the full gateway control plane: one controller, three proxy nodes, real identity and profile services, real `chan devserver` processes, tunnel reconnect, and failure scenarios. Its `ctrlplane` scenario covers signed user limits, policy transitions, account cuts, persistent fleet pause, OAuth and tenant-session revocation, and bounded aggregate reports. Its `extension` scenario proves the extension capability lane end to end: a declared test extension serves its entry doc and module script cookieless through a gateway tenant, a bogus capability answers a CORS-readable 404 while non-extension paths keep the bare session-gate 404, the capability stays out of service logs, and a devserver restart rotates the capability under an open watch socket (the stale path dies readable, the socket drops). `gateway-zone-browser.mjs`, `extension-capability-browser.mjs`, and `stub-oauth.mjs` support them.
- **`webview-flip-render.py`** renders the flip cards in a real WebKitGTK view, the engine the Linux desktop app ships on, and asserts which face owns the card at rest and either side of the mid-turn handover. It injects each component's own `<style>` block rather than a copy of it. `browser-smoke/` cannot cover this: Chrome honors `backface-visibility` and WebKitGTK ignores it, so a card hidden only by that property passes every Chromium check and covers the whole window in the shipped app. Needs python-gobject with the WebKit2 4.1 typelib and a display; wrap it in `xvfb-run -a` on a headless runner. Exits 2 when the GUI stack is missing.
- **`terminal-pixels.py`** mounts a real terminal in a real WebKitGTK view, writes a fixed box-drawing and block-element pattern, and measures whether rules join across cell boundaries and solid blocks tile without a seam, over the shipped matrix of {os-default, source-code-pro} x {xterm, ghostty}. It builds its page against the app's own `ghosttyCompat.ts`, font chain and `@font-face` rule rather than copies of them. Glyph geometry belongs to the engine, the renderer and the resolved face together, so no unit test can see this: jsdom paints nothing and Chrome rasterises differently. Needs python-gobject with the WebKit2 4.1 typelib, a display, and an installed `web/node_modules`; wrap it in `xvfb-run -a` on a headless runner. Exits 2 when the GUI stack is missing.
- **`terminal-pixels.mjs`** is the same suite on Windows, measuring the same page and the same thresholds in WebView2, the engine the Windows desktop app ships on. It is a separate driver rather than a branch in the Python one because that driver reaches WebKitGTK through python-gobject, and neither the typelib nor a system python exists on a Windows box; only the host and the snapshot path differ, and the page, pattern and regions are shared files. It also runs a different shipped arm: `shouldUseWebglRenderer` turns WebGL on for a Windows desktop, so the xterm scenarios carry the WebGL renderer and `--include-renderers` adds the DOM one as the reference. By default it drives Edge, which is the same Chromium build as the WebView2 runtime and can be scripted; `--webview2` instead hosts the page in the real WebView2 of a built `target/{release,debug}/chan-desktop.exe`, which is the only way to measure the shell's own browser arguments, since the runtime refuses to start standalone. Needs Node and an installed `web/node_modules`, no other dependency. Exits 2 when no host is found.
- **`lp-skip-test.sh`** with `lp-mock.py` covers the PPA publish retry-idempotence offline.
- **`devserver-fdstore.sh`** proves the terminal-survival contract against a real `systemctl --user` unit: a live PTY survives a bare restart, `chan devserver --restart`, a watchdog kill, and a `kill -9` crash restart; session close, `--stop`, `--restart --force`, and a bare stop end the shells and empty the fd store, with the store count asserted after every phase. It snapshots and restores any pre-existing `chan-devserver.service` state and REFUSES an active unit unless `CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1`, because taking over a live devserver kills its terminals. Run it inside an sdme container, never on a host serving live terminals: it is the one suite that drives a fixed shared unit rather than only processes it started, so rule 8 below cannot be satisfied by a throwaway `CHAN_HOME` and port, and the takeover variable is for a container where nothing else owns the unit.

## Scenario packs

`scenarios/` holds behavioral catalogs: what must hold, when a scenario is worth re-running, and which executable check or test backs it. A pack names the harness it runs on and does not restate harness documentation.

- [`scenarios/workspace-lifecycle.md`](scenarios/workspace-lifecycle.md): startup, shutdown, close and remove, root loss, and durable state across all of them.
- [`scenarios/rich-prompt.md`](scenarios/rich-prompt.md): composing a terminal prompt, sending it through the prompt queue, stopping a send, and restoring every one of those states after a reload.
- [`scenarios/desktop-webview-rendering.md`](scenarios/desktop-webview-rendering.md): what the desktop app's own webview paints, the CSS capabilities that claim rests on, and when to re-measure them.
- [`scenarios/terminal-grid-rendering.md`](scenarios/terminal-grid-rendering.md): what the terminal grid paints across both backends and both font preferences, and which glyphs a renderer may not defer to the font.

Write a new pack when a coding session produces a set of end-to-end expectations worth keeping. Name it for its subject, never for the session that produced it, and state every expectation in the present tense: a pack describes behavior that must hold, not work that was done.

## Rules for every run

These apply to every suite and every scenario pack.

1. Build the exact commit under test and record its SHA.
2. Use a fresh throwaway workspace, `CHAN_HOME`, output directory, and port.
3. Use a small deterministic source tree checked into or generated by the test. Do not clone from the network.
4. Use an explicit readiness or test barrier for startup races. Do not rely on sleep-and-hope.
5. Record command exit status, stdout and stderr, relevant `chan ps --json` or API snapshots, process identity, and file and metadata assertions.
6. Bound every poll and every shutdown wait.
7. Preserve logs, screenshots, and the throwaway workspace on failure.
8. Tear down only processes the run itself started.
9. Recursively delete only a path the run created and positively identified. Never aim a destructive step at a user workspace, a checkout, a home directory, an unresolved variable, a symlink, or a glob.

Report failures, skips, and manual-only coverage explicitly. A skipped check is not a pass.
