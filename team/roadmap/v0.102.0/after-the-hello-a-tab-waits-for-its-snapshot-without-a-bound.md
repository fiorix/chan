# After the hello a tab waits for its snapshot without a bound

Status: raised for a decision on 2026-10-03 by the lead, from the build and the independent review of the server's first frame on a sync socket ([a-sync-socket-closed-before-a-frame-stays-off](a-sync-socket-closed-before-a-frame-stays-off.md)); the owner has not ruled on it. Read in the code; nothing ran.

## Owner ruling

Not ruled.

## What was seen

The page gives a sync socket five seconds for its first frame, and the server sends a small `hello` first, before it attaches the session. The hello clears that timer and nothing replaces it (`web/packages/workspace-app/src/state/docSync.svelte.ts`, `web/packages/workspace-app/src/state/sceneSync.svelte.ts`). If the snapshot does not follow, because the attach stalls on a slow read or the server stalls, the tab stays connecting, with autosave withheld, until the socket closes or the user saves by hand; an explicit save still degrades the session after its own four seconds. Without the hello a document redialed every five seconds and went back to classic autosave after about ten, and a drawing turned scene sync off and saved whole files.

This is the cost of the ruled shape and not a slip in it: the first frame exists so that a large snapshot is not read as a failed dial.

## Desired contract

A tab that has had its hello and no snapshot within a bound says so and falls back to a save path that works, without turning sync off for the page. Or the cost stays written.

## What to do

If accepted: a second timer on the page, from the hello to the snapshot, long enough for a large drawing over a slow link; at its end the tab redials or degrades as a document does without the hello, and the latch is untouched. The bound's length is the choice: too short brings back the fault the hello repaired.

## Boundaries

No change to the server's frame and none to the latch.

## Acceptance

1. A socket that sends its hello and no snapshot within the bound leaves the tab able to save, and says what happened; pinned on a fake socket, red first.
2. A snapshot that arrives inside the bound attaches as it does today; pinned.
