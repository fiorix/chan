# An idle Codex tab raises the unseen-output dot on every switch

Status: shipped in [v0.103.0](../../release/release-v0.103.0.md); the owner's own observation of a signed-in Codex tab on the fixed build, the item's last acceptance line, was open at the cut.

Record before the release: built and reviewed at source for v0.103.0 rc1 by the owner's report of 2026-10-07; the integration gate, the rc1 candidate's browser runs and the owner's own observation are open.

## Report and diagnosis

On 2026-10-07 the owner reported, with a screenshot of the inactive tab's orange dot, that an idle Codex terminal tab raises its unseen-output dot as soon as he switches away, every time; his Claude tabs do not. Desktop reproduced the Codex behavior with the xterm.js backend at base `939ecf376` and recorded the diagnosis in `dev/v0103-team/reports/report-Desktop103-terminal-dot-diagnosis.md`, `dev/v0103-team/tasks/task-Desktop103-Lead103-129.md`, and `dev/v0103-team/evidence/Desktop103/terminal-dot/`.

Codex 0.160.1 enables focus reporting with `ESC [ ? 1004 h`. On each of four measured switches away, xterm.js sent `ESC [ O` to the pty and then `focus false` 1 to 2 ms later; Codex answered 20 to 104 ms later with thirty control bytes that drew no visible character. The server counted zero unseen bytes and sent no `activity` frame, but the client's `recordOutputActivity()` in `TerminalTab.svelte` raised the dot on that raw chunk while the tab was unfocused. A stand-in without focus reporting and a quiet shell raised no dot; a shell that printed after the switch raised it through the server's count. Captured frames ruled out periodic output, a resize on blur and replay on blur. This was the xterm.js capture at the base.

The base's separate ghostty-web capture (`capture-02` in `dev/v0103-team/reports/report-Desktop103-terminal-dot-diagnosis.md`) saw no focus report sent across fourteen focus changes even though Codex and the repainting stand-in enabled reporting. Neither wrote on blur or raised a dot; a shell printing after the switch still raised one through the server's count. Missing focus reports in ghostty-web remain a follow-up, not a failure of this dot repair.

## Fix

The terminal tab raises the dot only from the server's `activity` and `session` frames; a raw output chunk only keeps an already raised dot pulsing. The terminal route keeps the epoch returned when its socket says focused and, at that socket's end, withdraws focus only if the epoch is still current. A page that leaves focused therefore no longer keeps the session counted as focused, while an older socket ending after the page redials cannot undo the newer socket's focus. Before this, output after the page left was not counted as unseen for an unfocused reattach, a gap hidden by the client's old marking of every chunk. An in-place restart carries a socket's standing word of focus into the new session and keeps its new epoch; a word another socket's has replaced is not said again. After reload, replayed history no longer marks every unfocused terminal; the `session` frame's unseen count decides. The server's output-counting rule and protocol stay unchanged.

## Fixed-build capture and bounds

Desktop's `capture-03` at its five-commit tip, recorded in `dev/v0103-team/reports/handback-Desktop103-terminal-dot-range.md`, showed xterm.js still sending Codex a focus-out report and receiving the same thirty control bytes, with no dot at any mark over five switches away. The shell that printed after the switch raised a dot through `bytes_since_focus` 23; the stand-in without focus reporting raised none; the stand-in repainting 337 visible bytes still raised a dot through the server's count. The subject was Codex 0.160.1's sign-in screen in headless Chrome on Linux, not the owner's signed-in composer in the macOS desktop app.

Visible output the server reads before it receives `focus false` is unmarked unless more output follows, even if it reaches the page after the switch. This window is about one round trip, roughly a millisecond locally and tens to hundreds of milliseconds through a tunnel. Two pages can also hold sockets for one terminal session, whose focus flag is one last-writer boolean: an unfocused page has no dot while another page holds the session focused. A page that was focused, on a session another page's `focus false` has unfocused, gets no dot after its own blur until it is focused again, because the server spent its first activity announcement while that page still considered itself focused. Counting focused sockets per session in `chan-library`, with its own tests and a deadline for silent clients, is the proper close and remains a follow-up because the reported case uses one page.

## Open second mechanism

A stand-in TUI that repainted the same screen on blur emitted 337 visible bytes, which the server counted as unseen and which this fix does not suppress. No seat measured a signed-in Codex composer, so whether it repaints this way is for the owner to observe on his own tab. Desktop sized two possible follow-ups in its diagnosis: a server-side window after focus-out, about 30 lines but liable to hide real output arriving in that window, or a client-side comparison with the viewport at blur, about 150 lines across both backends and a change to how the client uses the server's count. The owner will decide whether either is needed after the first fix; ghostty-web's missing focus reports and the session's one-bit focus flag are separate follow-ups.

## Acceptance

1. The fixed-build xterm.js browser capture shows Codex's thirty invisible bytes without a dot across five switches away, a dot for the shell that prints after the switch, none for the stand-in without focus reporting, and a dot for the visible-repaint stand-in. The separately identified ghostty-web base capture records no focus reports and no Codex dot, while the printing shell still raises a dot; this is a backend limit to carry forward, not fixed-build proof for ghostty-web.
2. `make web-check` is green on the integrated candidate.
3. On the fixed build, the owner observes his own signed-in Codex tab in the desktop app and confirms that an idle switch away leaves it without a dot; the Linux sign-in-screen capture alone cannot close this check.
