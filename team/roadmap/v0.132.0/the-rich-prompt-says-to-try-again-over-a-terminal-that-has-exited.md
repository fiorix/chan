# The Rich Prompt says to try again over a terminal that has exited

Status: accepted for v0.132.0 by the owner on 2026-11-16, by survey ("Take all my recommendations (recommended)", answering `dev/v0131-team/reports/owner-candidates-6.md`); not started.

Record: note 4 of the third terminal milestone review of v0.131.0 (`dev/v0131-team/reviews/terminal-milestone-3.md`) and item 2 of `owner-candidates-6.md`. Before v0.131.0 a refused submit showed nothing; v0.131.0 added the note, which says "try again" whatever the cause (browser check 290, `RichPrompt.disconnected.test.ts`). Cosmetic: the text stays in the composer.

## What is there now

Read at `f453b0b2e`, by reading; not run.

- A submit the terminal's prompt sink refuses shows "terminal not connected; try again" (`web/packages/workspace-app/src/components/RichPrompt.svelte:646-651`) for five seconds (`showTransientNote`, `:415-422`, `TRANSIENT_NOTE_MS` at `:175`) and keeps the text in the composer; a later successful submit clears the note (`:652-656`). The sink refuses whenever the terminal's socket is not open (`web/packages/workspace-app/src/components/TerminalTab.svelte:2225-2229`, reached through `sendPromptToTerminal`, `web/packages/workspace-app/src/state/tabs.svelte.ts:3035-3044`), and it answers only true or false, so the composer cannot tell why.
- After an `exit` frame the tab's status is `exited` (`TerminalTab.svelte:1971-1986`): the session id is cleared, the terminal prints "process exited; press Ctrl+D to close this tab", and the socket's close does not redial (`:2012-2019`). Every retry is refused the same way until the terminal is restarted with Restart terminal (`app.terminal.restart`, `web/packages/workspace-app/src/state/commands/terminal.ts:128-150`, which asks no confirmation for an exited terminal).
- A `closed` frame for any reason but `explicit` also sets the status to `exited` and stops the redial (`TerminalTab.svelte:1937-1970`).
- `web/packages/workspace-app/src/design.md:189` and the manual's Rich Prompt page (`web/packages/marketing/src/pages/manual/prompt.html:61`) describe the one note: submit again after the terminal reconnects.

## Desired contract

1. A submit refused because its terminal has exited shows, in place of "terminal not connected; try again" and for as long as that note shows, a note that says the terminal has exited and names Restart terminal. The text stays in the composer, editable.
2. A submit refused while the socket is down and redialling shows "terminal not connected; try again", as today.
3. After a restart a submit goes as it does on any connected terminal, and a successful submit clears the note, as today. The composer does not submit by itself after a restart.

## Boundaries

- The refusal in `RichPrompt.svelte` and what tells it that the terminal has exited (the prompt sink's answer or the tab's state), with their tests, the design note and the manual's line.
- A session the server ended with a `closed` frame also leaves the tab `exited` with no redial; whether its note is the exited one or names the ended session is read at the build and recorded here.

## Acceptance

1. Mounted tests on both backends, red at the base: after an `exit` frame a submit shows the exited note and keeps its text; with the socket closed and redialling, a submit shows the not-connected note as today. The cases of `RichPrompt.disconnected.test.ts` stay green.
2. Removing the exited check turns the exited case red, and restoring it turns the case green.
3. A browser check in a guest, on both backends: a terminal's program exits; a submit from its composer shows the exited note and keeps its text; after Restart terminal a submit reaches the new shell.
4. `web/packages/workspace-app/src/design.md` and the manual's Rich Prompt page say which note shows when.

## Closing

Recorded 2026-11-17, fix round 1. Restart terminal hands the keyboard to the new terminal; the retry returns focus to the composer first with a click, and the check pins it. A session parked for a devserver restart keeps the not-connected note: the tab's session id is kept, no redial is armed, and the exited note is not shown.
