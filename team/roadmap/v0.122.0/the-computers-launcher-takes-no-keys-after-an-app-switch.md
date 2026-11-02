# The Computers launcher takes no keys after an app switch

Status: raised by the owner on 2026-11-02 after the v0.121.0 tag ("when we change focus to another application and back to Chan the computer's window no longer takes input from the keyboard until you click on it").

## What is there now

On macOS, with the Computers launcher shown over a chan window, switching to another application and back leaves the launcher deaf to the keyboard until it is clicked. The launcher is a second webview over the window's own webview and takes the keyboard when shown; the window's own page refocuses its terminal when the window comes back (the wake fix), without knowing the launcher covers it.

## Desired contract

1. After an app switch and back, by Cmd+Tab or by a click on the title bar, a shown launcher takes the keyboard with no click.
2. The terminal's wake refocus keeps working when the launcher is not shown.

## Closing

Reproduced on 2026-11-02 on macOS 27.0.1 (build 26A434) with a dev build of the base: chan-desktop 0.121.0, build id git-2bde62afd2ba, `target/debug/chan-desktop` run directly under `env -i` with a throwaway `CHAN_HOME` and its own `XDG_RUNTIME_DIR`, because a bare launch beside a running chan-desktop is taken over the handoff socket. The readings below were taken by script from the Mac seat's own terminal: the switches by process activation (the AppKit activation path the Dock and the app switcher use) and by a Dock icon click, the keys through System Events, the carousel's reaction read from screenshots, and the window's focused element read through the accessibility API, which names the host terminal's element when the host webview holds the first responder and resolves nothing when the launcher's webview does. Times are GMT.

Base, 2026-11-02 16:53 to 17:03:

- a. Launcher over a ghostty terminal tab, Chrome covering the window fully, back by activation: dead. The launcher stays on screen on card 1 with its focus ring gone, Right does not move the carousel, and the focused element is the host's `terminal-host` element. The return by a Dock icon click after the same cover: dead.
- b. The same with the Finder in front and the window left visible: live. Right moves to card 2 and the focused element stays the launcher's.
- c. An xterm terminal tab (`ghostty = false` under `[terminal]` in the throwaway home's `server.toml`), covered as in a: live, Right moves to card 2.
- d. Launcher over a workspace window whose pane holds no terminal, covered as in a: live.
- e. The ghostty case with the window's body covered by a TextEdit window and its title bar exposed, back by a real mouse click on the title bar: live.

The readings settle the mechanism. Only the ghostty terminal costs the launcher its keys, and only after the window was occluded: the host page sees `visibilitychange` to visible when the window comes back from under another application, not on a bare key-window change (case b), and `recoverTerminalFocusAfterHostResume` runs. On xterm it calls `focus()` on the helper textarea that is still `document.activeElement`, a DOM no-op, and nothing moves. On ghostty it blurs the host element first (the wake fix) and the focus that follows is a real focus change, which WebKit answers by making the host's webview the window's first responder; the launcher's webview loses the keyboard until a click hands it back. A window without a focused terminal never refocuses.

What changed. chan-desktop marks the host page while its launcher shows: `launcher_transition.js` gains `hostCovered` and `hostUncovered`, which set and remove `data-launcher-shown` on the host document's root, and `launcher_panel.rs` evaluates `hostCovered` into the host before the show gives the launcher the keyboard and `hostUncovered` before the hide gives it back to the host. `TerminalTab.svelte` skips the resume refocus, the ghostty blur included, while the marker is set; the renderer recovery still runs. When the launcher hides, the desktop focuses the host webview itself, whose `focus` event runs the refocus with the marker already cleared, so the terminal takes the keyboard as before.

Tests. `TerminalTab.ghosttyBackend.test.ts`: with the host active and the marker set, a page show blurs nothing, focuses nothing and leaves the DOM focus on the host; with the marker cleared, the next page show blurs the host once and focuses the terminal. `TerminalTab.test.ts` (xterm): a page show under the marker does not call `focus()`, and the one after it does. Both are red on the base: `expected "blur" to not be called at all, but actually been called 1 times` and `expected "focus" to not be called at all, but actually been called 1 times`. In `launcher_panel.rs` the stage list test names the two new stages and `the_covered_marker_is_the_one_the_terminal_reads` pins the attribute's spelling across the script and the component.

Fixed build, 2026-11-02 17:15 to 17:22, chan-desktop build id git-2bde62afd2ba-dirty (the branch's tree before its commit), run from the branch's worktree the same way with its own throwaway home and runtime directory, beside the base instance:

- a. Ghostty terminal tab, Chrome covering the window fully, back by activation: live. The card keeps its focus ring across the switch and Right moves the carousel; the focused element stays the launcher's. The return by a Dock icon click after the same cover: live.
- b. The Finder in front with the window left visible: live.
- c. An xterm terminal tab, covered as in a: live.
- d. Launcher over a workspace window whose pane holds no terminal, covered as in a: live.
- e. The body covered by a TextEdit window with the title bar exposed, back by a mouse click on the title bar: live.

Hiding the launcher still hands the keyboard to the terminal: after the last case, a Cmd+P hid the launcher and two typed letters landed at the terminal's prompt.

Open: the owner's own step 1, 2 and 3 readings on the base and on the fixed build (the readings above are the seat's scripted ones, and the first-responder reading comes from the accessibility API, not from the console probe); a host page that navigates or reloads while its launcher shows loses the marker until the next toggle; Linux and Windows are unverified (the marker is evaluated there too, and each keeps its own focus rules for the overlay).

At the merge, the review found that only the hide cleared the marker: a launcher dropped while its host is hidden in place (`close_for_host`, for a control terminal buried by Hide or `cs window hide`, or a window hidden by the transfer prompt) and a show that gave the launcher no keyboard left it set, so that window's terminal skipped its resume refocus until the next toggle. Both now clear it, pinned by `every_end_of_a_shown_launcher_uncovers_its_host` in `launcher_panel.rs`; not read on macOS. The owner accepted the seat's scripted readings in place of his own on 2026-11-02 ("no need for my own macos reading, the scripted ones from the agent are enough").
