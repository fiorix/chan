# The app terminal keeps write scaffolding built for xterm.js and spreads its redial decision over six sites

Status: accepted by the owner on 2026-11-26 as a cleanup for the next version, with no change of behaviour (the last section); not started. Not built in v0.135.0 (D126 item 1); the owner set it for the next version.

Record: the first review of the xterm.js removal listed what exists only because a second backend did (`dev/v0135-team/reviews/review-u2-removal-1b.md`, "The shape left", S1 to S6), and the lead ruled S1 to S6 "a follow-up row after the sweep" (`dev/v0135-team/decisions.md`, D60). The cumulative read of the app terminal found that row unwritten and the scaffolding still there (`dev/v0135-team/reviews/review-cumulative-app.md`, S2), and answered its lens question, whether the redial and cut decision can be one pure module (S3). Under D113 the secret-mask scan scheduling and the write guards a synchronous writer cannot reach were removed (merged at `fbf524373`), and the rest was left to a row; [the xterm.js row](chan-carries-xterm-js-as-a-second-terminal-backend.md) says so ("Not built, and left for a row of its own", in "The sweep's last cleanup, 2026-11-26").

## What is there now

Read at `aabb9d039`, by reading. Paths are under `web/packages/workspace-app/src/`.

- The widget's write parses synchronously, so the tab's writer calls its completion inside the same call (review-u2-removal-1b S1; review-cumulative-app S2). Around it remain:
  - `PtyWriteTracker`'s queue of write origins and its completion callback, and `TerminalByteWriter` (`terminal/connection.ts:1-43`), held by the tab (`components/TerminalTab.svelte:616`, `:640`), with the optional `onComplete` chain of the tab's write helper (`:2335-2346`).
  - The nullable fields set together when a terminal opens (`openTerminal`, `:1341`) and cleared together in `teardown` (`:2656`), each null-checked on its own: ten by the first review's count (1b S2), fourteen by the cumulative read's (S2).
  - The inverted key-handler contract: the clipboard chord's result is converted "before TerminalTab applies the widget's inverted custom-handler contract" (`terminalClipboardKeyHandlerResult`, `terminal/clipboardChord.ts:42-50`, used at `TerminalTab.svelte:3158`).
  - Thin wrappers and lowest-common-denominator types: `terminalTheme` beside `ghosttyTerminalTheme` (`:951`, `:1057`), `refreshTerminalRows` (`:1074`), `handleTerminalData` (`:2434`), `FitLike` (`terminal/resize.ts:1-7`), `GhosttyViewportController.write` as a pass-through (`terminal/ghosttyViewport.ts:39`), and `applyGhosttyTheme`'s boolean result (`terminal/ghosttyTheme.ts:16`), which the cumulative read found only tests read.
- The redial and cut decision lives in six places over about eleven variables (S3): `connect` (`:1605`), the binary message path, the session frame, `ready`, `closeSocket` (`:2625`) and `teardown`; its state is `receivedSeq`, `serverGeneration`, `sawSessionControl`, `cut`, `continuingReplay`, `attachReplayActive`, `suppressAttachReplayGeneratedReplies`, `keyboardProtocolBeforeReplay` and `missedBytes`, with `resetBeforeReplay` and `dialSawSession` per dial. The order of its reset writes (tracked modes off, the fresh-shell reset, the reset before a replay, the keyboard restore, the missed-bytes notice, CAN) is the contract, and nothing states it in one place. The tab also restates the server's resume rule in one expression.
- By the cumulative read's reading, the decision can be one pure module with no change of behaviour: every input is a frame field, the dial's own resume, the prior session id or the counters above, and the writes can be returned as an ordered list of effects; the redial tests' stand-in server could then share the client's statement of the server's rule (S3). Its mutants M8 to M15 show the current tests would hold such a refactor to the same behaviour.
- Also listed by the first review: the `ack` dial option, always set at its one caller (`terminal/session.ts:39`, `:44`; `TerminalTab.svelte:1678`), which its plan left to a server change (1b S5); and names, `backend.ts` for the loader, `snapshotCache.ts` for a sweep and the `ghostty` prefix on the only terminal, left for a later rename (1b S6).

## Desired contract

1. No change of behaviour: every redial, replay, session and terminal test passes unchanged, apart from tests that pin the scaffolding itself.
2. Writes to the widget are synchronous in the tab's code as they are in the widget: no write tracker, no completion chain, and the write's origin held for the duration of the call.
3. The open terminal's parts are one record, set and cleared together and checked once.
4. The redial and cut decision is one pure module (the cumulative read's sketch: `dial()`, `session(frame)`, `chunk(n)`, `ready()`, `close()` and `reset()`, each returning ordered effects), and the tab applies its effects. The module states the server's resume rule once, and the redial tests' stand-in server reads the same statement.
5. The inverted key-handler contract (1b S3) and the thin wrappers named above are removed, or each states why it stays.

## Boundaries

- The workspace app's terminal tab and `terminal/` modules, with their tests. The widget's public API is consumed, not changed.
- Not here: the `ack` dial option, which needs a server change (1b S5); renames (1b S6) are in scope only where they touch the modules this row moves.

## Acceptance

1. The redial, replay and session test files and the terminal's mounted tests pass at each commit, with no test changed except those that pin removed scaffolding, each change named in its commit.
2. The cumulative read's mutants M8 to M15 (or their successors on the new module) are each killed at the tip.
3. The terminal browser suite and the replay end-to-end test in an isolated guest at the tip, green as at the base.
4. A review that reads the module against the six sites it replaces.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 as a cleanup for the next version ("agree with your list, let's set 11 for later cleanup in the next version", `dev/v0135-team/decisions.md`, D126 item 1: "The app terminal's scaffolding (candidate 11) as a next-version cleanup with no behaviour change"), answering the candidate rows of the round's hand-back (`dev/v0135-team/handback.md`, section 7, "App terminal scaffolding"). Drafted as a lead document and not built in v0.135.0.
