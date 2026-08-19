# A standalone window cannot create drafts

Status: REGISTERED 2026-08-19, after the fact, following the precedent of [a-standalone-window-cannot-reach-the-files-it-is-about](../done/a-standalone-window-cannot-reach-the-files-it-is-about.md). The work was built and verified on branch `feat/mw-drafts` against the v0.93.0 GA base (`9e883bd9`) before an item existed for it; this records the accepted scope and the verification already carried out, targeting v0.94.0 as the release that ships it.

## What

A standalone terminal window browses and edits the machine's filesystem, but it cannot create anything that is not already a file somewhere: New draft, New diagram, New slide deck, and Rich Prompt are all gated on `requirement: "workspace"`, and the slim tenant mounts no draft route. Rich Prompt is draft-backed by construction (it creates a draft per terminal and discards it on close), so the composer is unreachable in exactly the window an agent-driving user lives in. The workaround is the same one the Files surface eliminated: register a workspace the user has no intention of curating.

Drafts also had no home outside a workspace root. A workspace's drafts are in-tree (`.Drafts/`); a standalone window has no tree of its own to put them in.

## Desired contract

- A standalone window whose tenant serves the file surface can also create, edit, discard, and promote drafts, and Rich Prompt works in it.
- Drafts live in a per-library store the embedder places, the same way it places the session store: `~/.chan/Drafts` on a desktop host, `~/.chan/devserver/Drafts` on a devserver, so a same-machine pair stays disjoint despite the shared `~/.chan/config.toml`. Draft content is ordinary wire paths over the capability root, served and edited through the existing `/api/fs` lanes with no draft routing.
- Discarded drafts land in a working trash: a dedicated flat `drafts-trash/` sibling whose entries list, restore, and expire through the shared trash lanes (30-day lazy GC). Backing only; no restore routes or UI, matching the workspace, which has none either.
- The capability is the server's answer, advertised as `<meta name="chan-drafts">` beside `chan-files`, separate because the store can fail to construct while the file surface works. The requirement tiers nest: terminal within files within drafts within workspace.
- Promotion targets resolve through the `MiniWorkspace` facade (wire dialect, per-component symlink refusal, protected paths), never through a second resolver in the store or the handler.
- Workspace windows are byte-identical throughout: same routes, seeds, strings, defaults, and request lines.

## Implementation boundaries

- The store is `chan_workspace::DraftStore`, wrapping the same path-parameterized drafts and trash primitives `Workspace` wraps; target resolution is the new `MiniWorkspace::resolve_write_target`.
- The serving surface is `chan-server`: `routes/standalone_drafts.rs` siblings sharing the workspace routes' seeds and wire types by import, mutations attributed through the `?w=` ticket bus, the meta injected by `inject_chan_meta`, and the drafts wire dir carried as an additive `drafts_dir` on `GET /api/fs/context`.
- The store root threads embedder-to-tenant beside `session_dir` (`open_terminal_session`); command-carrying and control tenants structurally serve no drafts.
- The SPA gains `windowCaps.drafts` and a `"drafts"` requirement tier; the draft-path choke point (`draftsDir`/`isDraftPath`) answers per window.
- A companion repair shipped first as its own commit: `Workspace::discard_draft` nested its entries inside the swept trash root, where the sweeper destroyed them as meta-less junk on the next open and `trash_list` never showed them. Discards are now flat first-class entries, and workspace open hoists survivors of the old layout before its sweep.

## Acceptance (verified on the round, commits `3957dfa4`, `548e4d63`, `137c8500`, `4371b351`)

- Crate suites green under `-D warnings`: chan-workspace 708, chan-library 340, chan-server 1160 tests, including the new store, facade-resolver, and route tests; the pre-existing drafts and route tests pass untouched as the byte-identical proof.
- Web: svelte-check clean on all three SPAs; 425 test files green; the requirement-table snapshot regenerated and diff-reviewed (the four ids move to `drafts`, one new `terminal+files+drafts` section, nothing else).
- Live devserver smoke under a `CHAN_HOME` override, 18 of 18: both metas in the served shell, the drafts wire dir on fs-context, create/read/edit over the plain `/api/fs` lanes, `untitled-1` sequencing, the diagram seed, promote refusing `/etc/...` and `../...`, promote landing an edited draft and removing it from the store, discard answering 204 into a flat labeled trash entry, and no leakage into the real `~/.chan`. The workspace lane was live-verified on the same binary: identical create contract, and a discard now visibly lands flat, labeled, and restorable in the sidecar trash.
- Real-browser pass: `scripts/e2e/browser-smoke/checks/125-mini-window-drafts.mjs` (added by this item) boots a devserver under a throwaway `CHAN_HOME`, drives the minted terminal window in headless Chrome, and asserts both metas, the Rich Prompt chord opening the composer and autosaving into the store, and New draft dispatching through the capability gate into a real editor tab. Green on the branch; red against the unmodified v0.93.0 binary, so the check can fail.
- Full `make pre-push` gate: PASSED on the branch in the round's container, through the release devserver smoke and the desktop AppImage bundle.

## Known gaps, accepted

- A Rich Prompt draft orphaned by a crash is never auto-reclaimed. Workspace mode leaks identically (the close path discards pristine drafts; only a crash orphans one), nothing durable marks a rich-prompt draft, and any content heuristic would eventually eat a real draft. Accepted as a parity leak and recorded in `design.md`; a durable marker at rich-prompt create time is the only safe path to a future reclaim sweep.
- The browser pass ran in the round's headless container; no reading on a real desktop display exists yet.

## Rough size

Medium. The store and routes are thin over primitives that already existed; the review weight sits on the promote target resolution (the one new guard surface) and on the workspace-lane byte-identity audit.
