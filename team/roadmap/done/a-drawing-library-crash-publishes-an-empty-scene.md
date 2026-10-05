# A drawing library that throws unmounts its board, and a seeded board then publishes an empty scene

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the independent review of the seeded board, which landed that day with [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) (`dev/v0101-team/reviews/review-Frontend-13.md` in the development tree, its finding 6, with the lead's notes). The review found it older than that range and unchanged by it; it read the app at `0e6018fe9` and the drawing library `@excalidraw/excalidraw` 0.18.1 and React 18.3.1 that it installs, searched the library's source for an error boundary, and ran nothing. It is inferred throughout, and it needs a crash of the library that nobody has named, so it has no steps. The app's lines were read again at `30ffb8027`.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0, as the guard only. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters: the fault writes an empty scene over a drawing and says nothing, and the guard is one component. The guard, as ruled: a boundary around the board that, when the drawing library fails, clears the API and `seeded`, cancels the pending flush, and says that the library failed. `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte`, which the owner keeps closed in v0.101.0, is opened for this guard and for no other change. When it was raised the lead recommended a later version, since the fault needs a crash of the library that nobody has named; none has been named since.

## What was seen

As the review read the library and React: the library installs no error boundary (a search of its `dist/dev/index.js` and its chunk for `componentDidCatch`, `getDerivedStateFromError` and `ErrorBoundary` found none); React unmounts a root on an uncaught error (its development build, `react-dom.development.js:18724-18741`); the library's App, as it unmounts, swaps in an empty scene and empties its files (index.js:30285-30293); and the imperative API's getters read those when they are called (index.js:29427-29434).

The canvas does not see that unmount. It keeps the API, which only its own teardown clears (`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:96`, `:522-527`), and its `seeded` fact, which only a load or a change of the buffer clears (`:131`, `:499-508`). So a flush that runs then, from a timer that the library's last reported change armed (`scheduleSerialize`, `:337-340`; `onLibraryChange`, `:393-397`), serializes through the API's getters (`serializeScene`, `:342-352`, called at `:402`), and, the board being seeded and its tab loaded, hands the empty scene to the tab because it differs from the baseline (`flushSerialize`, `:417-422`). The tab takes it as its buffer (`web/packages/workspace-app/src/components/FileEditorTab.svelte:1456`), for the autosave to write over the drawing.

A later change of the theme or of the read-only state renders the board again (`ExcalidrawCanvas.svelte:488-492`) with no initial data, since the API is set (`:434-438`). As the review read it, a new App then comes up empty while `seeded` is still true: its API's handover does not seed (`:441-448`, returning at `:369`), and its first reported change schedules a flush (`:393-397`) that publishes the empty scene the same way.

It falls under the owner's ruling of 2026-09-26 that no surface other than the Markdown editor writes a file without a user's edit, which [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) carries.

**Read again at `4c4ada0a1` on 2026-09-29,** where the canvas is byte for byte what it is on `main`: no guard exists. `flushSerialize` publishes when the board is seeded and its tab loaded and the serialization differs (`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:467-495`), `renderExcalidraw` passes no initial data once the API is set (`:506-536`), and the API is cleared only in `onDestroy` (`:593-598`). Read, not run.

## Desired contract

A board whose library has unmounted, or has been built again without the buffer, publishes nothing: a scene reaches the tab only from a board seeded from the whole of a finished load, and the board says when the library has failed rather than showing an empty drawing.

## What to do

As suggestions: catch the library's failure around the board, by an error boundary or by a check that the API the canvas holds belongs to a mounted App, and clear `seeded` and the API when it fails, so that nothing publishes until a seed from the buffer; and let a render after such a failure carry the buffer as its initial data again. What the board shows when the library has thrown is the order's to propose. Red first: a mounted test over the stand-in in which the library throws after a seed with a flush pending, and the empty scene reaches the tab.

## Boundaries

`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte` (the render, `seed` and `flushSerialize`), the stand-in `src/__tests__/excalidrawLibrary.ts`, and the canvas's tests. The library is not changed.

## Acceptance

1. A library that throws after a seed, with a flush pending, puts nothing in the tab's buffer; pinned red first.
2. A render after that, for a theme or a read-only change, publishes nothing until the board is seeded again from the buffer; pinned.
3. The board says that the drawing library failed; checked mounted.

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

The canvas is opened for this one change, as ruled, a guard and nothing more. An error boundary around the drawing library (`DrawingBoundary`, `onLibraryFailure`, `web/packages/workspace-app/src``/editor/ExcalidrawCanvas.svelte`) catches a throw, drops the library's handle and the seeded mark, cancels the pending serialize and sets `libraryFailed`; while that is set nothing is rendered into the library again and nothing is published, and an alert says that the drawing library failed. All three acceptance points are pinned in `components/FileEditorTab.canvasEdits.test.ts` under "a drawing library failure": a failure with a stroke waiting keeps the saved buffer and writes nothing, theme and read-only changes do not render the library again, and the alert shows. Recovery is a new mount, which restores the buffer without writing; no render in the same mount carries the buffer again. The changelog has the entry.
