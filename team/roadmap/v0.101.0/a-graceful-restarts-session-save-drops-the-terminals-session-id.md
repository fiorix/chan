# A graceful restart's session save drops the terminal's session id

Status: raised during v0.101.0 on 2026-09-25; not accepted. From the terminal replay lane's third-round report (`dev/v0101-tasks/report-term-3.md`, section 4), a source reading against that lane's tip `7783626df`; not observed in a browser.

## What was seen

On `closed{shutdown}` the SPA's terminal tab clears its session id (`clearTerminalSession`) and only then schedules a session save. The serialiser emits `tsid` only while the id is set, so any save that runs after that handler writes the terminal without its session id, and a terminal-only window falls to the structure-only blob the code documents as "recreate it with fresh shells". Whether the reloaded window reattaches to the restored PTY therefore depends on a race the code does not order: if the tsid-less save reaches a server (the old process before it goes down, or the new one through the pagehide flush) before the reload's bootstrap reads the blob, the tab restores without a `tsid`, spawns a fresh shell, and the restored PTY is left with no tab attached. The replay e2e cannot see this, because its keep client holds its session id across the shutdown frame.

## Desired contract

A session save made because of a devserver shutdown keeps the terminal's session id, so the reload reattaches to the restored PTY whichever save lands first.

## What to do

In the shutdown arm, keep the id on `closed{shutdown}` or skip the save that arm schedules; a test drives the arm and asserts the next serialised blob still carries `tsid`. Reproduce in a browser or a mounted test against a restarting devserver if the harness allows it.

## Boundaries

`web/packages/workspace-app/src/components/TerminalTab.svelte` (the `closed` arm) and the session serialiser's tests. It belongs with the SPA hand-off of `a-failed-dial-makes-the-next-replay-from-zero`.
