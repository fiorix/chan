# One question is answered independently in three to eight places

Status: raised for v0.101.0 from the frontend review (its second theme and Phase 3: 134 verified patterns, 23 of them filed as medium findings), phased out of v0.100.0. The medium findings were re-verified against `main` at `d3de0180b` and all still apply; several have grown.

## What was seen

Most of the review's finding count is one shape: a question with no owning module, answered locally by each feature, with the answers drifting. A sample, each verified instance by instance:

- "Is this line inside a fenced code block" is answered eight ways across four editor files, and the detectors that most need the answer never ask it.
- `parentDir` is defined nine times and `basename` eleven, in a package whose `state/format.ts` header says it exists because these were duplicated before.
- Copy-to-clipboard is written eleven ways across the workspace app, six inside `editor/`, two without the missing-API guard the shared helper has.
- Escape has one designated owner and eight local handlers, each written as if it were the only one. Focus capture and restore has four implementations and three surfaces that skip it.
- Anchored popover positioning exists three times with three constant sets. Modal chrome is written five times.
- The bidirectional graph lens walk is written out three times in `GraphPanel.svelte`, with a fourth complete copy in `graph/lensClosure.ts` that only a golden test runs.
- The browser-smoke checks carry five to eighteen byte-identical copies of the same helpers, none in `lib/`; the launcher has three copy-pasted refresh coalescers and two reconnecting-WebSocket loops.

Two measures moved the wrong way since the review: a motion curve literal that was pasted at 34 sites in 16 files is now at 36 in 17, and the layout harness copied into nine test files is in twelve.

## Desired contract

Each of these questions has one owner, and the owner is almost always a module that already exists. The work is moving code, not designing abstractions; the owner's instruction for the review governs it: remove duplication, do not rewrite working code for taste.

## Boundaries

Decided per pattern from the review's section 8, which lists each with its instances. Two rulings come first: how far module decomposition goes (the review recommends mechanical seams only) and which shared primitives get extracted (it recommends five: a modal shell, a slot table, a WebGL program helper, card chrome and one deck focus restore). Out of scope: splitting `tabs.svelte.ts`, `store.svelte.ts`, `GraphPanel.svelte` or `TerminalTab.svelte`, and the seven-module WebGL shader duplication, all of which the review names as real and not worth the risk; and merging the document and scene sync lifecycles, which is a design question of its own.

## Acceptance

1. Each pattern taken has one definition and a test on that definition, and its former copies are gone.
2. No behaviour changes ride along: a dedup commit's diff is a move plus call-site edits, and anything else is its own commit.
3. The patterns not taken are listed with the reason.
