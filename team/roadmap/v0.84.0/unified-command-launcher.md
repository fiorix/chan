# One command launcher across every Chan surface

Status: REGISTERED for v0.84.0. The overlay implementation was built, hand-tested on macOS and Linux through six defects, and withdrawn from v0.83.0; the goal stands, the approach does not. The next attempt belongs at the SPA layer.

## What

Chan has a command launcher per surface: the workspace window, the standalone terminal, the launcher window, and remote devserver content each reach a different action set through different code. The visual and keyboard experience should be one thing.

The obstacle is that those webviews do not carry equal authority. A remote devserver page must never receive Chan Desktop's aggregate Computers inventory, its root launcher bearer, or the user's query text.

## Why the overlay approach was withdrawn

The v0.83.0 attempt satisfied that constraint with a separate native window: one reusable, transparent, undecorated, always-on-top Tauri overlay owned by the desktop process, positioned over the invoking window, holding the aggregate authority, with the invoking webview contributing only serializable command descriptors.

Six defects were found and fixed in sequence and the feature still did not work:

1. Every awaited command hung on `Working...`, because setting the pending state mutated the draft, which the host echoed back, which replaced the object the in-flight execution was holding.
2. The injected key bridge claimed the launcher chord in windows served by an older devserver whose SPA has no source protocol, consuming the key and opening an overlay nothing could populate.
3. Drafts were numbered per source while the reusable overlay holds one revision cursor, so a fresh source's first snapshot was rejected as stale while the native side had already shown and focused the window.
4. A late fire-and-forget save from one owner mutated another's draft, and the window was shown before it had content.
5. Fixing 3 by making revisions globally monotonic put the host cursor and a speculative client counter into one number space, creating a new ownership race.
6. The overlay renders in the wrong place, because it is positioned in physical pixels while hidden, which `.agents/desktop.md` documents as unreliable on macOS.

A seventh symptom was never explained: on the Computers scope, branch rows do not navigate, on both macOS and Linux.

Five of the six are ownership, revision, or synchronization defects that exist only because the deck is a separate native window shared across sources with its own draft state. The sixth is native window placement. None of them exist for a deck rendered inside the page that invoked it.

The full evidence, including three hypotheses that were raised and falsified, and the one discriminating test never run, is in the round's dossier.

## What the next attempt should settle

- **Does the aggregate Computers scope have to be reachable from a remote `lib-*` window at all?** The authority constraint binds only for remote content. Every other window class is served by the desktop's own embedded bundle and is not a foreign trust domain. If the answer is no, an inline deck with aggregate scope only in locally-served windows preserves the constraint with no second window, and remote windows fall back to the window-bound library capability that already exists.
- **If it does, what carries that authority without a shared native window?** A per-source inline deck requesting a scoped snapshot over IPC is one shape: the page never holds the bearer, and there is no window to position, own, or synchronize.
- **What is the smallest thing that ships?** Contextual scope inline is close to free. Computers scope is where the authority complexity lives.

## Worth keeping from the withdrawn attempt

- The shared `CommandDeck` component, its ranking, keyboard model, and draft shape.
- The window-bound library command capability: five-minute sliding expiry, live-window checked, role inheriting, token redacted.
- The contextual command descriptor catalog and the revalidate-before-execute contract, where the source resolves a returned id against its own live catalog before running it.
- The product vocabulary the attempt introduced: command launcher, contextual deck, Computers scope, launcher entry mode, launcher draft, deep search, scoped query, library command capability.

## Open

- Everything under "What the next attempt should settle" is unruled.
- One defect found during the investigation is worth fixing wherever the deck lands: in `CommandDeck.execute`, the `!awaitResult` branch awaits outside its try/catch, so a throw is an unhandled rejection and a row that fails looks identical to a row that does nothing.
