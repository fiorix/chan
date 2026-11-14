# Report: real captures for the chan.app home page

## 1. Versions

- macOS 27.0.1.
- Chan 0.130.0 (build git-826adee911a6): a local signed release build of `v0130/int` at 826adee91 (`chore(release): 0.130.0`), not the installed app, which is 0.129.0. It ran from a copy under its own bundle id (`app.chan.desktop.v0130test`), launched by binary path with `CHAN_HOME` set to the throwaway library and a private `XDG_RUNTIME_DIR`, `CHAN_UPDATE_CHECK=0`. The owner's Chan was quit for the sitting; `~/.local/bin/chan` was unchanged before and after.
- Display: built-in Liquid Retina XDR, `Resolution: 3456 x 2234 Retina`, main display, 2x. An external 3840x2160 display at 1x was attached; every window was placed at {80, 80} on the main display.

## 2. Files

All stills were taken with `screencapture -o -x -l <window id>` and checked with `sips`.

- `terminal@wide.png` 2560x1600.
- `terminal@narrow.png` 1600x1500.
- `terminal-split@wide.png` 2560x1600. The left pane's listing was redrawn after the split (see 3).
- `open@wide.png` 2560x1600. The terminal is drawn inactive: the new workspace window had taken focus.
- `open@narrow.png` 1600x1500. The terminal is drawn active: it was raised to be resized.
- `workspace-new@wide.png` 2560x1600. The window opened at 1200x800 and was resized to 1280x800 before the shot.
- `workspace-new@narrow.png` 1600x1500.
- `files@wide.png` 2560x1600.
- `editor@wide.png` 2560x1600.
- `graph@wide.png` 2560x1600.
- `files@narrow.png` 1600x1500, shell on top, app pane below.
- `editor@narrow.png` 1600x1500, same layout.
- `graph@narrow.png` 1600x1500, same layout.
- `terminal-run.mp4` 2560x1600, 30 fps, 12.1 s, poster `terminal-run.jpg`. Source `terminal-run.mov` (120 fps) kept.
- `workspace-flow.mp4` 2560x1600, 30 fps, 34.1 s, poster `workspace-flow.jpg`. Source `workspace-flow.mov` (120 fps) kept. This is the second take (see 3).

The clips were recorded with `screencapture -v -x -R<window bounds> -V<seconds>` (accepted as written) and converted with the order's ffmpeg commands. The typing was System Events `keystroke`, one character at a time at about ten a second.

## 3. What Chan did that the order did not expect

- `git log` opened a pager (`less`, `(END)`) in the clean shell. The clean shell therefore also runs `export GIT_PAGER=cat PAGER=cat`. It also always puts the throwaway shims first on `PATH`.
- S2, standalone window: `cs pane new right` creates the new pane with its own fresh terminal tab (`Terminal-2`). `cs terminal new --pane "$p" --tab-name logs` then adds `logs` as a second tab beside it and prints `terminal request queued`. The title-bar tab strip shows only the active pane's tabs.
- S2: focus moved to the new pane. After the split, zsh left its `%` partial-line marker and a blank line in the left pane, most likely the pane resizing while the prompt was drawn. I re-ran `clear && git status -sb && ls src` in the left pane, so the frame shows the short listing without the `cs` line. Focus went back to the left pane with `cs pane focus pane-2`, run from outside the window, not a click. The right pane was closed with `cs pane close pane-4 --force`, not the pane menu.
- S3: the new workspace window showed an empty window with the animated torus: no pane, no terminal, no dashboard. `chan open .` printed `chan: opened /private/tmp/chan-captures.4gHoEE/src/app in chan-desktop.` and that line is in `open@*`.
- S4 terminal tab: opened with Cmd+T (the native New Terminal shortcut), not the pane menu or the command launcher.
- Workspace window: `cs pane new right` creates an empty pane (enso placeholder) and makes it active, and keystrokes then no longer reach the shell. Every later `cs open`/`cs graph` also leaves the app pane active. Before each command, the shell pane was refocused with `cs pane focus pane-1` from outside the window, both for the stills and in the clip. In `workspace-flow` the blue active-pane border is visibly handed back to the shell between lines.
- The right pane kept the shell visible: the shell stays in the left half in every wide frame.
- Editor: `README.md` renders with Outline and Details side panels. At half width the Details panel is cut off by the pane's right edge (`18m ag`, `Markdow`), which may be a layout bug. The file browser also opens with its Details panel showing.
- Graph: it drew links. The scope is `path=app/`: `app/` links to `Cargo.toml`, `docs/`, `README` and `src/`, and `README` links to its tags, which show as small faint unlabeled dots. The footer reads `8/21 nodes · 7/37 edges`. The notes inside `docs/` are folded into the `docs/` node, so no note-to-note links show. In `graph@narrow.png` the `src/` and `Cargo.toml` labels overlap.
- Narrow layout: the app pane is under the shell (`cs pane new bottom`). It was built in the same workspace window after closing the right pane and clearing the shell, not in a fresh window.
- `workspace-flow`, first take: zsh's `%` marker appeared after `p=$(cs pane new right)`, so it was retaken. The second take is clean. An `opened src` notice appears briefly at the top of the file browser.
- Every window's title bar reads `↓ local ... Window 1` and carries an `A` badge.
- Clips: the window's rounded corners show a few dark pixels from behind the window, and two bottom-left corners show a tiny grey fragment, none of it readable.

## 4. Helpers and commands that failed or were replaced

- The owner's Chan was quit for the sitting, but the build came from `v0130/int` and ran from a re-signed copy launched by binary path. So `open --env ... "$APP"` was replaced by launching the binary directly with the environment set. The launch drops inherited `CHAN_*`, `CLAUDE*`, `TERM_PROGRAM` and `TERM_SESSION_ID`. Without the last two, bash in Chan's terminals ran Apple Terminal's session restore against Terminal.app's own session.
- `front`, `chanax`, `winid`, `size` and `say_in_chan` were rewritten to target the Chan process by pid, not by bundle id or the owner name "Chan". `front` reads the frontmost process's pid through System Events instead of `lsappinfo`. `winid.swift` filters on `kCGWindowOwnerPID` and was compiled once with `swiftc`.
- `say_in_chan` sends keys to whichever app is in front. In one early run, while the owner was still at the keyboard, setup lines landed outside the Chan window. Every key-sending helper now checks that Chan is frontmost before each key and stops otherwise.
- `cs pane close --pane pane-4` is refused (`unexpected argument '--pane'`): the pane id is positional, `cs pane close pane-4`.

## 5. Theme and retakes

- Chan came up dark by default (the system is in dark mode); no theme switch.
- Nothing was retaken for a personal detail. The host name appeared only in the bash prompt before each clean shell was set up, never in a saved frame. Paths in frames are the throwaway `/private/tmp/chan-captures.4gHoEE/...` only. Retakes for other reasons: S1 (pager), and `workspace-flow` (the `%` marker).

## 6. Output

Folder: `~/chan-home-captures-20261114` on the owner's Mac.

```
e72dbd668cef7d1cdea9805388433c4ecdd66d1ac2548ba5dbd7e2e3dcac85fb  editor@narrow.png
aaa3a2c0b4ab905d8b78eb4587f5b84eb0057a8aaaf728cd3cc46cfc2c453953  editor@wide.png
5e7f71270eaaf8c55db7b55e287c2ce072bd7512e1540ec6dfaaa12de600b023  files@narrow.png
c9daa5a344ff5f224b8fc5b6a6da2cd404e0635eedba8f7acc8324ff021b0fb6  files@wide.png
912be44cc290d963bbba8309feff4fbb95e375075e20613e81cb817f3ebab679  graph@narrow.png
31550aff5539cf5b8e5639a5b71c74362aada0ce12eabc9b186443197351aa17  graph@wide.png
c94e9567544e4ead0735d54b5bd70ff243a0ac495e5fa7275ce9c488ea6b36dc  open@narrow.png
236a483d1eb65a71f4820cd4fc5ffdb9989483abc8f43ddd5000ffb5e28d7c18  open@wide.png
37a6a51034aec958ca25176487e2539163f5c0144e808a31bc98f5e049f6f676  terminal-run.jpg
77c7b2fe2e93c411937fc7a37433303a639d95a7c41e174772fe939c3f872281  terminal-run.mov
34b2caeb635228727f3d12698177601894adaa0ea43b188f74c71dabe904959f  terminal-run.mp4
6f3ddbfdbd23b64c59f071836e0009da245892cb9f92be6fc78257ded83185b1  terminal-split@wide.png
5522e3a187d6123737d825568728c4371a466a772f5cd6dac19b1a9d10d3ccdc  terminal@narrow.png
a777d4bf577e8c7a3ec8de9b0108f49e88d0c2cf437e8376ec4f133ad991b101  terminal@wide.png
d8b763f626fd4759efb1a12918dae4da25800fd4ac6569ff593069069d2bf86c  workspace-flow.jpg
ef15165df1f7cb04a3f248dab2b08ca77569f168da4de618dc3c8a7402b74ba9  workspace-flow.mov
13b821849f49b23b01a3da57d048ce60898e65a77738b68f446763bdd1cd6014  workspace-flow.mp4
0165134619533e368ff7d93cbee1da126b5a141fa7d6316e4d0fb13f7b4a30ec  workspace-new@narrow.png
64a9bf5d885e0d3b7e1ec9502c3571fae7c242510626ef13a9320299c2ee13fd  workspace-new@wide.png
```
