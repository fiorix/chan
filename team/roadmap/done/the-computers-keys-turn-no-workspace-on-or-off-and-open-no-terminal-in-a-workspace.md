# The Computers keys turn no workspace on or off and open no terminal in a workspace

Status: shipped in [v0.120.0](../../release/release-v0.120.0.md).

Record before the release: implemented on 2026-11-01; native launcher verification on macOS is pending.

## What was asked

The owner's words, 2026-10-31: "change the `c connect/disconnect` from the Computers window to `o on/off` and make it work not only for devserver and tmux connect/attach disconnect/detach, but also for workspace on/off", and "i want to be able to press t over a workspace and get a new workspace window with a terminal minted in it".

## What is there now

Read at `e721c63bf`, the v0.119.0 GA commit:

- The launcher's carousel sends a row's letter to the row's button that declares it with `data-deck-key`, keeping that button's conditions and action (`Carousel.svelte`, which takes the letters `c`, `t`, `w` and `h`). `web/packages/launcher/design.md` describes the keys, and the buttons' titles name them (`Disconnect (c)`).
- `c` is the connect slot. On a devserver header it connects, disconnects, disconnects a lost connection, or holds the working spinner; on a tmux connection header it detaches (`Library.svelte`). On the Gateways screen it connects, disconnects or cancels a gateway (`Gateways.svelte`).
- A workspace row has `w` for a new window of the workspace and a power button (`setWorkspacePower`, Turn on and Turn off) with no letter. `t` does nothing on a workspace row; on This machine and a connected devserver header it opens a terminal, and on a tmux header it asks for a new tmux window.
- A tmux connection's card exists only while the connection runs, so its header has detach and no attach.
- Nothing opens a workspace window with a terminal already in it: `newWorkspaceWindow` mints or opens the window, and `newTerminal` opens a standalone terminal.

## Desired contract

1. `o` is the on and off key of the Computers screen. On a devserver header it connects or disconnects, in the slot `c` holds today, with its lost-connection and working states. On a tmux connection header it detaches. On a workspace row it turns the workspace on or off through the row's power button, with that button's conditions and the confirmation it asks before stopping live terminals. On the Gateways screen it connects, disconnects or cancels a gateway, in the slot `c` holds there today. `c` no longer acts on those rows or on the Gateways screen; titles, labels and the deck hint name `o`.
2. `t` on a workspace row opens a new window of that workspace with a terminal tab in it, for this machine's workspaces and a connected devserver's, wherever `w` would open a window. Where `w` is inert (a workspace that is not ready, one turning on or off, or one whose windows the session leader manages), `t` is inert too.
3. All windows rows keep ignoring the card letters, and text entry, dialogs, the command launcher and modifier chords keep their keys, as today.

## Decisions

The owner's words of 2026-10-31 on whether the Gateways screen's connect, disconnect and cancel move from `c` to `o` as well: "yes the gw moves to 'o' as well". One letter means on and off across the launcher.

## Open decisions

- How the terminal reaches the new window: minted with the window in its first layout, or asked for once the window has opened. To be read against the window mint (`mintWindow`, `createWindow`), the devserver open route and the workspace app's launch path before the build.

## Acceptance

1. In the native launcher on Computers, `o` on a devserver header connects and disconnects it, on a tmux connection header detaches it, and on a workspace row turns the workspace on and off, with the live-terminals confirmation; on the Gateways screen `o` connects, disconnects and cancels a gateway; `c` does nothing on those rows or on the Gateways screen. Launcher tests pin each case, and a case that `c` no longer dispatches.
2. `t` on a ready workspace row opens one new window of that workspace that shows one terminal tab, on this machine and on a connected devserver; `t` on a workspace that is not ready does nothing.
3. `web/packages/launcher/design.md`, the button titles and the deck hint name the new keys.

## 2026-11-01 implementation and verification

The terminal uses the first-load request from the design read's candidate B. A workspace window mint may carry `start_terminal`; the library persists it in the window record, the remote desktop bridge forwards it, and browser and native URL builders append `start=terminal` for that record. The workspace app strips the parameter after layout restore and opens one terminal only when no saved layout exists; a saved empty layout opens none. An ordinary `w` mint omits the flag and keeps its URL. This extends the existing mint and remote-open routes without adding a route.

The Computers deck dispatches `o` through each enabled devserver connection control, tmux detach control and workspace power control; the Gateways deck uses `o` for connect, disconnect and cancel. `c` has no deck action. A ready workspace row has a `t` button beside `w`, using the same readiness and session-leader conditions. Titles, accessible labels, the deck hint and launcher design name the new keys.

Launcher, workspace-app, chan-library, chan-server and chan-desktop tests cover the key dispatch, unchanged `w`, local and remote intent transport, persistence, native and browser URLs, and bootstrap behavior with no layout, a saved tab and a saved empty layout. Focused tests were red before the implementation and passed after it; mutations of the dispatch, readiness, request bodies, bridge, persistence and URL/layout guards each failed an intended assertion. On the isolated Vite launcher at port 5184, `o` turned ws-alpha off and on, `c` left it unchanged, and `t` opened one window with one `Terminal-1` tab; the page consumed the launch hint. That browser check temporarily gave Vite a browser-window capability and a tenant-path proxy because its development launcher otherwise has desktop capability and proxies only `/api`; both test fixtures were restored byte for byte. Native launcher behavior on macOS awaits Alex's hand check.
