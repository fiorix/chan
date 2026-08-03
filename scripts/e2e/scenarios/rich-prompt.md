# Rich Prompt

End-to-end expectations for composing a terminal prompt, sending it through the prompt queue, stopping a send, and restoring all of that after a reload. Owner-run: see [`../README.md`](../README.md) for the model and the rules that apply to every run.

Each scenario states behavior that must hold today. Where an executable check or test already proves it, that check is named under **Backing**; where none exists, the scenario says so and stays manual.

## What this covers

- a prompt is composed in a real per-terminal draft file, so it is never held only in browser memory;
- the composer reconstructs in every state after a reload: editing, sending, and sent;
- stopping a send always returns the prompt to the composer and never discards it, by any of the three routes that stop one;
- pasted images and media render in the composer while only their absolute on-disk paths reach the agent;
- any client may stop any still-queued message, including one another client sent;
- the composer is co-viewed: its open state, its draft, and its pending state match on every client watching the terminal;
- exactly one path discards a draft, and it is explicit.

## When to re-run

Look up the area you changed and run the scenarios listed against it.

- **Composer, keymap, or control strip**: RP-01, RP-04, RP-07, RP-08
- **Draft persistence and the `.Drafts` tree**: RP-02, RP-03, RP-07, RP-08
- **Pending-prompt machine and queue wiring**: RP-01, RP-03, RP-04, RP-06
- **Image paste and delivery rewriting**: RP-05
- **Anything that touches mount-time restoration**: RP-02, RP-03
- **Session frames, `queued_prompt_ids`, or cancel handling**: RP-06, RP-08
- **Composer visibility or its co-viewed state**: RP-08

## Scenarios

| ID | Scenario | Kind |
| --- | --- | --- |
| RP-01 | Compose and submit | mixed |
| RP-02 | A draft survives a reload while editing | mixed |
| RP-03 | A reload while sending reconstructs the pending state | mixed |
| RP-04 | Stopping a send returns the prompt to the composer | mixed |
| RP-05 | Pasted media renders locally and delivers as paths | automated |
| RP-06 | Stopping a message another client queued | manual |
| RP-07 | Abandoning a draft | mixed |
| RP-08 | The composer matches across clients | manual |

The automated coverage that exists today runs from two places. The component cases run under the normal frontend test command from `web/packages/workspace-app`; the browser cases run through the smoke harness:

```sh
SMOKE_ONLY=104 node scripts/e2e/browser-smoke/run.mjs
```

---

### RP-01 - compose and submit

**Expectation.** Typing in the composer writes a real per-terminal draft to disk rather than holding the text in browser memory. `Mod-Enter` and the control strip's submit control are the same action: both deliver the backing text through the terminal's prompt queue using the agent's own submit chord, lock the composer, and surface the queue depth. Neither route can submit a blank composer, and the strip's control is visibly inert in that state rather than merely refusing on press.

**Run.** Open a terminal with an agent that is already trusted in the workspace, open the composer, type, submit once by chord and once by control, and read the agent's scrollback for each.

**Backing.** `104-rich-prompt-paste-submit.mjs` covers the chord path. The control path and the blank-composer refusal are covered at component level by `richPromptPendingMachine.svelte.test.ts`. No browser check drives the control yet.

**Evidence.** The draft file on disk after typing, the agent scrollback after each submit, and the strip's rendered state before and after.

### RP-02 - a draft survives a reload while editing

**Expectation.** Text typed and not submitted is on disk and returns to the composer after a reload, with the caret position and the bubble height the user left it at. An image pasted before the reload still renders after it. Reloading is not a discard.

**Run.** Type into the composer, paste an image, resize the bubble, move the caret off the end, reload the window, and compare.

**Backing.** Caret and height persistence are pinned by `richPromptCaretPersistence.test.ts`. No browser reload check exists.

**Evidence.** Draft file contents, restored caret offset and bubble height, and a screenshot showing the rendered image after reload.

### RP-03 - a reload while sending reconstructs the pending state

**Expectation.** Reloading while a prompt is in flight restores the pending state, not an editable composer. The restored composer is locked, the strip shows the queue depth and the stop controls, and the restored bubble can stop the send. This holds in both pending states: sending, meaning submitted and awaiting acknowledgement, and sent, meaning acknowledged and queued at the agent.

It holds even when the restored draft is blank. That combination is degraded rather than expected, and the composer must still be able to leave it: a blank draft is never a reason to hide the bubble or to strand a queued message with no way to stop it.

**Why this is load-bearing.** The queued message is real work already handed to an agent. A window that reloads into a state where it can see the queue but not reach it leaves the user watching an agent act on a prompt they can no longer stop.

**Backing.** `cancelling a prompt restored from a blank draft keeps the composer` in `richPromptPendingMachine.svelte.test.ts` covers the blank-draft case at component level. No browser reload check exists for either pending state.

**Evidence.** The strip's rendered state after reload, the result of stopping from the restored bubble, and the agent scrollback proving the message did or did not arrive.

### RP-04 - stopping a send returns the prompt to the composer

**Expectation.** While sending or sent, all three stop routes behave identically: `Escape`, `ArrowUp`, and the strip's stop control each take the message off the queue and return the composer to editing with the prompt text intact. None of the three discards the text and none hides the bubble. After a stop the composer is editable, the strip offers submit again, and submitting again re-queues the same prompt.

**Why this is load-bearing.** The text is the user's work, and a prompt can be long. A stop that silently empties the composer is indistinguishable from a crash, and there is no undo.

A blank draft is the one honest exception. When the message is queued but its draft is empty, as RP-03 describes, there is no text to return and the stop correctly leaves an empty composer. The stop itself must still work: that case is a degraded restoration, not a failed stop.

**Run.** Submit, then stop by each of the three routes in turn, checking the composer contents and the agent scrollback after each.

**Backing.** The control route is covered by `richPromptPendingMachine.svelte.test.ts`. `ArrowUp` retention is covered there too. `Escape` retention is not yet covered by any check.

**Evidence.** Composer contents after each stop route, the strip's rendered state, and scrollback proving the stopped message never reached the agent.

### RP-05 - pasted media renders locally and delivers as paths

**Expectation.** Pasting an image or media file into the composer embeds it as markdown and renders it immediately. On submit, only the bare absolute on-disk path reaches the agent, while the composer keeps showing the embed. A recall after a stop restores the markdown embed, never the delivered path form.

**Run.** Browser check `104-rich-prompt-paste-submit.mjs`.

**Backing.** That check.

**Evidence.** The delivered text as the agent received it, and a screenshot of the composer still showing the embed.

### RP-06 - stopping a message another client queued

**Expectation.** The depth a composer shows describes the terminal's queue, not this window's history, so messages queued by `cs terminal write` or by another window raise it. Any client may stop any still-queued message, including one it did not send: the stop addresses the message by its `prompt_id`, taken from the session frame's `queued_prompt_ids`, and the server's removal broadcast converges every attached client. A message that already drained to the PTY is honestly refused rather than recalled, and the client that submitted it treats the refusal as a delivery.

**Why this is load-bearing.** A queued prompt is work already handed to an agent, and the window that sent it may be closed, reloaded, or on another machine. Tying the ability to stop it to one browser's memory means a message that everyone can see is one that nobody can reach.

**Run.** Open the same terminal in two browser windows. Start a slow loop in the terminal so a submitted message sits in the queue rather than draining. Compose and submit in window A, then stop it from window B, once by `Escape` and once by the strip's control. Read the depth in both windows and the agent's scrollback after each.

**Backing.** The server side is covered: `routes/terminal.rs` pins the `cancel-prompt` and `prompt-cancelled` frames and the cancel-after-delivery refusal, and `terminal_sessions.rs` covers `queued_prompt_ids` FIFO ordering. No two-client browser check exists, and the client does not yet read those ids.

**Evidence.** Both windows' rendered depth before and after each stop, the `prompt-cancelled` outcome including one refusal after drain, and scrollback proving a stopped message never reached the agent.

### RP-08 - the composer matches across clients

**Expectation.** The composer is a co-viewed surface, not a per-browser overlay. Opening or closing it on one client opens or closes it on every client viewing that terminal. Its draft converges in both directions while both clients type, and its pending state matches, so a message submitted in one window shows as queued in the other with the same stop controls. Both clients resolve the one per-terminal draft file rather than each minting its own.

**Run.** Open one terminal in two windows. Toggle the composer in A and observe B. Type in A and observe B, then type in B and observe A. Submit in A against a slow loop and read B's strip. Compare the draft path each window resolved.

**Backing.** None. Visibility, the draft path, and the pending record are per-client today, and the composer's editor has no document-session wiring, unlike `FileEditorTab`.

**Evidence.** Screenshots of both windows at each step, the draft path each resolved, and the draft file on disk.

### RP-07 - abandoning a draft

**Expectation.** `Escape` on an editable composer with nothing queued clears the draft and hides the bubble. This is the only path that discards prompt text, and it is reachable only from the keyboard. Reopening the composer afterwards presents an empty draft rather than the discarded text.

**Run.** Type into the composer, press `Escape` with nothing queued, reopen the composer, and inspect the draft file.

**Backing.** `Escape on a plain editable draft still abandons and hides` in `richPromptPendingMachine.svelte.test.ts`.

**Evidence.** The draft file after the abandon and the composer contents after reopening.

## Standing decisions

- **The terminal's queue is the authority, not any client's memory.** The server already broadcasts `queue_depth` and `queued_prompt_ids` to every attached socket and cancels by `prompt_id`. A composer reads that rather than keeping a private record of what it personally sent.
- **A pending prompt whose draft is blank is handled, not prevented.** The draft is a real file that any agent may read, so anything may empty it, and a post-submit draft write that fails is discarded silently by design. The composer therefore treats the state as reachable and must always be able to leave it. RP-04's text restoration is the only part that degrades.
