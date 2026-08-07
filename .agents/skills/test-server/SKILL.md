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
2. **Build + launch**: `cargo build -p chan` builds the binary, then `./target/debug/chan open <path>` in the background. The launch URL carries the bearer token (`?t=`; the token is persisted and reused across restarts). A path inside a Git (or hg/svn) working tree is refused with `chan-error: vcs-parent` (exit 70) unless you pass `--here`; a fresh `/tmp/chan-test-*` directory sits outside any VCS tree and needs no flag.
3. **Reload on frontend changes**: a DEBUG binary reads `web/dist` from disk on every request, so a web edit needs only `npm run build` in `web/` (or `make web`, which also rebuilds the launcher bundle) plus a browser hard reload for the new hashed filenames; no server stop and no cargo rebuild. Only a `--release` binary embeds the bundle at compile time and needs the full stop, npm build, cargo rebuild, restart cycle.
4. **Tear down**: stop the server process, `rm -rf` the temp workspace directory if it was a throwaway, then `chan workspace rm <path>` to drop the registry entry. `chan workspace rm` takes the path, not the display name.

## Pitfalls (hard-won)

- **Stale `web/dist` gives a false bug.** When QA'ing a frontend-touching change, run `npm run build` in `web/` and grep the SERVED bundle for the handler before calling it broken. `web/dist` is gitignored; a stale build gives a false-negative, not a product bug.
- **Re-walking a previously-failed test**: explicitly stop the old server, `cargo build`, verify the binary provenance, then restart. Stale-binary false-positives cost real round-trips.
- **Multi-agent runs**: a broad `pkill chan open` kills every agent's server. When several lanes share a machine, serve from a renamed binary copy (e.g. `/tmp/docsrv`) and scope each pkill to your own workspace path or port.
