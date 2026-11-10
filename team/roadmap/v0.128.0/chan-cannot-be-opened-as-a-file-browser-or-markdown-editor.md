# chan cannot be opened as a file browser or Markdown editor

Status: raised by the owner on 2026-11-09 and accepted for v0.128.0 the same day; not started.

## What is there now

- **`cs open` already does the work, inside chan.** In a standalone window (a terminal window with no workspace behind it, `WindowKind::Terminal`, `crates/chan-library/src/windows.rs:4-5`), `cs open PATH` (`crates/chan-shell/src/cli.rs:1187-1216`, `ControlRequest::OpenPath`) reaches `open_path_standalone` (`crates/chan-server/src/control_socket.rs:5471-5483`): a directory opens the file browser, a text file the editor, any other file is revealed in its directory, and a missing path is created empty and opened in the editor (`standalone_open_target`, `:5360-5418`). From a workspace window a path outside the root goes to a standalone window that is reused or created and raised (`WorkspaceHost::open_outside_workspace`, `crates/chan-library/src/host.rs:4072-4168`). The standalone window's file surface is a mount rooted at `/` that starts in `$HOME`, and it exists on Unix only (`crates/chan-server/src/lib.rs:1111-1199`).
- **Nothing outside chan can ask for it.** `chan open` is a visible alias of `chan serve`, which serves a directory as a workspace (`crates/chan/src/cli.rs:56`, `crates/chan/src/help.rs:705`), and `--standalone` means a server that skips the desktop and devserver handoffs, not a standalone window (`cli.rs:547-554`). The desktop's handoff socket accepts `OpenWorkspace` and `OpenTerminal` and nothing that opens a path (`crates/chan-server/src/handoff.rs:82-90`, `:214-226`). `chan-desktop` reads no positional path: a `%U` argument boots the GUI and is ignored (`desktop/src-tauri/src/terminal_mode.rs:46-50`, `:310-325`), and there is no single-instance or deep-link plugin.
- **Linux.** The packaged entry `packaging/distros/shared/chan-desktop.desktop` (installed by the deb, Fedora, AUR and Nix packages) has `Exec=chan-desktop %U` and the `TextEditor` category but no `MimeType=`; the AppImage uses Tauri's default template, `Exec=chan-desktop` with no field code. Nothing registers chan for `inode/directory` or `text/markdown`, so `xdg-open` never picks it, and a manual association would deliver a path the desktop ignores.
- **macOS.** The bundle declares no document types (`desktop/src-tauri/tauri.conf.json:42-45`, no `CFBundleDocumentTypes` or `fileAssociations`), and the desktop handles no open-file event (`RunEvent::Opened` is absent, `desktop/src-tauri/src/main.rs:6055-6118`), so chan cannot be chosen in Finder's Open With or set as the default app for Markdown.
- **Windows.** No file associations, and no standalone file surface to open into.
- **A second desktop process runs beside the first.** Nothing makes a second `chan-desktop` hand off to a running one: the second process fails the handoff listener's lock (`crates/chan-server/src/handoff.rs:776`, `control_socket.rs:941-966`), logs "handoff listener disabled" and keeps running (`desktop/src-tauri/src/main.rs:6008-6014`), and launching the bundle's binary by path, as `.agents/desktop.md` suggests for log runs, skips macOS's one-instance activation. Each process then runs its own window watcher, which counts only its own windows (`window_watcher_wiring.rs:871-880`), so both open a native window for the same record (`window_watcher.rs:371`, `:386`), attached to the same sessions; the owner met this on 2026-11-10 as a `tmux -CC` window on a devserver opening twice, mirrored, until he killed the processes.

## Desired contract

1. The desktop's handoff socket takes an open-path request that does what `cs open` does in a standalone window: reuse or create a standalone window, raise it, and open the directory in the file browser or the file in the editor (or reveal it, or create it, by the same rules).
2. `chan-desktop PATH...` and `chan-desktop` given file URIs (`%U`) deliver each path to the running desktop through that request, launching the desktop first when it is not running; a second launch never starts a second desktop: it hands its arguments to the running one and exits, however it was launched.
3. The CLI has a verb for the same thing, so `chan <verb> PATH` opens a directory or file in a standalone window of the running desktop or devserver. Naming it is hard, since `chan open` is a visible alias of `chan serve`: the item evaluates the options (a new verb, re-pointing `chan open`, or a flag) with what each breaks for existing users and scripts, and records the owner's choice before the verb is built (owner, 2026-11-09).
4. Linux: the desktop entry, packaged and in the AppImage, declares `inode/directory` and `text/markdown` (at least) with a field code, so `xdg-open` and the desktop environment's Open With can use chan, and the user can make it the default file browser or Markdown editor with `xdg-mime`; installing chan does not make it the default by itself.
5. macOS: the bundle declares Markdown as a document type chan can edit, without claiming to be its default, so it shows in Open With and can be made the default Markdown app in Finder's Get Info; Finder's open, a double click once it is the default, and `open -a` deliver the file to a standalone window. Being the default file browser is not a goal on macOS.

## Boundaries

- Windows is out of scope (owner, 2026-11-09); a standalone window has no file surface there either.
- No change to what `cs open` decides per path; the new ways in reuse it.
- Plain-text and code files beyond Markdown may be declared later; this item declares directories (Linux) and Markdown.

## Acceptance

1. Tests of the handoff request: a directory, a Markdown file, a non-text file and a missing path each produce the window command `cs open` produces, into a reused or created standalone window.
2. Tests of `chan-desktop`'s argument handling for plain paths and `file://` URIs, with the desktop running and not running.
3. A packaging test that the desktop entry declares the MIME types and a field code and passes `desktop-file-validate`, for the shared entry and the AppImage's.
4. In an isolated Linux guest with the desktop under Xvfb: `xdg-open` of a directory and of a `.md` file, after `xdg-mime default`, opens each in a standalone window of the running desktop.
5. On macOS (owner): chan-desktop appears in a `.md` file's Open With, becomes its default through Get Info, and a double click opens the file in chan's editor.
