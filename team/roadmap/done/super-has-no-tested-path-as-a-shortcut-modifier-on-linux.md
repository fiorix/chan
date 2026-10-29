# Super has no tested path as a shortcut modifier on Linux

Status: closed at [v0.115.0](../../release/release-v0.115.0.md) by the owner's decision of 2026-10-28 (the section Owner decision): Super is not a supported shortcut modifier on the Linux and FreeBSD desktop, the manual's Settings page says so, and that note is the one change that shipped; no Super support shipped and no key bridge change was made. The sections from Readings, 2026-10-28 on hold the evidence.

Record before the release: decided 2026-10-28, unsupported, by the owner's word (the section Owner decision); the manual's note landed on `main` in the merge `cac9a678c` on 2026-10-28; closes at the v0.115.0 GA.

Record before the decision: accepted by the owner's word of 2026-10-27; moved from v0.114.0 to v0.115.0 by the owner's word of the same day ("superk opt-in for linux will go to the next version's roadmap").

## What was asked

The owner asked on 2026-10-27 whether the Windows / Super key could be the app modifier on Windows and Linux, as Cmd is on macOS. The answer was no as a default (Windows reserves nearly every Win+letter in the shell and Win+L cannot be overridden; GNOME, KDE and tiling window managers bind Super), but possibly as an opt-in for Linux setups whose window manager leaves Super free.

## Evidence

Read at `0119a1912`. Off macOS the matcher already names a pressed Super key `Cmd` (`web/packages/workspace-app/src/state/shortcuts.ts`, `eventCandidates`), so a user override such as `Cmd+P` may already work in a browser. The desktop key bridge (`desktop/src-tauri/src/key_bridge.js`, `onKey`) treats `metaKey` like `ctrlKey` off macOS, and several of its arms are written for macOS Cmd (for example Cmd+W closes the tab), so a Super chord on Linux may fire a macOS-only action.

## What to do

1. On a Linux desktop with a window manager that leaves Super+letter free, assign a few overrides with Super in Settings > Keyboard Shortcuts and record which fire in Chan Desktop and in a browser, and which the key bridge intercepts.
2. Decide with the owner: document Super overrides as supported on Linux (fixing any bridge arm that misfires), or keep them unsupported and say so in the manual.

## Acceptance

- The readings from step 1 recorded here, and the owner's decision.
- If supported: a key bridge test that a Linux Super chord fires only its override, and a manual note on the Settings page.

## Readings, 2026-10-28

Read in two QEMU guests on the development host (`dev/vm/` in the development tree), keys sent as hardware key codes over QMP: Arch Linux with KDE Plasma 6.8 on Wayland (WebKitGTK 2.54) and FreeBSD 15.1 with Xfce on X11 (WebKitGTK 2.46). A WebKitGTK 4.1 page with a key logger (`dev/vm/keyprobe.py`), the engine chan-desktop's webview runs on, without the key bridge.

- The page never sees Super as a modifier. Super arrives as its own keydown (`key` `Super`, `code` `OSLeft`), and the key pressed with it arrives bare: Super+[ is `key` `[` with `metaKey` false and `getModifierState` false for `Meta`, `OS` and `Super`, on both guests. Ctrl+Super+[ reports Control only. So no binding in Settings > Keyboard Shortcuts can name Super on the Linux or FreeBSD desktop: the capture and the matcher both see the bare key.
- GTK under the page does see it: the webview's `key-press-event` for the same press carries `GDK_SUPER_MASK` and `GDK_MOD4_MASK` (not `GDK_META_MASK`) on both guests. Supporting Super would therefore need a native GTK key handler in chan-desktop, not a change in the workspace app.
- A Super chord is not typed into a terminal either: Super+[ and Super+] in a focused chan terminal (v0.114.0 on the Linux guest) sent nothing.
- Desktops take many Super chords first. KDE Plasma 6.8: Meta+T opens the Tiles Editor and Meta+. the emoji selector (both seen in the guest), Meta+W the Overview, Meta+1 to Meta+9 the task manager entries (`kglobalshortcutsrc`). Omarchy (Hyprland; `default/hypr/bindings/*.lua` on its `quattro` branch) binds Super with W, Q, T, F, K, P, the digits, the slash and most letters, and turns Super+C, V, X and A into Control chords (Control and Shift for the windows it tags as terminals, a list chan-desktop is not on). Xfce passed Super+T and Super+. through. Daemonarchy runs Omarchy unchanged on FreeBSD 16.0-CURRENT (its README; not run here, and its README says Hyprland does not run in a FreeBSD virtual machine), so it carries the same bindings.

## Owner decision

On 2026-10-28, given the readings above: "i think the super key on freebsd and linux is far less effective than it is on the macOS and not worth the work from chan's side; let's just stick to the no-super keys there". Super is not a supported shortcut modifier on the Linux and FreeBSD desktop. The manual's Settings page says so (`web/packages/marketing/src/pages/manual/settings.html`), and no key bridge change is made. The owner's report of the same day, that Ctrl+[ and Ctrl+] stop moving panes at a terminal, is answered without Super: [pane-navigation-stops-at-a-focused-terminal-on-the-linux-and-windows-desktop](pane-navigation-stops-at-a-focused-terminal-on-the-linux-and-windows-desktop.md).
