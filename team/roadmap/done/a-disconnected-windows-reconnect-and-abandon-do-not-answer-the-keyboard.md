# A disconnected window's Reconnect and Abandon do not answer the keyboard

Status: shipped in [v0.113.0](../../release/release-v0.113.0.md); the sections from Build findings and evidence on hold the evidence, the owner's acceptance last.

Record before the release: accepted for v0.113.0 by the owner's word of 2026-10-27; implemented on `v0113/b-keys` and verified by the owner on 2026-10-27.

## What was seen

The owner's words of 2026-10-27: "when the chan-desktop disconnects from a devserver, we show a spinner window retrying and we show the buttons abandon and retry.. i think i cannot press enter with the keyboard in those because we disabled typing somehow.. i want to be able to navigate there with the keyboard to hit enter on retry, abandon".

Read at `dfc2f2a2f`, paths under `web/packages/workspace-app/src/` unless named:

- The window the owner describes is `components/DisconnectOverlay.svelte`: a full-window `alertdialog` with a spinner, "reconnecting to the chan server", the attempt and the time elapsed, and on a devserver window of chan-desktop the buttons Reconnect and Abandon. When it shows, it focuses Reconnect (line 131), its own keydown handler moves Tab and Shift+Tab between the two buttons, and it raises the `reconnect` cover (line 92).
- `App.svelte`'s window key handler (line 670): while any cover is raised, it cancels every keydown aimed at the app with `preventDefault` and `stopPropagation`, letting through only Cmd+` and unmodified keys typed into a text field on the cover's own surface (`coverOwnsTextEntry`, `state/store.svelte.ts` line 408). Its comment reads: "A cover's buttons need no exception: a button acts on its click, which the keydown's default does not carry." For a focused button that is the wrong way round: the click Enter produces is the keydown's default action, so cancelling the keydown cancels the press. Focus therefore reaches Reconnect, Tab reaches Abandon because the overlay handles Tab before the window does, and Enter does nothing, as the owner found.
- The same block covers every button on a raised cover: the preflight overlay's decision buttons and the screensaver's Unlock button as well as Reconnect and Abandon.
- `components/DisconnectOverlay.recovery.test.ts` presses the buttons with `.click()`, so no test has pressed them from the keyboard; jsdom does not turn an Enter keydown into a click, so a test of the keyboard path needs a real browser.
- The desktop's own connecting screen (`desktop/src/connecting.js`) is a separate page: its Retry and Disconnect appear when its retry loop gives up (`showGaveUp`, line 190), and its key handler cancels only Cmd+W, Ctrl+W and Ctrl+D, so Enter reaches them; focus is not moved to Retry when they appear, so a keyboard user starts from the page body.

Not established: the overlay was not driven in a browser for this reading, so the cause rests on the code and on how browsers activate a focused button; whether Space, whose activation also begins at its keydown, fails the same way was not checked.

## Desired contract

On any raised cover, the keyboard can reach and press the cover's own buttons: focus lands on the primary action, Tab and Shift+Tab move between the actions, and Enter and Space press the focused one. Every other key is still stopped from reaching the app behind the cover. When the connecting screen's Retry and Disconnect appear, Retry takes focus, so Enter retries at once.

## What to do

1. A red test in a real browser first: a browser check that raises the disconnect overlay on a page that presents itself as a chan-desktop window of a devserver library (a stub desktop bridge before load), presses Enter on the focused Reconnect, then Tab and Enter on Abandon, and asserts each reached the desktop, with Space likewise; the same for the connecting screen's Retry if it can be served.
2. `App.svelte`'s cover branch, beside `coverOwnsTextEntry`: let Enter and Space through when the target is a button inside the raised cover's own root, and correct the comment on how a button is activated.
3. `desktop/src/connecting.js`: focus Retry when the gave-up actions appear.
4. One mutant per guard (the button exception, the cover-root containment), each failing the check.

## Boundaries

`App.svelte`'s cover branch, `state/store.svelte.ts` for the exception's helper, `components/DisconnectOverlay.svelte` if its focus handling changes, `desktop/src/connecting.js`, a new browser check and its helpers, and the overlay's tests. Not changed: what a raised cover blocks otherwise, the reconnect loop, Abandon's and Reconnect's calls to the desktop.

## Acceptance

1. In chan-desktop, with a devserver window disconnected, Enter on the focused Reconnect starts a reconnect, and Tab then Enter on Abandon abandons; no key reaches the editor or terminal behind the overlay.
2. The connecting screen's Retry takes focus when it appears, and Enter retries.
3. The browser check fails before the change and passes after; `make web-check` green.

## Build findings and evidence (2026-10-27)

- Real Chrome check `184-cover-keyboard.mjs` reproduced the failure before the guard change: Enter and Space each failed to invoke both Reconnect and Abandon (`/tmp/lane-b-covkey-red3/results.json`). Space fails the same way as Enter.
- The guard preserves native activation only for Enter or Space on an enabled button inside a registered, raised cover. Modifiers, other keys, background buttons and unraised roots remain blocked. Five parameterized unit cases failed before the exception and pass with it.
- Chrome exposed native focus loss when a recovery action disables its focused button. Once the action settles, focus returns to that action while the overlay remains visible.
- The preflight cover now focuses its first enabled decision and cycles its decisions with Tab and Shift+Tab. The PIN cover's cycle includes Unlock. The desktop connecting page focuses Retry at give-up.
- Browser green: `/tmp/lane-b-covkey-green5/results.json`, Enter and Space on Reconnect, Abandon, both preflight decisions, Unlock and connecting Retry; a stale background button remains inert. Component checks: 62 tests passed across the full-cover contract, preflight and recovery suites.
- Native desktop acceptance remains for the owner's build test.
- Both browser mutants fail as required: removing the button exception blocks all four recovery activations (`/tmp/lane-b-mutant-button/results.json`); removing raised-cover containment activates the planted background button (`/tmp/lane-b-mutant-containment/results.json`). Exact source restored and the workspace bundle rebuilt after the mutants.
- `make web-check` passed: web-shared 230, launcher 693, workspace-app 7819 and profile 20 tests; all Svelte checks clean. Final lane verification reruns after all rows.

## Final verification

At code commit `2c76066b7`, the complete frontend gate passed (230 shared, 702 launcher, 7823 workspace-app and 20 profile tests, all Svelte checks clean). Check 184 passed alone and after the close-pane check. Both macOS desktop and aarch64 Linux musl builds passed and contain every current workspace and launcher JavaScript asset byte-for-byte. The desktop also contains the compressed connecting-page asset with Retry focus; its bundle signature verifies. Native owner acceptance remains pending; neither app launch nor guest installation was performed.

## Owner acceptance (2026-10-27)

The owner tested the isolated native preview running build `git-2c76066b747b` on macOS with the matching Linux devserver and confirmed: "i tested, it works! i tested, you can commit and push to the branch, and clean up the local use here, we need to free up space". Native acceptance is complete; the owner authorized the branch push and removal of the isolated preview and generated build artifacts.
