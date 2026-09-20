# Contracts mirrored by hand across the seam have nothing checking the copies

Status: raised for v0.101.0 from the frontend review (its third theme, its section on the frontend and backend seam, and findings GPANEL-04 and FILES-04, medium), phased out of v0.100.0. The two findings were re-verified against `main` at `d3de0180b`. The other seam observations below restate the review as it read `a7c3ce9d` and were not re-verified; `api/types.ts` has changed since. The review marks the wider work optional and names the one mirror it would gate.

## What was seen

Eight contracts cross the seam between the frontend and the Rust that serves it, and one of them is gated. `make shortcuts-check` compiles the real `state/shortcuts.ts`, regenerates the keybinding table and diffs it against the constant in `crates/chan/src/lib.rs`, so `chan serve --help` cannot start lying. Nothing else uses that pattern.

**File classification is the sharpest case.** Seven definitions across two languages give four answers to "what kind of file is this". The good half shows the discipline works: the 125-entry text-extension list and the well-known-basename list in `state/fileTypes.ts` are byte-for-byte identical with the Rust classifier, because a comment on each side names the other. The image set beside them has drifted four ways. A comment in `crates/chan-server/src/routes/graph.rs` tells the reader to keep its predicate in sync with the frontend's classifier and names the wrong one, a local copy inside `GraphPanel.svelte`, and a source-text test pins the drifted copy. The visible result: a PDF node in the graph paints as media, is counted by no chip, and survives turning the image filter off. `SOURCE_EXT_RE` is a third taxonomy: 61 extensions the server-mirroring list has are missing from it, and 19 run the other way.

**The wire types.** `api/types.ts` mirrors the route shapes by hand across about 1,200 lines under a header that says to keep it in lockstep. Two mirrors are wrong and latent because nothing consumes them: a graph route typed as an object where Rust returns a bare array, and two indexer timestamps typed as strings where Rust declares integers.

**Smaller mirrors.** The CSRF cookie and header names and the unsafe-method predicate are spelled independently in the launcher and the workspace app, and the two predicates have already diverged. The iframe allowlist in `api/embed.ts` and the desktop WebView's `frame-src` agree by hand. The username alphabet and the dark palette are re-inlined across the boundary.

## Desired contract

Where two sides must agree and neither can see the other, a check fails when one moves. The check compiles or reads the real definition on each side, as `make shortcuts-check` does, and never maintains a third copy.

## Boundaries

First the file classifier: one frontend classifier that `GraphPanel.svelte`, the file browser and `SOURCE_EXT_RE`'s callers all use, and a gate diffing its extension sets against the Rust classifier's. Each further mirror is a separate decision, because a gate is real maintenance cost: the two wrong wire types are corrected regardless, and gating `api/types.ts` as a whole is not proposed.

## Acceptance

1. A PDF node in the graph is classified the same way on the canvas, in the chips and in the file browser.
2. Adding an extension to one side's classifier and not the other fails `make pre-push`, shown red once on purpose.
3. The two wrong wire types match the Rust they mirror.
4. The comment in `routes/graph.rs` names the module that owns the classification.
