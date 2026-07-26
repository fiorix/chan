# DOOM overlay: a remote protocol tied to the cs session

Status: REGISTERED for v0.80.0, NOT specced. A prototype overlay exists on a branch; **the actual ask is the remote protocol, which the branch does not implement.** Spec the protocol first.

## The ask

Investigate a remote protocol for the DOOM overlay the way Excalidraw was done: the game state should ride chan's session machinery so an overlay can be driven and observed across clients, tied to a `cs` session, rather than being a purely local iframe toy.

The existing shapes to mirror:

- `crates/chan-server/src/scene_sessions/` - the scene-session machinery (lifecycle state, merge, wire frames, recovery payloads) that backs Excalidraw's collaborative surface. This is the structural precedent for a server-owned, session-scoped, multi-client surface.
- `scripts/e2e/browser-smoke/checks/40-excalidraw-collab.mjs` - the collaboration check that proves the shape end to end. A DOOM protocol wants its equivalent.

What "tied to chan's `cs` session" should mean concretely (frame authority, input multiplexing, spectator vs player, what a second client actually receives) is exactly what the spec has to settle. Note that DOOM is a real-time engine with a WASM-internal game state, which is a materially different problem from Excalidraw's document-shaped CRDT surface: do not assume the scene-session merge model transfers without a design pass.

## Where the prototype sits

Branch `doom-overlay`, based on `3674d30b` (the v0.77.0 GA commit), with a worktree at `../chan-doom`. **It needs rebasing before any further work.**

Read this before rebasing. The branch carries a second commit, `808e59c4`, that adds `team/roadmap/v0.78.0/doom-multiplayer.md` and a roadmap README row, and it also still holds `team/roadmap/v0.78.0/video-preview-and-range-serving.md`. Neither path exists on the rebase target: `team/roadmap/v0.78.0/` was removed at the v0.78.0 GA close under lifecycle rule 6, the video item now lives at `team/roadmap/v0.80.0/video-preview-and-range-serving.md`, and this item is its sibling there. A naive rebase therefore re-creates a forbidden `v0.78.0/` directory and conflicts in `team/roadmap/README.md`.

Resolve it by moving `doom-multiplayer.md` to `team/roadmap/v0.80.0/`, dropping the branch's copy of the video item in favor of the one already on the target, and taking the target's roadmap README.

The prototype adds a `DoomOverlay` (`OverlayShell` plus a launcher command "Play DOOM") that runs rojo2/wasm-doom (GPL-2.0) with the shareware IWAD in an iframe. Nothing is embedded in the binary or `web/dist`: the first open calls `POST /api/doom/download`, which fetches the ~5.5 MB bundle into `<user-config>/chan/doom/`, and the game loads from a `GET /doom/{name}` allowlist-only route mirroring `serve_font`. Bundle provenance, build recipe, and hashes are in `crates/chan-server/resources/doom/README.md`.

The iframe is the isolation boundary: closing the overlay tears down the engine context, and in-game keys (including Escape) never reach the SPA's window-level handlers. That boundary is load-bearing and a remote protocol must not quietly dissolve it.

## Open (decide at spec time, not now)

- Whether the protocol carries input events, framebuffer output, or engine state, and where authority lives.
- Whether the iframe isolation boundary survives, given that a protocol needs a channel through it.
- GPL-2.0 implications of the bundle for anything that stops being a download-on-demand third-party asset.
- Whether this ships as a real feature or stays an easter egg, which decides how much of the session machinery it is allowed to touch.
