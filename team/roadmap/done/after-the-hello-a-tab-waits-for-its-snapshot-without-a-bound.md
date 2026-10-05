# After the hello a tab waits for its snapshot without a bound

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: raised for a decision on 2026-10-03 by the lead, from the build and the independent review of the server's first frame on a sync socket ([a-sync-socket-closed-before-a-frame-stays-off](a-sync-socket-closed-before-a-frame-stays-off.md)); the owner has not ruled on it. Read in the code; nothing ran. Ruled by the owner on 2026-10-04: accepted for a build in v0.102.0, a page-side bound from the hello to the snapshot, its length proposed with the build.

## Owner ruling

On 2026-10-04 the owner accepted the row for a build in v0.102.0: a page-side bound from the hello to the snapshot, its length proposed with the build.

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

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff. No browser was driven: the pins use fake sockets and fake time, and a real slow transfer, an attach stalled on the server and a tab at the bound were not observed. The bound is 30 s on both surfaces (`DOC_SNAPSHOT_TIMEOUT_MS`, `web/packages/workspace-app/src/state/docSync.svelte.ts`; `SCENE_SNAPSHOT_TIMEOUT_MS`, `web/packages/workspace-app/src/state/sceneSync.svelte.ts`), beside the first-frame bounds, and their comments give its length: about 2 MiB at 0.56 Mbit/s, while bounding a stalled attach that would otherwise withhold saves. A socket's hello starts the bound while its session still awaits a first snapshot, and the first frame after the hello ends it. At the bound the session logs one warning to the console and degrades in place: the socket stays open, nothing redials and the latch is not written, so the tab saves the classic way; a snapshot that comes later attaches on the same socket, unless a classic save has landed first and redialed for a fresh one (read in the code of that save's heal, not run). A resumed document socket is attached at open and has no bound. Acceptance 1 is pinned red first on a document and on a drawing, and acceptance 2 by a guard on each that a snapshot inside the bound leaves no later timeout; the hello's earlier guards stay green. What the tab says is that console line and its degraded state; no sync status shows on the page. `web/packages/workspace-app/src/editor/design.md` and the `degraded` status's comment (`web/packages/workspace-app/src/state/tabs.svelte.ts`) state the bound. A page loaded before the server's upgrade has no bound until it reloads. The edit that a classic save and a late document snapshot both hold belongs to [a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it](../v0.103.0/a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it.md). The server's frame and the latch are unchanged, as the boundaries ask. This row is complete.

A dial the first build left unbounded was closed on 2026-10-04, in a range the lead accepted on its report, its status files and an independent review of its whole diff, which found three comments still wrong, repaired in the next range, and nothing above that, after an independent reading of that build found it: the document session armed the bound only while it was not attached, and its open handler also attaches at once an editor with collab installed that dials again for a fresh snapshot, the heal after a classic save or a desync recovery, so that redial awaited its snapshot with no bound. The bound now arms on every fresh dial, one with no resume version, and on any dial while the session is not attached (`docSync.svelte.ts`), pinned red first (a fresh redial of an attached editor timed out without degrading) with one mutation; `web/packages/workspace-app/src/editor/design.md` states the three cases, and that a resumed socket with its editor attached at open alone waits for no snapshot. Every scene socket already armed the bound at its hello.
