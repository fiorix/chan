# A window with tabs in its title bar shows its name nowhere

Status: raised and built by the owner directly with an agent on 2026-11-10 (`feat/pane-window-title`, `d7f710826`, over `e23f4cdbf`); accepted for v0.127.0 by the owner the same day, when it was merged into the integration branch as `2cd4b310e` with its review's fixes on top (`6a0cf5218`, four commits). A read-only review found that the desktop never followed a rename made in Computers, because the page dropped the rename frame on the desktop before recording it although the server sends it to each window's own socket, and that the desktop's document title had started to change; both are fixed, each pinned by a test shown red without its fix, and the design notes and three comments now say what is true. Acceptance 1 holds at the merge (the web gate green); 2 is the owner's. The owner then found that in a tmux window the popup's heading kept the name the window had when it was made while the band followed tmux; the server now relabels a tmux window's record on every tmux rename and tells its page (`48f47be29`, merged as `5d39fee1d`), each case pinned by a test shown red without it.

## What is there now

With tabs in the title bar (Settings, Global, "Title bar tabs", v0.126.0; macOS and Windows), the window's own title is hidden: on macOS the title bar turns transparent and its text is not drawn, and on Windows the window has no frame. The band holds the pane-tree button and the active pane's tab strip, so nothing in the window says which window it is, while the Computers window names every window ("Terminal Window 2 [deploy shell]", "Window 3", "Control terminal") and keeps the user's label out of sight in privacy mode.

## Desired contract

1. With tabs in the title bar, the pane tree popup (Cmd+Shift+A, or the bar's pane-map button) names the window above its tab filter. In chan-desktop the name is the window's own title, spelled as its title bar spells it while the Computers launcher covers the window, devserver included (the remote glyph, then "geekom / chan Window 1"): the desktop sends it to the page when the page asks for the mode and on every retitle, on macOS as on Windows. A browser, which has no such title and no way to learn the devserver's name, and a desktop that predates the event spell it as the Computers window spells its row.
2. In privacy mode the name is the generated one without the devserver or the user's label, by the same rule the Computers window uses for its row, and the full name comes back as soon as privacy mode is off.
3. The name follows a rename made in Computers on every surface, the desktop included. The naming fields are read on the desktop when the popup first opens and in a browser at load; simultaneous opens share one read, and a failed read is tried again at the next open.
4. The desktop's document title is unchanged by this: "Chan", or "Chan (privacy mode)".
5. The filter keeps the keyboard; a long name ends in an ellipsis with the whole name as a tooltip; the list does not move while the name loads; the dialog's accessible description carries the name, while its name stays "Panes and tabs".

## Boundaries

- Title-bar-tab mode only; with tabs below the title bar the window's own title is visible and the popup is unchanged.
- No new way to name windows: the name is the desktop's title for the window, or the Computers window's where no such title reaches the page.
- A tmux window's record takes tmux's window name on every rename (`5d39fee1d`), so its band, the popup's heading and Computers agree; a label given to a tmux window in Computers lasts until tmux next renames it (owner's call open).

## Acceptance

1. Mounted tests: the name and its privacy form, a rename arriving through the store's frame on the desktop and in a browser, the shared read and its retry, a stale label outranked by a fresh read, the desktop's unchanged document title, the held row and the dialog's description; each fix shown red without it.
2. On chan-desktop on macOS (owner): with tabs in the title bar, Cmd+Shift+A names the window, a rename in Computers shows at the next open, and privacy mode hides the label.
