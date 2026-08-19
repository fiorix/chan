---
name: test-server
description: >-
  Spin up and tear down a local chan test server over a throwaway or
  existing workspace, including the rebuild cycle for frontend changes.
when_to_use: >-
  The user asks to "spin up a test server", "try this in the browser",
  or otherwise wants a running chan instance to verify a change.
---

# Test Server Workflow

When the user asks for a test server (e.g. "spin up a test server", "let's try this in the browser"):

1. **Ask first**: new workspace under `/tmp/chan-test-<something>`, or reuse an existing registered one? `chan workspace ls` shows the options. For a new workspace, also ask what to seed it with (empty, a few sample notes, copy of an existing tree).
2. **Build + launch**: `cargo build -p chan` builds the binary, then `./target/debug/chan serve <path>` in the background. The launch URL carries the bearer token (`?t=`; the token is persisted and reused across restarts). A path inside a Git (or hg/svn) working tree is refused with `chan-error: vcs-parent` (exit 70) unless you pass `--here`; a fresh `/tmp/chan-test-*` directory sits outside any VCS tree and needs no flag.
3. **Reload on frontend changes**: a DEBUG binary reads `web/dist` from disk on every request, so a web edit needs only `npm run build` in `web/` (or `make web`, which also rebuilds the launcher bundle) plus a browser hard reload for the new hashed filenames; no server stop and no cargo rebuild. Only a `--release` binary embeds the bundle at compile time and needs the full stop, npm build, cargo rebuild, restart cycle.
4. **Tear down**: stop the server process, `rm -rf` the temp workspace directory if it was a throwaway, then `chan workspace forget <path>` to drop the registry entry. `chan workspace forget` takes the path, not the display name.

## Pitfalls (hard-won)

- **Stale `web/dist` gives a false bug.** When QA'ing a frontend-touching change, run `npm run build` in `web/` and grep the SERVED bundle for the handler before calling it broken. `web/dist` is gitignored; a stale build gives a false-negative, not a product bug.
- **Re-walking a previously-failed test**: explicitly stop the old server, `cargo build`, verify the binary provenance, then restart. Stale-binary false-positives cost real round-trips.
- **Multi-agent runs**: a broad `pkill chan serve` kills every agent's server. When several lanes share a machine, serve from a renamed binary copy (e.g. `/tmp/docsrv`) and scope each pkill to your own workspace path or port.
- **A shell owned by a devserver hands your test workspace to it.** Step 2's launch is right on an ordinary machine and wrong on one where a `chan devserver` already holds the terminal you are typing in, which is the case for every agent terminal in a multi-agent round. `chan serve` routes by shell parentage (the `chan serve` help text in `crates/chan/src/lib.rs`, under "Where it serves follows the shell's parentage"): a devserver terminal stays with that devserver, so the command registers your workspace into the shared instance instead of standing up your own. It looks local, it exits 0, and what it mutates is the workspace set of the process holding everyone's PTYs. Check with `chan ps` if you are unsure which case you are in. Either form opts out, and the environment variable is the one to reach for from a harness, where there is no argv to add a flag to:

  ```
  chan serve <path> --standalone --port <yours> --no-browser
  CHAN_NO_DEVSERVER_HANDOFF=1 chan serve <path> --port 0 --no-browser
  ```

  `--standalone` skips both the chan-desktop handoff and the devserver registration even when one is running; `CHAN_NO_DEVSERVER_HANDOFF` is its documented environment twin (`devserver_handoff_opt_out` in `crates/chan-server/src/devserver_handoff.rs`; any non-empty non-`0` value). Prefer `--port 0` over a hand-allocated port wherever the caller can read the URL back off stderr: a standalone server otherwise defaults to 8787 and two lanes that both omit it collide. Take a fixed port only when something downstream needs a stable URL.

  `scripts/e2e/browser-smoke/lib/server.mjs` is the worked example, and it is safe by four independent routes rather than one: the opt-out in its spawn env, `--port 0`, a throwaway `CHAN_HOME` so the registry it writes is a temp dir rather than `~/.chan`, and a container mount namespace that puts the registration socket somewhere that is not the host's.

  The routing mechanism is established from the source above. The opt-out is established by measurement: some forty spawns from that harness against a live shared devserver left its workspace set holding only its own. Nobody has fired the unmitigated command to confirm the other half, deliberately, because confirming it means mutating the devserver that holds every member's terminals.
