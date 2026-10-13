# A CLI-opened terminal reloaded before its socket opens restores a plain shell under the name

Status: raised for v0.106.0 at the v0.105.0 GA on 2026-10-11, from the osc7501 round's record (Web task 10, the bound of the synchronous hash save); written down, not designed, not accepted for build.

## What was seen

Since v0.105.0 the CLI terminal-open path writes the window's layout hash synchronously, so a reload at any moment finds the tab in the layout (the owner's word, survey 8 of the round). The hash names tabs and carries neither a session id nor the spawn command and environment that `cs terminal new` passed, which `state/tabs.svelte.ts` marks as not persisted at the fields. So a reload that lands before the tab's terminal socket has opened restores the tab as a fresh default shell under the CLI's name, without the command and environment; a reload after the session frame has arrived re-attaches the same session from the exit flush's blob or the reload snapshot. Check 129 hits the first case by design (the reload 82 to 87 ms after the command) and passes on the recovered tab; it does not verify the session's identity. Before v0.105.0 either reload dropped the tab.

Not established: how often a human reload lands inside that window; whether the team bootstrap's seat spawns (an agent command per tab) can meet it.

## Desired contract

A tab opened by `cs terminal new` with a command survives a reload at any moment as that command's session, or the restore says plainly that it opened a plain shell in its place.

## What to do

Decide between persisting the spawn command and environment in the reload snapshot for a tab whose socket has not opened (the hash must not carry them: it is shared), and a restored tab that shows its loss; then pin the chosen behaviour with a test at the store level and a browser check that reloads before the socket and reads the restored session's command, red first.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the CLI open branch and the reload snapshot), `state/tabs.svelte.ts` (the serialization), the restore constructors and their tests; check 129 or a sibling. Not changed: the shared layout hash's content.

## Acceptance

1. The decision recorded here.
2. If persistence: a reload inside the window restores the same command and environment, proved by a browser check that reads them back, red first; the snapshot carries nothing to the shared hash.
3. If a visible loss: the restored tab says it opened a plain shell, proved the same way.

## The constructed case and the lead's decision 2026-10-13

By the frontend seat in its guest at `31513a64f` on its branch, no product change (`tasks/task-Frontend106-Lead106-30.md` in the round's bus; the development check `evidence/Frontend106/clirld-development-check.mjs`): headless Chrome for Testing 155.0.8059.39 against a debug build of that tip. The first terminal socket's constructor was held before it opened; `cs terminal new` with a command and one environment value queued the tab; the held first query carried that command and environment while the server listed no session for it; the shared hash, written synchronously, carried the tab's kind, name and active bit and neither spawn value, and `sessionStorage` held no reload snapshot. After a reload the restored tab's first terminal query had no command, no environment and no session; a new session appeared under the tab's name with no derived agent and answered a typed `printf`, and the original command's marker never printed. At source: the CLI branch copies the command and environment into the live tab alone (`store.svelte.ts` 2038 to 2057; `tabs.svelte.ts` 1816 to 1839), the terminal serializer writes neither in the hash or in the per-window session payload (7084 to 7140; `store.svelte.ts` 3417 to 3458), and the same-tab reload snapshot is written only once a terminal has a session id (5000 to 5043). The constructed case is shown; how often a person meets it is not measured.

Acceptance 1, the lead's decision: a visible loss, not persistence. Persisting the command and its environment would put values a caller may mean to keep private into browser storage, and a reload that lands after the server created the terminal but before its session frame reached the page would need a rule that keeps the command from being started twice, which crosses the server's session boundary. The restored tab keeps opening a plain shell and says so: a marker that carries no command and no environment travels with the tab through the same-window reload, and the restored tab shows a notice that the command it was opened with was not run. The design goes to the review seat before code; acceptance 3 is the build's, with a store test and a browser check that reloads before the socket opens, red first.
