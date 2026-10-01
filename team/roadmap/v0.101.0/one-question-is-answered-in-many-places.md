# One question is answered independently in three to eight places

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised for v0.101.0 from the frontend review (its second theme and Phase 3: 134 verified patterns, 23 of them filed as medium findings), phased out of v0.100.0. The medium findings were re-verified against `main` at `d3de0180b` and all still apply; several have grown.

## Owner ruling

Accepted on 2026-09-24. The owner wants the code de-duplicated and its modules organised properly, and left the timing to the lead's recommendation: after [source-text-tests-pin-spelling-not-behaviour](source-text-tests-pin-spelling-not-behaviour.md), because both move the same test files. That recommendation also proposed mechanical seams only, the five shared primitives the review names (modal shell, slot table, WebGL program helper, card chrome, deck focus restore) and no module decomposition. The owner's words about organising the modules properly read wider than that last clause, so how far module decomposition goes is confirmed with the owner before the lane fixes its scope.

On 2026-09-26 the owner chose B for the module question: the mechanical seams and the five primitives, plus the seven extractions the dedup forces, each a new module that retires copies; the package and drawer reorganisation is not part of this item.

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

## What shipped

The five primitives and the first sweeps are on `main`, landed from 2026-09-26 with the frontend dedup rounds: the modal shell (`web/packages/workspace-app/src/components/ModalShell.svelte`), the slot table, the card chrome, the WebGL program helper (`src/components/webglProgram.ts`) and the deck focus restore, with the folds of the fence tracker, of `parentDir` and `basename` and of the graph lens closure (`src/graph/lensClosure.ts`); a reading of 2026-09-30 confirmed them at the integration base. Of the seven extractions the owner chose on 2026-09-26, the graph module is half done, `shallowestFileDepth` in `src/graph/depth.ts` while `directoryNodeId` is private to the graph panel with three copies, and the transfer suffix was folded by a fix of [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md); the viewer overlay, request card and code report section are built as recorded below; the canvas prop types remain unbuilt, and the search state is among the patterns not taken.

**The patterns not taken in v0.101.0, with the reason,** by a ruling of the lead's on 2026-10-01 on that reading, which counted what is left at about twenty-two small orders and cut the orders that close every buildable row of the review remainder's editor and graph half and five of the seven extractions ahead of the seam tail:

- **The launcher's in-memory API** (`web/packages/launcher/src/api/inMemory.ts` over its mock and demo servers, which 21 test files import) and **the launcher, web-shared and profile seams** (the deck key, `actingFor`, two refresh coalescers, the auth token): every file is the launcher's or the profile's, the Clients lane's, under the launcher's bundle budget of 56 KiB that that lane measures. The in-memory API is one of the seven extractions the owner chose, so leaving it out is put to the owner.
- **One `withStatus` and one download anchor:** the seam tail, and a move after which one caller revokes its object URL at another time.
- **`workspaceWarningKey` exported and one directory-load predicate:** the seam tail; the three predicates differ for an empty error text, as `!x[p]` and `p in x` do, so a fold changes one.
- **One storage probe, one flag reader and one anchored popover position:** the seam tail; each overlay keeps its own gap, margin and rounding, so a shared position is parameters and never a merge.
- **The `--ease-pop` motion token,** 31 sites in 13 files: the seam tail, with tests that spell the curve and six CSS sites in the terminal tab and the graph panel.
- **The search state module, narrowed:** the seam tail; the defects it was to make testable are fixed in place, one reset for its three sites changes what is cleared, and the query lifecycle is out.
- **`errorText` with one definition:** its four equal private copies and 25 inline ternaries come after the Clients lane's refusal pieces, which reshape `src/api/errors.ts`; its 71 `(e as Error).message` casts in 26 files are a behaviour change in every area for an error text nobody reported.
- **The test layout harness,** 24 test files keeping local copies of what `src/__tests__/tabs.ts` exports and eight casting `as unknown as Preferences`: the seam tail, two orders.
- **A shared `frontmatterEndLine`:** no longer a move, since the slides and the outline follow two rules and a fold changes one.
- **One prefix parser, `openJsonWatch`, `chordForCommand` and the terminal's held-tail prologue:** the other half's areas, the API, the command deck and the terminal; the parser and the chord lookup change behaviour, and the prologue's real defect, missing `reset()` calls, is a row of the Clients lane.
- **The demo's folds of `baseName` and its `dirId`:** the owner ruled on 2026-09-29 that the demo cuts a parent by its own rule, as the server does, so a fold onto the client's helpers goes the other way, and `src/demo/graph.ts` holds the hygiene tail's two NUL bytes.

The counts under What was seen are history: `parentDir` and `basename` have one owner each, with five private `basename` copies left where the fold's rulings kept them, and the motion curve literal is at 31 sites in 13 files.

## Built on 2026-10-01

The request card, media-viewer overlay and code report section are on accepted integration `d8d30bc29`, with `fileUrl` and the three code-cost formatters beside them. `RequestCard.svelte` serves the paste and handover notifications; `openViewerOverlay` serves PDF, video and audio; `CodeReportSection.svelte` serves the file and workspace inspectors. Each definition and its tests preceded the call-site moves. The two inspectors retain their own margins, and image and diagram zoom stay outside the overlay fold. The internal-link predicate was also shared in `editor/links.ts` with the editor fixes.

The independent source review accepted the five definition-and-call-site moves with residuals. Its follow-up replaced the new tests' legacy prop adapter with runes props, added an inspector toggle case, corrected the file-URL mock and four comments. Both own gates and the combined gate passed; no changelog line is needed for these moves. Divider placement and spacing above Code, the native PDF embed under the overlay, and clipboard user activation on Enter remain display checks. The seam-tail exclusions and the owner's pending decision on the launcher's in-memory API are unchanged.
