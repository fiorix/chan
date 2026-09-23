# A terminal moved to another window loses most of its tab state

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A terminal moved to another window arrives with the state a reload would restore, and a payload from an older build still reattaches the shell.

## What was seen

A session-preserving move of a terminal to another window keeps the shell and drops the tab. `crossWindowPayload` in `web/packages/workspace-app/src/components/Pane.svelte` sends five things for a terminal: its title, its session id, the environment tab name, its group and its working directory. `reattachTerminalInPane` in `state/tabs.svelte.ts` builds a fresh tab from those five in the target window and sets `controlledTerminal: undefined` outright. Everything else the tab carried stays behind: the profile, the keyboard protocol, the Rich Prompt draft path with its caret and height, a pending prompt, and the Team Work configuration. A team member's terminal dragged to a second window is an ordinary terminal when it arrives.

It is the contract of the tab-reorder item over a different mechanism. That item is about an in-process clone, which can carry a reference. This path crosses a window, so it has to serialize, and the window on the other side may be running an older build.

The graph, browser and dashboard kinds already cross with a `SerTab` snapshot (`crossWindowTabSnapshot`), and `SerTab` already has a slot for each of the lost terminal fields.

## Desired contract

A terminal that moves to another window arrives with the state a reload of the same tab would restore. A field is dropped by a decision written where the payload is built, never by omission. A window that receives a payload without the snapshot, from an older build, still reattaches the shell as it does today.

## Boundaries

`components/Pane.svelte` (`crossWindowPayload`), `state/tabs.svelte.ts` (`reattachTerminalInPane`, `TerminalMovePayload`) and their tests. The file and extension payloads are as thin, with a milder consequence because the drop reopens by path and reloads; they are named here so the fix does not pretend they are covered, and they are outside this item. No Rust change: the session is preserved by the shared terminal registry already.

## Acceptance

1. A test moves a terminal tab that carries every optional field through the payload and the reattach, and asserts each field the contract carries, and each deliberate drop by name.
2. A payload with no snapshot reattaches with today's five fields and does not throw.
3. A Team Work terminal moved across windows still reads as one in the target window, asserted on the field the Team Work surface reads.
4. Each case is a behavioural test on the payload and the rebuilt tab, not an assertion on source text.
