# A live drawing whose elements carry no version is written by a window that only opens it

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-29 by the lead's notes on the independent review of the live drawing's first range, which landed that day with [a-live-drawing-gains-appstate-keys-with-no-edit](a-live-drawing-gains-appstate-keys-with-no-edit.md), which name it as one more way in which a board nobody touched writes, older than that build and outside its item (`dev/v0101-team/reviews/review-Frontend-15.md` in the development tree, the lead's notes, from the review's answer to its first question, point (b)). The review read the server and the drawing library `@excalidraw/excalidraw` 0.18.1 and ran nothing; the report of the next range and its review name it again as an exception to a board that pushes nothing (`dev/v0101-team/reports/report-Frontend-29.md`, "Residuals"; `dev/v0101-team/reviews/review-Frontend-16.md`, its answer to its third question), and `web/packages/workspace-app/src/editor/design.md:90` says it at `e2a7e608f`. Read again at `e2a7e608f` in the app and the server; the library's part is the review's reading; not run. Older than that build.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0, with no new decision. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was that the owner's ruling of 2026-09-26 covers it: no surface other than the Markdown editor writes a file without a user's edit, and the first real edit may normalize ([the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) carries that ruling). A live drawing that a window only opens is written here with no edit, so the item is work under that ruling and needed no ruling of its own. Which side fixes it is the order's plan's: the server's shape, a missing version read as the library restores it, needs no change of `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte`, and the board's shape does, a file that the owner keeps closed in v0.101.0 for every change but the guard of [a-drawing-library-crash-publishes-an-empty-scene](a-drawing-library-crash-publishes-an-empty-scene.md).

## What was seen

Lines at `e2a7e608f`. The server reads an element's missing `version` as 0 and writes that 0 into the element it holds (`from_value`, `crates/chan-server/src/scene_sessions/scene.rs:105`, `:112`), so a snapshot carries the element at version 0. The drawing library's restore gives an element with no version the version 1, as the review read the library (its `dist/dev/chunk-4FTI6OG3.js:20454`; `review-Frontend-15.md`, the first question's point (b)), and the tests' stand-in for the library models it so (`web/packages/workspace-app/src/__tests__/excalidrawLibrary.ts:66-69`, `:78`). A live board is seeded through that restore (`seed`, `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:436`), and the bind's replay notes, for each element it adopts, the version the session holds (`applyRemote`, `:253`), while the reconcile keeps the board's element at the higher version (`:239-243`). So the board's element at 1 differs from the noted 0 and is offered as a change (`sceneDeltas`, `:8-17`), and the next flush pushes it (`pushDeltas`, `:280-310`). The authority keeps its stored element only against a lower version, or an equal one with a higher nonce (`stored_wins`, `scene.rs:152-154`, applied at `:316`), so it takes the pushed element, fans it to the other windows and marks itself dirty (`crates/chan-server/src/scene_sessions/mod.rs:1160-1165`), and its flusher writes the scene once it has been dirty for 800 ms (`SCENE_FLUSH_DEBOUNCE`, `mod.rs:71`; `flush_pass`, `:1426-1447`). The file then holds the library's restored element in place of its own, and nobody drew. That the first window to open such a drawing live writes it is inferred from the lines above, and was not run.

`editor/design.md:90` names a second thing a file can hold that a board nobody touched pushes, an image the authority does not hold; it was not read further here.

## Desired contract

A live drawing that nobody edits is not written, whatever version its file gives an element or leaves out.

## What to do

As suggestions: note, for an element the authority holds at version 0, the version that the library's restore gives it, so that the board's restored copy is no change; or read a missing version on the server as the library restores it. Which side decides is the order's plan's. Red first: a mounted test over the stand-in, whose restore already gives a missing version 1, and a real session whose snapshot holds an element at version 0, in which the board, touched by nobody, pushes that element.

## Boundaries

`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte` (`applyRemote` or `seed`), the stand-in `src/__tests__/excalidrawLibrary.ts` and the canvas's tests, or the server's `StoredElement::from_value` (`crates/chan-server/src/scene_sessions/scene.rs`) with its tests, as the plan decides.

## Acceptance

1. A live drawing whose file holds an element with no version, opened and not touched, pushes nothing and is not written; pinned red first.
2. A change of that element still pushes it.
3. A reading on a display with scene sync on: such a file opened live and not touched keeps its mtime, as the review's seventh step for a display has it (`review-Frontend-15.md`, "What only a display can show, as steps").

## What shipped

The build is on the integration branch and not on `main`: three commits, accepted on 2026-10-01, the two pins with a mounted control, the fix and the words; five files, `ExcalidrawCanvas.svelte` untouched, no lock change. The side is the server's, as the ruling above allows: `StoredElement::from_value` reads an element's `version` as the drawing library's restore leaves a missing or falsey one, so a version that is absent, `null`, `false`, `0` or `""` reads as 1 (`crates/chan-server/src/scene_sessions/scene.rs:104-108`, `unwrap_or(1)` then `max(1)`), and the snapshot a window receives carries 1, where it carried 0; the board's restored copy is then no change, and a drawing that nobody edits is not written. `crates/chan-server/design.md` says so, and the changelog's entry under Fixed. The tests' stand-in for the library already gave a missing version 1, as the library does by the builder's reading, and did not change.

**The boundary, a ruling of the lead's on 2026-10-01:** the row's domain is a file that the drawing library wrote or that a user left without a version, not a file whose version is a string, a negative or a fraction. Such a version is malformed merge metadata: the library's restore keeps a truthy value as it finds it, and the server, whose model is `u64`, reads it as 1, so a board over such a file still differs from its authority and pushes once. That is a malformed file normalized on its first live open, not a user's drawing written unedited, and it is out of this row: no pin, no widening of the merge model, no refusal of such files. `versionNonce` and `isDeleted` stay as they were: for a missing value the server and the library already agree, 0 and `false`, and a truthy non-number of either is the same class as the version's and is out of the row with it. One read changed.

**The acceptance at the tip.** The first point is met by two session-level pins, red first at their own assertions and green at the fix, an element without a version and one with version 0 loaded and the snapshot a window receives carrying 1, with the mounted board as the control on the board's side and a mutation that reverts the read red at both pins; the web and the Rust gates were green at the tip, by the lane's report. The third point, such a file opened live and not touched keeping its mtime on a display with scene sync on, is owed at rc0.
