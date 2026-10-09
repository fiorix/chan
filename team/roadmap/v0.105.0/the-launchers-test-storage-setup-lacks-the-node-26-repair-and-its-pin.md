# The launcher's test storage setup lacks the Node 26 repair and its pin

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A gap in a test fixture; no launcher test fails or passes without looking today. The v0.104.0 repair of the workspace app's test setup measured that under Node 26 the jsdom test page's `sessionStorage` is Node's own built-in store and not an instance of the global `Storage`, so a test's spy on `Storage.prototype` sees no write: an assertion that something was written fails, and one that nothing was written passes without looking. The repair put the page's own stores back on the global in `web/packages/workspace-app/vitest.setup.ts` and pinned that in `vitest.setup.test.ts` (`team/roadmap/done/tests-that-fail-off-the-gates-path.md`, section "Web landing 2026-10-08"; `dev/v0104-team/reports/validation-Frontend104-item8-web.md`, section "The transfers test (acceptance 1)"). The launcher package was left as it was: its `vitest.setup.ts` "has the same shape and no test that is blind today; it is not changed, and is held as an observation for a later version" (the closed item, same section). The author's reason: no launcher test spies on `Storage.prototype`, a search over every package finding the two workspace-app test files only, so nothing fails or passes blind there (the validation report, section "Not changed, and why"). The review agreed and added that the same blindness waits for the first launcher test that does spy, under a newer Node, and that mirroring the shim and its pin there is a few lines (`dev/v0104-team/reviews/review-Review104-item8-web-1.md`, section "Notes", entry P3). The lead ruled it not changed in the round and recorded for the cut (`dev/v0104-team/reports/decisions-Lead104.md`, the entry of 2026-10-08T11:28:59Z).

Read at the v0.104.0 commit: `web/packages/launcher/vitest.setup.ts` installs its in-memory stand-in only where a global store is not usable (lines 61 to 69) and has no step that puts the page's own stores on the global, where the workspace app's file has one (`pageStorage` and the loop after it, lines 66 to 88); the launcher has no `vitest.setup.test.ts`; its header still says "The workspace app carries the same shim" and that `sessionStorage`, "which Node does not claim, comes through as a real jsdom Storage", the sentence that the measurement in the workspace app's package showed false under Node 26. The launcher loads the file through `setupFiles` in a jsdom environment (`web/packages/launcher/vite.config.ts`, lines 113 and 115). A search of `web/packages` for `Storage.prototype` finds four files, all in the workspace app (the setup file, its pin and the two test files the author named), so the author's search still holds at the release.

Not established: what the launcher's test page's stores are under Node 26. The measurement (`dev/v0104-team/evidence/Frontend104/item8-web/storage-cause-1.log`) ran in the workspace app's package under Node v22.23.3 and v26.7.0, and no record read here runs the launcher's suite, or a probe inside it, under Node 26. The gate runs the pinned Node 22, under which the workspace app's repair redefines nothing, so nothing here is a failure on the gate's path. The release report (`team/release/release-v0.104.0.md`, Follow-ups) words this follow-up as "Add a blind test for the launcher's storage setup"; in the records it rests on, "blind" describes a test that passes without looking and the finding is that the launcher has none today, so this item is written as the missing repair and pin and not as a kind of test to add.

## Desired contract

The item asks for a measurement and a decision. The choices: the launcher's setup gets the same page-store step with a pin of its own, so that a launcher test that spies on the global `Storage` reads the same under every Node the suites run on; or the launcher's setup stays as it is, with the reason recorded (no launcher test spies on the prototype). Either way the file's header says what is true of it.

## What to do

Measure first, in a guest with the pinned Node and Node 26 side by side, as the workspace app's cause run did: in the launcher package, what `globalThis.sessionStorage` and `globalThis.localStorage` are under each (the page's store, Node's own, or the stand-in) and whether each is an instance of the global `Storage`. Run the launcher's suite once under Node 26 and keep what it answers. Then put the two choices to the lead. If the repair is chosen, its pin comes first and is shown red under Node 26 before the setup changes, as the workspace app's was.

## Boundaries

`web/packages/launcher/vitest.setup.ts` and a new `web/packages/launcher/vitest.setup.test.ts`. Not changed: the workspace app's setup and its pin, any launcher product file, the pinned Node, and the launcher's existing tests.

## Acceptance

1. A record of the launcher test page's two stores under the pinned Node and under Node 26: what each global is and whether it is an instance of the global `Storage`, with the Node versions printed by the run.
2. One whole run of the launcher's suite under Node 26 with its result kept, green or red.
3. The decision recorded here.
4. If the repair: a pin in the launcher package, red under Node 26 on its own message before the setup changes and green after, and green under the pinned Node at both commits.
5. In either case the header of `web/packages/launcher/vitest.setup.ts` says what acceptance 1 found and no longer says that the workspace app carries the same shim, unless it then does.
6. `make web-check` green at the commit in the owning guest.
