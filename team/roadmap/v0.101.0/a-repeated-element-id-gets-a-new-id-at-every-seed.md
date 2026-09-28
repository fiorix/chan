# An element whose id repeats in a drawing gets a new id at every seed

Status: raised for a decision on 2026-09-28 by the independent review of the seeded board, which landed that day with [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) (`dev/v0101-team/reviews/review-Frontend-13.md` in the development tree, its finding 3, with the lead's notes). The review read the app at `0e6018fe9` and the drawing library `@excalidraw/excalidraw` 0.18.1 that it installs, verified the mechanism by reading, inferred the pushes, and ran nothing; the app's lines were read again at `30ffb8027`, and the library's are the review's. New with the seeded board. Recommendation: a later version.

## What was seen

The drawing library's restore gives the second element of a repeated id a new random id, and gives one to an element with no id, at every call, as the review read the library (its `dist/dev/chunk-4FTI6OG3.js:20684-20686` and `:20458`). Every seed of a drawing's board calls that restore on the tab's buffer and replaces the board's elements with what it answers (`seed`, `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:368-386`, the restore at `:371` and the apply at `:376-380`). The canvas seeds at the library's first reported change, and again whenever the tab's load finishes or its buffer changes without the board, as a reload, a conflict's resolution or a sibling pane's mirror does (`onLibraryChange`, `:393-397`; the content effect, `:494-508`). So the library's init gives such an element one id, the seed at its first change gives it another, and each later seed from a buffer that still holds the repeat gives it another. Before the seeded board only the init restored, and a later seed applied the buffer's elements as they were, as the review read the range's base.

Without a scene session nothing is written: the seed takes the board's serialization as its baseline in the same run (`:384`), so a new id publishes nothing until a stroke. With a session, an element under an id the canvas has not sent or applied is offered as a change (`sceneDeltas`, `:8-17`; `pushDeltas`, `:231-258`), and the authority takes an element it does not hold as a new one (`apply_push_with_limit`, `crates/chan-server/src/scene_sessions/scene.rs:311-320`, `:344-349`). The copy under the id before it stays at the authority, since the board dropped it without a deletion and offers only the elements it holds (`ExcalidrawCanvas.svelte:233`), and the authority's flusher writes the scene it holds to the file (the module's doc, `crates/chan-server/src/scene_sessions/mod.rs:21-23`; the push's dirty mark, `:1164`).

The review's steps, inferred and not run: with scene sync on, open a drawing another program wrote in which two elements share one id, and press "Reload from disk" before the authority has written the file again; each seed whose new id reaches the authority leaves one more copy of the element in the file. It needs such a file, which chan does not write, and a push between two seeds of a buffer that still holds the repeat.

## Desired contract

A drawing whose file holds a repeated id seeds to the same elements under the same ids each time, so a board nobody drew on offers its session nothing and the file gains no copy of an element.

## What to do

As suggestions: give each repeat an id the seed can derive again from the buffer, such as one from its place in the file, before the restore sees it; keep, for an element the seed replaces, the id the board already gave it; or offer the element the board dropped as a deletion. Red first: a canvas test over a bound session and a stand-in whose restore gives a repeat a new id as the library's does, in which a second seed of the same buffer pushes an element.

## Boundaries

`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte` (`seed`), the stand-in `src/__tests__/excalidrawLibrary.ts`, and the canvas's tests. The server's scene sessions and the library are unchanged.

## Acceptance

1. Two seeds of one buffer that holds a repeated id put the same ids on the board; pinned red first over a stand-in whose restore gives a repeat a new id.
2. With a session, a reload of such a file pushes no element and the authority holds as many elements after it as before; pinned.
3. A reading on a display with scene sync on: a file with two elements under one id, reloaded twice within a second, holds as many elements afterwards as before.
