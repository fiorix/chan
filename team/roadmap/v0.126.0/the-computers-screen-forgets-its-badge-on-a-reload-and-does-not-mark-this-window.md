# The Computers screen forgets its badge on a reload and does not mark this window

Status: raised by the owner on 2026-11-08 with the code on `codex/computers-visual-state` (`bee14f9bf`); accepted for v0.126.0; built by the owner, merged into the integration branch, awaiting the release.

## What is there now

The Computers and Gateways decks keep the card in front and the turn count in a module, so a flip between the two screens keeps them, but a reload of the launcher page, in a browser tab or in a window's native launcher webview, returns to the first card and the Computers screen. The window rows name every window of the library without saying which one is the window the launcher is shown in; the only hint is focus, which the launcher itself holds.

## Desired contract

1. The selected screen and each deck's card and turn survive a reload of that browser tab or native launcher webview, whatever moved them (the mouse, the keyboard, a card's own action), without changing another window's view; focus and an open form stay transient; a blocked or corrupt store starts at the first card and navigation still works.
2. In chan-desktop each launcher knows its host window's registry identity and marks that window's row "This window", independently of focus, for workspace and terminal hosts by library and window id and for a control terminal, whose library changes when its devserver connects, by its own id.

## Boundaries

- The launcher's state only; no library, server or desktop window change beyond the identity the desktop injects at panel build.

## Acceptance

1. The lead's scoped gate at the tip (fmt, clippy, rustdoc and the tests of chan-desktop; `make web-check`, `make e2e-check`, `make shortcuts-check`) green; the full gate on the integration branch after the merge.
2. The owner's validation on his Mac: browser reloads and independent tabs, the frontend gate, the desktop Rust checks, the macOS package and devserver smoke.
