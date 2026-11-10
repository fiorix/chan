# Every pane of a tmux window takes the active pane's name

Status: shipped in [v0.127.0](../../release/release-v0.127.0.md).

Record before the release: raised by the owner on 2026-11-10 from his Mac, with two screenshots ("every time we switch panes, we change the name of all processes in the tree to the current process"), and ruled into v0.127.0 the same day: each pane is named by its own `#{pane_title}`, falling back to `#{pane_current_command}` while the title is still tmux's default. Built on `fix/tmux-pane-names` (`e85016cee`, six commits over `40959b57e`, with the label ruling of [the Computers label item](a-computers-label-on-a-tmux-window-lasts-until-tmux-renames-it.md) among them) and merged into the integration branch as `7898f4fe3`; a live-test fix followed on the integration branch (`4a326966d`). Each property is pinned by a test shown red without its fix.

## What was there

- **Panes were named after their window.** chan named every pane session of a `tmux -CC` window after the tmux window's name (`#{window_name}`), at creation and again on every `%window-renamed`, and read no per-pane text anywhere. With tmux's automatic rename the window's name is its active pane's command, so the pane tree's rows and the title bar read the selected pane's command for every pane, the second with the `-2` the session registry adds to keep tab names unique: `top` and `top-2` with a `bash` pane and a `top` pane, then `bash` and `bash-2` after a pane switch.
- **The pane tree's heading read one rename behind on the desktop.** With tabs in the title bar the heading shows the window's title as the desktop sends it. After a retitle the desktop read the title back from the window to send it, and on macOS a window applies a new title on a later turn of the main thread, so each event carried the title before: `[bash]` while the window was `top`. Privacy mode's refresh read the title the same way, so a page told privacy was off could keep the masked title.

## Contract as built

1. A tmux connection subscribes to its panes' names at its start (`refresh-client -B`, `Command::SubscribePaneNames` in `crates/chan-tmux/src/command.rs`), and tmux reports each pane on its once-a-second timer: first within a second of the subscription or of the pane appearing, then whenever the value changes, and again when a pane moves to another window.
2. A pane's name is its title, or its foreground command's name while the title is the one tmux gives a new pane (its host's name, compared by tmux in the format) or is blank (`Message::PaneName`, `crates/chan-tmux/src/message.rs`).
3. Until tmux's first report a pane session is named by its id, `tmux %N`, as an unnamed window is `tmux @N`; a pane tmux has no name for reads the same.
4. A window rename labels the window alone (`window_named`, `crates/chan-library/src/terminal_sessions/tmux_connection.rs`); its panes keep their names, and a focus switch reports no pane.
5. The roster carries the pane's name as tmux gave it (`tmux_name`), and the pane tree's rows, the title bar and the close prompts show that. The session's tab name stays unique for `cs` (`bash-2`), is listed by `cs terminal list`, and shows on the page only in the row's tooltip. A name one pane frees does not move another pane's tab name.
6. The reported line carries the byte lengths of both texts, and the parser refuses a line whose texts are not exactly that long, ending the connection before any following line is read: a program whose name holds a line break cannot write lines read as tmux's. Control characters are removed from a name, it is cut to 128 characters, and a connection keeps names for at most 1,024 panes.
7. A retitle sends the window's page the title just set (`title_changed`, `desktop/src-tauri/src/titlebar_tabs.rs`), for privacy mode's refresh too.

## Boundaries

- Subscriptions need tmux 3.2, which was already the oldest tmux the gate connects to, so there is no version branch and nothing changes below it.
- No reply carries a name, so a pane's own name arrives up to a second after the pane.
- Panes of a window that belongs to another session keep `tmux %N`: tmux's subscription covers the attached session.
- A rename of a tmux pane's session through `cs` changes its tab name and not what the page shows, and the pane's next tmux name replaces it.

## Acceptance

1. Tests (met): the parser over well-formed, hostile and replayed streams, with a capture from a real tmux as a fixture; the connection over a recording rig (two panes of one window keep their own names through a window rename; a pane added later; a name reported before its pane is listed; a pane moved to another window; the bound on kept names); the roster's `tmux_name`; mounted tests of the pane tree's rows and the title bar; the title event carrying the title just set. Thirteen connection tests were red against the earlier code, showing `("shell", "shell-2")` where `("bash", "top")` was expected.
2. Against a real tmux (met): the live test green on tmux 3.8 on the host, where tmux cleans a command name holding a line break to an empty name, and on tmux 3.6 in the gate guest, where tmux prints the name as it is and the client refuses the cut line; neither reads the forged line as tmux's exit.
3. The integration branch's gate and Windows cross-check green with the merge.
4. On chan-desktop on macOS (owner): in a `tmux -CC` window with a `bash` pane and a `top` pane, the pane tree's rows read `bash` and `top` and stay so through pane switches; the title bar reads the active pane's name with no `-2`; two `bash` panes both read `bash`; the heading's window name follows a rename at once, not one switch late; a new split reads `tmux %N` for at most a second.
