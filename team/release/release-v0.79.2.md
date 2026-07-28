# release-v0.79.2

v0.79.2 is a focused workspace release cut directly from `main` with no RC pin. Three functional commits add a selectable empty-pane animation library, repair focus and keyboard ownership around surveys and terminal shortcuts, and make diagram copying portable across browser and desktop surfaces. Two additional commits only keep the v0.80.0 roadmap current.

The functional delta is frontend-heavy but narrow in ownership: it changes the welcome surface, keyboard routing, and rendered-diagram actions without changing server protocols, persisted workspace data, or runtime dependencies. The `0.79.2` GA commit remains untagged until that exact tree passes the full local pre-push gate, a `release.yml` dispatch with `publish=false`, and the cache-only Docker downstream rehearsal.

## What shipped

**Empty panes have a real animation library.** A completely empty single pane now chooses from nine named canvas animations: Sixfold Vortex, Radial Ribbons, Polar Drift, Concentric Pulse, Penguin Grid, Exponential Thread, Quadratic Bloom, Orbital Rosette, and Dotted Waves. The choice persists for the browser session. `<` and `>` step through the library and `?` selects a different animation at random, with a brief accessible name indicator. A shared lifecycle owns pane-aware resizing, device-pixel scaling, theme changes, visibility, and reduced-motion behavior instead of each renderer inventing those edges.

**Decorative keys do not steal application shortcuts.** Animation navigation is mounted only for a completely empty single pane and waits for the document-level shortcut path to decline the event. It also rechecks focus and mount state in a microtask before acting, so a shortcut that opens a tab or split cannot also mutate the now-hidden welcome surface.

**Survey focus returns to the terminal that opened it.** The overlay records the originating terminal, defers its own focus claim past terminal refocus races, and restores the origin when the survey closes. Browser smoke 96 now exercises the follow-up signal through the real overlay and terminal path.

**Terminal shortcut escape follows the app's physical-key contract.** The terminal surface no longer runs a separate chord interpretation path that loses Option-mangled or code-based web chords. Unclaimed terminal input reaches the existing application keymap with the same physical-key routing used elsewhere.

**Diagram copying is explicit and portable.** Rendered Mermaid and Mermaid-to-Excalidraw widgets expose distinct SVG and PNG actions. PNG uses the native desktop bridge where available and the browser clipboard elsewhere. Mermaid has a clipboard-only renderer that removes HTML labels before WebKit rasterizes the SVG, while the visible diagram keeps its existing rendering.

**Diagram wheel zoom is gentler.** Wheel and trackpad input uses one quarter of the previous step while retaining the existing bounds.

## Team and process

This was a solo mainline patch: five commits after v0.79.1, all authored and committed by Alexandre Fiori on 2026-07-28. The functional work stayed in the workspace SPA plus one existing browser-smoke check. The roadmap commits register later work and do not expand this release's user-facing scope.

The cut follows the no-RC path used by recent patch releases. The report, changelog, Fedora source-package entries, root and gateway workspace pins, desktop bundle version, web package versions, and regenerated lockfiles move together in one GA commit.

## Validation

- The animation library commit ran `make web-check`; its tests cover selection, persistence, wraparound navigation, canvas lifecycle behavior, reduced-motion scheduling, and each animation's geometry helpers.
- The focus and shortcut commit ran `make web-check` plus browser smoke 96. Component tests cover survey focus restoration, empty-pane ownership, and the physical-key escape registry.
- The diagram commit ran 64 focused Vitest cases, the workspace Svelte checks, the web production build, and `cargo build -p chan`.
- The exact GA commit is held behind the full `make pre-push` gate, the `release.yml` `publish=false` platform build, and the `publish-downstream.yml` Docker-only `publish=false` rehearsal. The GA tag is not pushed unless all three are green.

## Retrospective

**Highlights.** The empty-pane work centralized the difficult canvas edges before multiplying renderers, so nine visual implementations share one resize, theme, visibility, and motion contract. The keyboard follow-up preserved the existing application shortcut owner instead of introducing a second global keymap. The diagram work split visible rendering from clipboard rendering, which fixes WebKit without paying for portability by degrading the on-screen result.

**Lowlights.** The source delta is large for a patch release because the animation library contains nine independent renderers and their math tests. Most of that volume is isolated decorative code, but line count still makes the full production build and platform rehearsal important. The two roadmap commits are intentionally present at the release boundary even though they ship no runtime behavior.

**Honest feedback.** The committed evidence is strong at the unit, Svelte, production-build, and browser-smoke levels. It does not substitute for a real WebKit clipboard operation or a visual pass over every animation on every display density. Those remain runtime observation gaps, not reasons to weaken the automated release gate.

## Follow-ups

- Hand-smoke Mermaid and Mermaid-to-Excalidraw SVG/PNG copy in the macOS and Linux desktop shells; the automated suite proves routing and payload construction but not the OS clipboard result.
- Keep animation review visual as well as mathematical when changing renderer parameters; helper tests cannot detect an unattractive or visually aliased composition.
- The registered desktop reverse-tunnel, agent submit-suffix, web-marketing onboarding, and media-preview work remains v0.80.0 roadmap scope.
