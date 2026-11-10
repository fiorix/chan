# The macOS Window menu piles up stale sections

Status: raised by the owner on 2026-11-10 from his Mac after turning privacy mode on and off, with a screenshot of the Window menu; investigated and fixed the same day on `fix/window-menu-stale-sections` (`ac82df82e`, three commits over `3d6266fc6`) and merged into the integration branch as `465892a7d`; accepted for v0.127.0 by the owner. Each defect is reproduced by a test shown red without its fix; the AppKit side of the menu could not be run on the integrator's Linux host, so what macOS adds to the menu, and where, is reasoned from muda's and Tauri's code and the owner's screenshot. Acceptance 1 holds at the merge; 2 is the owner's.

## What is there now

On macOS the app's Window menu showed four groups of "Open Windows (N)" and "Hidden Windows (N, kept warm in memory)" where there should be one, the first full of entries titled "Chan (privacy mode)" though privacy mode was off, and its open section missed a window the system's own list showed while listing one it did not; the Computers window, which reads the library's records live, was right throughout.

- **The sections pile up.** muda 0.20.0, in the lock since v0.109.0, removes and inserts a menu item by the index it has in muda's own list (its `submenu.rs:239-268`, macOS backend `mod.rs:443-477`; 0.19.1 removed by item identity). Tauri registers the Window submenu as the app's windows menu (tauri 2.12.4 `app.rs:2657`), so AppKit appends its window list to the same native menu, unknown to muda. `rebuild_window_menu` (`desktop/src-tauri/src/main.rs`) removed the old rows and appended the new tail below AppKit's list, so each later rebuild's index-based removal deleted AppKit's items and the front of the old tail, and left the rest in the menu after muda had dropped it from its list, where no rebuild could reach it again.
- **Titles stay in their privacy form.** The stranded rows kept the masked titles they were stamped with while privacy was on. Separately, a window hidden while privacy was on kept its masked title bar text as its hidden-row title (`serve.rs`), and a hidden devserver window whose feed later went away showed it after privacy was off.
- **The open section misses windows.** On macOS the menu was not rebuilt when a window was built (that call was off-mac only), and on destroy only when a hidden entry was dropped.

## Desired contract

1. On macOS the Window menu holds exactly one open section and one hidden section, whatever sequence of opens, closes, hides, privacy toggles and devserver feed changes came before; a rebuild replaces them and leaves AppKit's own items alone.
2. With privacy mode on every row is masked; with it off every row carries the window's own title, hidden windows included.
3. Building or destroying a window rebuilds the menu on every platform.
4. Off macOS the launcher's menu bar is unchanged.

## Boundaries

- The chan sections now sit after "Open in Browser", above Minimize and Zoom, where AppKit adds nothing, so muda's indices match the native menu; their order and content are unchanged.
- No muda upgrade or patch; the placement keeps the index-based edits correct.
- An app already showing stranded rows keeps them until it is relaunched.

## Acceptance

1. Tests at the merge: a model of muda's index-based edits on a native menu AppKit also fills keeps one tail across rebuilds; the tail sits after "Open in Browser"; a window hidden in privacy mode keeps its own title; building and destroying a window each rebuild the menu. The chan-desktop suite, workspace clippy and rustdoc green.
2. On chan-desktop on macOS (owner): turning privacy mode on and off, opening, closing and hiding windows leaves one open and one hidden section with the windows' real titles, and the system's window list stays below Zoom.
