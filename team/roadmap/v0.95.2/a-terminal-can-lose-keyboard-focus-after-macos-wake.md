# A terminal can lose keyboard focus after macOS wake

Status: accepted scope for v0.95.2. Implemented on
`fix/macos-wake-terminal-focus`; the scoped automated checks are green and the
real macOS WKWebView sleep/wake smoke remains owner validation.

## Problem

Chan Desktop on macOS can reconnect to a devserver through an EternalTerminal
connection script after sleep while the focused xterm terminal stops accepting
keyboard input. Switching to another tab and back repairs it immediately.

The terminal wake callback restores the renderer and recycles the PTY socket,
but it does not restore keyboard focus. WKWebView stays logically visible and
focused across sleep, so the Svelte `focused` prop does not change and its
focus effect has no reason to rerun. A tab switch raises `tabFocusPulse`, which
does rerun that effect and calls the terminal backend's focus method.

The focused test covers both DOM states compatible with the symptom against
the old implementation: the xterm textarea can fall back to `document.body`,
or it can remain `document.activeElement` while still needing an explicit
focus call to reattach the native keyboard bridge. Those two assertions were
the only reds in a 17-test run; the tab-focus workaround and reconnect-input
behavior were already green.

## Desired contract

- Native host focus, pageshow, visible visibility changes, and a detected
  wall-clock wake reassert keyboard focus for the terminal that remains both
  active and focused.
- An explicit backend focus call still occurs when the active element is
  already inside the terminal host; DOM focus alone is not proof that the
  WebKit keyboard bridge is live.
- Recovery never steals focus from another surface, a background terminal,
  Rich Prompt, terminal Find, the tab menu, or a survey.
- Renderer recovery and PTY socket recycling keep their existing behavior.
- Input typed while the PTY WebSocket is reconnecting remains dropped rather
  than buffered and replayed later.

## Implementation

`TerminalTab.svelte` has a host-resume focus recovery path separate from its
renderer recovery. It queues the focus claim after the resume event, verifies
logical terminal ownership and the current DOM owner, then routes through the
existing backend-neutral `focusTerminal()` method and its survey guard. The
ordinary tab-focus effect is unchanged because it intentionally takes focus
from the prior tab, unlike host-resume recovery.

## Acceptance

1. `terminalHeartbeatReconnect.test.ts` proves red before the implementation
   and green after it for both the blurred-textarea and stale-active-textarea
   cases. It also proves an external DOM owner and a background terminal retain
   focus, a tab pulse repairs the original condition, and disconnected input is
   not replayed.
2. `TerminalTab.renderer.test.ts` pins the separate renderer and keyboard
   recovery paths plus the Rich Prompt, Find, menu, and DOM-owner boundaries.
   `tabSwitchFocusFollow.test.ts` keeps the survey guard pinned. Removing the
   wake focus call or its logical ownership guard makes the focused checks red.
3. The three focused Vitest files, workspace-app `svelte-check`, and
   `git diff --check` remain green.
4. Owner smoke on macOS: with xterm focused through the existing
   EternalTerminal connection, sleep and wake Chan Desktop, wait for the
   tunnel and PTY socket to recover, then type without switching tabs. The
   first key reaches the shell and the existing session remains attached.

## Boundaries

No terminal input buffer, reconnect-cadence change, backend or PTY change,
desktop watcher change, wire-protocol change, or release work belongs to this
item. CI can compile and package the macOS app but cannot prove a real WKWebView
sleep/wake focus transition.
