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
