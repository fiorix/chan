# Pane navigation stops at a focused terminal on the Linux and Windows desktop

Status: accepted by the owner's word of 2026-10-28 ("let's use alt+[ and alt+]", and for Windows, "can we use the same alt+[ and alt+] ?"); built on `v0115/altbr` (the section Built below); not merged.

## What was seen

The owner's words of 2026-10-28, after using chan-desktop on Linux: Ctrl+[ and Ctrl+], "which are supposed to move to previous and next pane respectively, didn't quite work - only one of them work, i think ctrl+] does but ctrl+[ does not", and later "iirc the windows shortcuts for next/prev pane also didnt work".

Reproduced on 2026-10-28 with the v0.114.0 release AppImage in an Arch Linux guest under KDE Plasma 6.8 (Wayland), keys sent as hardware key codes over QEMU's QMP (`dev/vm/qmp.py` in the development tree). In a window with a file browser in the left pane and a terminal in the right one: Ctrl+] from the file browser moved focus to the terminal; Ctrl+[ from the terminal did nothing, and neither did Ctrl+] from a terminal in the left pane. So the pair works only away from a terminal, and the first press that lands in a terminal is the last one that moves: that is the "only Ctrl+] works" the owner saw.

## Evidence

Read at `7afe0ac85`. Both chords are left with a focused terminal on purpose, by the owner's ruling of 2026-09-27 in [the-desktop-takes-ctrl-right-bracket-from-a-shell](../done/the-desktop-takes-ctrl-right-bracket-from-a-shell.md): Ctrl+[ is ESC (0x1B) and Ctrl+] the Group Separator (0x1D) to a shell. The key bridge's bracket arms return without claiming when the Command key is up and a terminal has focus (`desktop/src-tauri/src/key_bridge.js:232-243`), and off macOS the workspace app's `shouldEscapeTerminal` answers false for native Ctrl+[ and Ctrl+] (`web/packages/workspace-app/src/state/shortcuts.ts:789-794`). The Windows desktop runs the same script and the same rule, with Control as the platform modifier, so it behaves as Linux does.

The browser build already has a pair that leaves a terminal: Alt+[ and Alt+] (`shortcuts.ts:199-213`), handled in `App.svelte`'s window keymap on every surface (`App.svelte:991-1004`). On the desktop that handler already moves panes for Alt+[ with focus outside a terminal; a focused terminal kept the key because the registry's off-mac native chord was Ctrl+[.

## Owner ruling

On 2026-10-28, offered Alt+[ / Alt+], Ctrl+Alt+arrows (Ghostty's Linux chords; GNOME binds all four to workspace switching), Ctrl+Shift+arrows (WezTerm; word selection in the editor), Ctrl+Shift+[ / ] (kitty; chan's tab navigation) and claiming Ctrl+[ / ] in terminals (breaks ESC for vim), the owner chose Alt+[ and Alt+], on Linux and Windows. KDE Plasma 6.8, GNOME and Omarchy leave Alt+[ and Alt+] unbound (read in the guest's `kglobalshortcutsrc`, GNOME's `org.gnome.desktop.wm.keybindings`, and Omarchy's `default/hypr/bindings/*.lua` on its `quattro` branch).

## Desired contract

On the Linux and Windows desktop, Alt+[ and Alt+] select the previous and next pane with focus anywhere, a focused terminal included, as in a browser. Ctrl+[ and Ctrl+] are not pane navigation there: a focused terminal reads ESC and GS, an editor gets its own bindings. The macOS desktop is unchanged: Command+[ and Command+] everywhere, and Control+[ and Control+] outside a terminal (the owner's ruling of 2026-09-29). Tab navigation (the shifted forms) is unchanged.

## Boundaries

`osChord` in `shortcuts.ts` (the one place the per-OS chords live), the bridge's two bracket arms in `key_bridge.js`, their tests, `desktop/design.md`, and the manual's Navigation page. Not changed: the browser's chords, macOS, tab navigation, and the split chords.

## Acceptance

1. The registry names Alt+[ and Alt+] as the native chords off macOS, and a native Alt+[ or Alt+] on a focused terminal leaves the terminal, under Linux and Windows user agents; pinned.
2. Off macOS the bridge claims neither Ctrl nor Command with an unshifted bracket, whatever has focus; macOS keeps its claims; pinned by the test that runs the bridge's script and by the Rust test that reads it.
3. Ctrl+[ and Ctrl+] on a focused native terminal still reach the terminal on every desktop; pinned (existing).
4. Read on a Linux or FreeBSD desktop: Alt+] and Alt+[ move between a terminal pane and a file browser pane in both directions, and Ctrl+[ in the terminal still reaches the shell.

## Built on `v0115/altbr`, 2026-10-28

- `osChord` returns `Alt+[` and `Alt+]` for `app.pane.prev` and `app.pane.next` on the native platform off macOS, so the help table, the labels and `shouldEscapeTerminal` all read the Alt pair there. `shouldEscapeTerminal`'s native arm keeps only Ctrl+/: no built-in chord names the Control brackets off macOS any more, and on macOS `Mod` is Command.
- The bridge's `BracketLeft` and `BracketRight` arms return first when `!MAC`, so off macOS neither modifier form is claimed and Alt+[ reaches `App.svelte`'s handler. The Rust pin (`key_bridge_releases_a_focused_terminals_chords`) also requires that guard in both arms.
- Tests: the bridge test runs under macOS, Linux and Windows user agents and pins that off macOS neither Ctrl nor Command with a bracket is claimed with focus in a terminal, an editor or an inactive terminal, that Alt alone is left to the page, and that the shifted forms keep tab navigation (`desktopBridgeLayout.test.ts`); the mounted terminal tests pin that a native Alt bracket leaves the terminal on Linux and Windows (`desktopBridgeTerminal.test.ts`); the help table names Alt+[ and Alt+] for native Linux and Windows (`shortcuts.test.ts`); the Windows label test checks its Ctrl rule on the resolved chord, so the Alt pair is not read as a missing Ctrl, and pins Alt+[ and Alt+] on the Windows desktop (`shortcuts.windows.test.ts`). Reverting the `osChord` lines fails nine tests; removing the bridge guard fails twelve.
- `desktop/design.md` (section 6.2) and the manual's Navigation page say so, and `App.svelte`'s comment above the Alt handler names the Linux and Windows desktop as its users; no code changed there.
- Read on the FreeBSD 15.1 guest (Xfce on X11), a debug build of this branch with the web bundles built from it: in a window of two stacked terminal panes, Alt+[ moved focus from the bottom terminal to the top one and Alt+] moved it back, and `cat -v` in the focused terminal printed `^[^]` for Ctrl+[ then Ctrl+]. The FreeBSD desktop's page reports a non-macOS user agent and runs the same off-mac code as Linux. Not read with this branch: the Linux desktop under Wayland (that guest runs the v0.114.0 release), a file browser pane, and Windows.
- Checks: `cargo fmt --all --check`, `cargo clippy -p chan-desktop --all-targets -- -D warnings`, `cargo test -p chan-desktop key_bridge` (7 passed), `make shortcuts-check`, `make web-marketing-check` and `make web-check` (7,877 tests) pass.
