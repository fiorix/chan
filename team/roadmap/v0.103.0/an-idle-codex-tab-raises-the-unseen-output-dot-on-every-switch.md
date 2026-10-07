# An idle Codex tab raises the unseen-output dot on every switch

Status: accepted for v0.103.0 rc1 by the owner's report of 2026-10-07; the fix is being built.

## Report and diagnosis

On 2026-10-07 the owner reported, with a screenshot of the inactive tab's orange dot, that an idle Codex terminal tab raises its unseen-output dot as soon as he switches away, every time; his Claude tabs do not. Desktop reproduced the Codex behavior with the xterm.js backend at base `939ecf376` and recorded the diagnosis in `dev/v0103-team/reports/report-Desktop103-terminal-dot-diagnosis.md`, `dev/v0103-team/tasks/task-Desktop103-Lead103-129.md`, and `dev/v0103-team/evidence/Desktop103/terminal-dot/`.

Codex 0.160.1 enables focus reporting with `ESC [ ? 1004 h`. On each of four measured switches away, xterm.js sent `ESC [ O` to the pty and then `focus false` 1 to 2 ms later; Codex answered 20 to 104 ms later with thirty control bytes that drew no visible character. The server counted zero unseen bytes and sent no `activity` frame, but the client's `recordOutputActivity()` in `TerminalTab.svelte` raised the dot on that raw chunk while the tab was unfocused. A stand-in without focus reporting and a quiet shell raised no dot; a shell that printed after the switch raised it through the server's count. Captured frames ruled out periodic output, a resize on blur and replay on blur. This capture used xterm.js; the ghostty-web backend remains a separate browser acceptance path.

## Fix

The terminal tab raises the dot only from the server's `activity` and `session` frames; a raw output chunk only keeps an already raised dot pulsing. After reload, replayed history therefore no longer marks every unfocused terminal: the `session` frame's unseen count decides. The server's counting rule and its protocol stay unchanged.

## Open second mechanism

A stand-in TUI that repainted the same screen on blur emitted 337 visible bytes, which the server counted as unseen and which this fix does not suppress. No seat measured a signed-in Codex composer, so whether it repaints this way is for the owner to observe on his own tab. Desktop sized two possible follow-ups in its diagnosis: a server-side window after focus-out, about 30 lines but liable to hide real output arriving in that window, or a client-side comparison with the viewport at blur, about 150 lines across both backends and a change to how the client uses the server's count. The owner will decide whether either is needed after the first fix.

## Acceptance

1. Browser capture on the fixed build names both xterm.js and ghostty-web and shows, on each backend, no dot after two switches away from an idle Codex tab and a dot for a shell that prints after the switch.
2. `make web-check` is green.
