# A drawing library that throws unmounts its board, and a seeded board then publishes an empty scene

Status: raised for a decision on 2026-09-28 by the independent review of the seeded board, which landed that day with [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) (`dev/v0101-team/reviews/review-Frontend-13.md` in the development tree, its finding 6, with the lead's notes). The review found it older than that range and unchanged by it; it read the app at `0e6018fe9` and the drawing library `@excalidraw/excalidraw` 0.18.1 and React 18.3.1 that it installs, searched the library's source for an error boundary, and ran nothing. It is inferred throughout, and it needs a crash of the library that nobody has named, so it has no steps. The app's lines were read again at `30ffb8027`. Recommendation: a later version.

## What was seen

As the review read the library and React: the library installs no error boundary (a search of its `dist/dev/index.js` and its chunk for `componentDidCatch`, `getDerivedStateFromError` and `ErrorBoundary` found none); React unmounts a root on an uncaught error (its development build, `react-dom.development.js:18724-18741`); the library's App, as it unmounts, swaps in an empty scene and empties its files (index.js:30285-30293); and the imperative API's getters read those when they are called (index.js:29427-29434).

The canvas does not see that unmount. It keeps the API, which only its own teardown clears (`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:96`, `:522-527`), and its `seeded` fact, which only a load or a change of the buffer clears (`:131`, `:499-508`). So a flush that runs then, from a timer that the library's last reported change armed (`scheduleSerialize`, `:337-340`; `onLibraryChange`, `:393-397`), serializes through the API's getters (`serializeScene`, `:342-352`, called at `:402`), and, the board being seeded and its tab loaded, hands the empty scene to the tab because it differs from the baseline (`flushSerialize`, `:417-422`). The tab takes it as its buffer (`web/packages/workspace-app/src/components/FileEditorTab.svelte:1456`), for the autosave to write over the drawing.

A later change of the theme or of the read-only state renders the board again (`ExcalidrawCanvas.svelte:488-492`) with no initial data, since the API is set (`:434-438`). As the review read it, a new App then comes up empty while `seeded` is still true: its API's handover does not seed (`:441-448`, returning at `:369`), and its first reported change schedules a flush (`:393-397`) that publishes the empty scene the same way.

It falls under the owner's ruling of 2026-09-26 that no surface other than the Markdown editor writes a file without a user's edit, which [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) carries.

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
