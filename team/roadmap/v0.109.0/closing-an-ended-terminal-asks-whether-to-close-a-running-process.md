# Closing an ended terminal asks whether to close a running process

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the frontend seat's reproduction of the sessionless move (its hand-back 12 in the round's bus); closes in the round.

## What was seen

Closing a terminal tab whose process has exited, or whose session never started, asks "<title> is still running. Close anyway?". `closeRisk` in `web/packages/workspace-app/src/state/tabs.svelte.ts` calls a terminal live when `isLiveTerminal` finds its input sink, and every mounted terminal component registers one, ended or never started; the message names a process that is not running. The same test lets a tab that holds a session but no mounted sink, which a render boundary's caught throw leaves behind, close without the confirm, its session killed through the close route. Seen in Chrome for Testing 156 with the xterm.js backend on an exited shell, an exited command terminal and a tab whose server had not answered.

## Desired contract

A terminal with no live session closes without a confirm; the confirm and its words are for a terminal whose session is running.

## What to do

`isLiveTerminal` reads the tab's session id alone, so the confirm guards exactly the closes that kill a session (both kill paths key on the session id) and a terminal that holds none is not live; the single and multi-tab messages change together through `confirmCloseTabs`, whose count then excludes ended tabs; pins red first for an ended terminal and a never-started one, the live case unchanged, and a tab with a session and no mounted sink still asking.

## Boundaries

`state/tabs.svelte.ts` at `isLiveTerminal` and `closeRisk`, and their tests. Not changed: the confirm for a live session, the sessionless cross-window move's own close.

## Acceptance

1. Pins red first at the parent for the ended terminal and the never-started one, each asked there, and for a tab with a session and no mounted sink, closed there without asking; the live case's pin green; one mutant (the session id read dropped) red.
2. `make web-check` green at the commit.
