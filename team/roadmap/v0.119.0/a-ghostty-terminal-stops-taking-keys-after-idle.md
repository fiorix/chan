# A ghostty terminal stops taking keys after idle

Status: built on `v0119/ghostty-vt-wasm` on 2026-10-31 by the owner's word ("there's an item \"ghostty idle keys\" that we should deal with in this change here"): the repair the trace names, without a reproduction (the section Built); the owner's reading on the macOS window over the gateway is the proof that stands.

Record before the release: carried into v0.118.0 at the v0.117.0 GA on 2026-10-31 by the owner's word ("Carry all three to v0.118.0 unbuilt"); traced in code without a reproduction, and the owner will capture the next occurrence.

Record before the release: raised by the owner on 2026-10-30 from the macOS desktop on a gateway-served devserver window of the Linux machine, after switching their own shells from xterm.js to ghostty; traced in code the same day without a reproduction (the section Trace); proposed, not started. The owner will capture the next occurrence.

## What was asked

The owner: "since I started using ghostty, i think when my terminal goes idle something disconnects and i need to click the terminal to be able to type again." The window is a devserver window reached through chan-gateway from the macOS desktop; the terminals are the owner's own shells on ghostty, which the same session made the default backend.

## Trace, 2026-10-30

Read at `17bbe620f` with ghostty-web `0.4.0-next.20.g1858a59`, no reproduction: the Linux host has no keyboard injection into WebKitGTK, and the owner's window is WKWebView over the gateway.

Ruled out by reading:

- The socket redial after the gateway's idle cut (`TerminalTab.svelte`, `ws.onclose`) keeps the same ghostty instance, its `onData` handler and its custom key handler; `connect()` reattaches with the session id and generation and replays missed output.
- The replay-origin suppression window of `PtyWriteTracker` (`terminal/connection.ts`), which drops ESC-prefixed input while a replay write is pending (every key under the kitty keyboard protocol is ESC-prefixed), is closed synchronously under ghostty: the ghostty writer calls the tracker's completion right after `viewport.write`, so no keystroke can arrive inside it.
- ghostty-web's render loop (`startRenderLoop`) runs on `requestAnimationFrame` until `dispose`; `resize` cancels and restarts it in one call.
- The idle tracker and the screensaver are backend-agnostic, and the screensaver is a visible cover.

Strongest candidate, unverified: focus restoration after a host resume. `recoverTerminalFocusAfterHostResume` re-focuses the terminal on a window focus, a page show, a visibility change and the wake-gap detector, because WKWebView can keep `document.activeElement` while detaching keyboard input. xterm.js's `focus()` targets its textarea; ghostty-web's targets the host `div` it opened in (`Terminal.focus()` calls `element.focus()`), and `focus()` on the element that is already active is a DOM no-op, so the recovery may re-arm nothing for ghostty while a real click does. The repair to try when it reproduces: a blur-then-focus cycle on that path for the ghostty backend (a program with focus reporting on then sees `ESC[O` `ESC[I`, as it does on any terminal's wake).

What to capture at the next occurrence, before clicking: the window kind (gateway-served devserver window or local), what preceded the idle (display sleep, an app or window switch, or the window in front throughout), whether the status pill said reconnecting, whether keys typed before the click show up after it or are lost, and from the window's DevTools console (Cmd+Opt+I) `document.activeElement` (the `.terminal-host` div for ghostty) and `document.hasFocus()`.

## Owner's word, 2026-10-31

After the other rows landed: "ghidle can proceed if you can take the capture otherwise let's keep going". The capture cannot be taken on the build host: the reported window is WKWebView on the macOS desktop over the gateway, the trigger is the owner's own idle pattern, and the Linux WebKitGTK rig does not share the focus-restoration path the trace names as the strongest candidate. The row stays proposed, next a capture by the owner, and carries to the next version unbuilt at the GA.

## Built, 2026-10-31

The repair the trace names, on `v0119/ghostty-vt-wasm` beside the ghostty core row by the owner's word, with no reproduction to run it against. `recoverTerminalFocusAfterHostResume` (`TerminalTab.svelte`) runs on a window focus, a page show, a visibility change and the wall-clock wake detector; when the backend is ghostty and `document.activeElement` lies inside the terminal's host, it now blurs that element before `focusTerminal()`, so the refocus is a focus change rather than a DOM no-op on the element WKWebView kept active while detaching keyboard input. ghostty-web's `Terminal.focus()` focuses the host element it opened in and again on a timer; the blur is the DOM's on the active element, so the backend's own focus and blur methods are untouched. The xterm path is unchanged: its textarea refocus is what the recovery has done since it was written. A program with focus reporting on sees CSI O then CSI I on a resume, as on any terminal's wake.

Verification: two mounted tests in `TerminalTab.ghosttyBackend.test.ts` on the ghostty stand-in: with the host as the active element a `pageshow` blurs the host once and then calls the terminal's `focus`, and the DOM focus leaves the host; with an input elsewhere holding the focus, a resume blurs nothing and focuses nothing. Red without the blur (`the host is blurred once: expected "blur" to be called 1 times, but got 0 times`), green with it; the two files that drive the resume path (the ghostty backend's 34 tests and the renderer's) pass, 43 in all; `svelte-check` 0 errors over 5,769 files. Not read: the symptom itself, which only the owner's macOS window over the gateway has shown; what to capture at the next occurrence stays as listed above, and if it recurs with this repair in place the candidate is wrong and the capture decides.
