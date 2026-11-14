# Report: second take of the home page captures

## 1. Versions

- macOS 27.0.1.
- Chan 0.130.0 (build git-826adee911a6): the same local signed release build of `v0130/int` at 826adee91 as the first sitting, run from a re-signed copy under bundle id `app.chan.desktop.v0130test` by binary path. The installed app is 0.129.0. The owner's Chan was quit for the sitting.
- Display: built-in Liquid Retina XDR, `Resolution: 3456 x 2234 Retina`, main display, 2x. Every window was placed at {80, 80} on it.
- The clone: `git clone --depth 30 https://github.com/fiorix/chan.git` at 826adee (`chore(release): 0.130.0`), which the log shows as `HEAD -> main, tag: v0.130.0, origin/main`. The clone is 4018 tracked files; the workspace indexed 4017 files.

## 2. Files

All stills were taken with `screencapture -o -x -l <window id>`. The narrow size is 640x600 points, not 480x450 (see 3), so every `@narrow` file is 1280x1200, not 960x900.

- `terminal@wide.png` 1760x1100.
- `terminal@narrow.png` 1280x1200.
- `open@wide.png` 1760x1100, terminal drawn inactive (the new workspace window had the focus).
- `open@narrow.png` 1280x1200, terminal drawn inactive: resized by name through System Events while the workspace window stayed in front.
- `workspace-new@wide.png` 1760x1100, and `workspace-new@narrow.png` 1280x1200. The new window shows only an animation that changes shape every few seconds. I took six frames 1.5 s apart and kept the one with the most visible figure; the others were near-empty or dim.
- `files@wide.png` 1760x1100, app pane active, Details closed.
- `files@narrow.png` 1280x1200, bottom split, app pane active, Details closed.
- `shell-editor@wide.png` 1760x1100, and `shell-editor@narrow.png` 1280x1200. The shell reads `w=$(cs window new); w=${w#*::}`, not `w=$(cs window new)` (see 4).
- `editor@wide.png` 1760x1100, Outline open, Details closed.
- `editor-panels@wide.png` 1760x1100, both open.
- `editor@narrow.png` 1280x1200, both closed.
- `shell-graph@wide.png` 1760x1100, and `shell-graph@narrow.png` 1280x1200.
- `graph@wide.png`, `graph-alt1@wide.png`, `graph-alt2@wide.png`, `graph-details@wide.png` 1760x1100; `graph@narrow.png` 1280x1200. See 6.
- `terminal-run@wide` (11.1 s), `terminal-run@narrow` (8.1 s), `files-run@wide` (13.1 s), `files-run@narrow` (13.1 s): each a `.mov` (120 fps source), an `.mp4` (30 fps, the order's ffmpeg line) and a `.jpg` poster. Typed with System Events `keystroke`, one character every 75 ms (about ten a second with overhead).

## 3. Sizes

- Wide: 880x550 accepted.
- Narrow: the workspace and terminal windows will not go below 640x400 points. `min_inner_size(640.0, 400.0)` is set for those windows in `desktop/src-tauri/src/serve.rs`. A request for 480x450 gave 640x450. At the 16:15 proportion the smallest is 640x600, so the narrow set is 640x600 points, 1280x1200 pixels. The terminal at that width has 74 columns, so the narrow terminal frame and clip still leave out `git log` as asked.

## 4. The second window

- `cs window new` prints the new window's id with its library prefix, `local::w-…`. The window opens at 1200x800, centred, and shows the same changing animation as `workspace-new` until a tab arrives.
- `cs open README.md --window "$w"` with that prefixed id fails every time with `window "local::w-…" is not connected`. Waiting does not help: three attempts, the last after the new window's `/ws` events socket was confirmed live 1.6 to 1.7 s after `cs window new`. The same command with the bare `w-…` id works at once (`cs pane list --window local::w-…` fails the same way, and the bare id works). `cs window new` hands back an id that `--window` does not accept; this looks like a bug.
- Workaround used for every shot: `w=$(cs window new); w=${w#*::}`, typed in the first window's shell, so the prefix is stripped and `cs open README.md --window "$w"` replies `open request queued for README.md`. The README then opened at once in the second window's editor, rendered from its top, with Outline and Details both open.

## 5. The panels

- File browser Details: closed with Cmd+Y with the file browser focused. A file browser opened afterwards in a new tab came up with Details open again; it does not stay closed. So both `files-run` clips show Details open as it comes, and Details was closed with Cmd+Y only after the recording, before the `files` still.
- Editor Outline and Details: no default shortcut. They were toggled through the command launcher (Cmd+K, type `Details` or `Outline`, Return on the top match `Details · Editor` or `Outline · Editor`, then Esc). A toggle item leaves the launcher open, so Esc closes it. Each panel's own close button also works.
- Graph Details: closed with its close button. Every new graph tab opens with Details open.

## 6. The graph

The bare `cs graph --window "$w"` opens `path=chan/` at the workspace root: 38 nodes, the top level as a fan, labels colliding. The arrangements saved:

- `graph@wide.png`: `cs graph crates --window "$w"` (run from `~/src/chan`; PATH is resolved against the caller's cwd, see 8), Details closed, then 11 lines of scroll-wheel zoom toward the crate fan. Depth 2. All 18 crate directories fan out from `crates/`, labelled, with the crates' own files (markdown orange, source blue, folders grey) dimmed behind and their links visible. A few labels still touch (`chan-server/` with `chan-tunnel-proto/`, `chan-tls/` with `chan-systemd/`, `chan-shell/` with `chan-metrics/`). The force layout differs on every open; this was the fourth open of `crates`.
- `graph-details@wide.png`: the same view after a click on `crates/`, which opens Details on it (465 files, 77 subdirectories, 15.2 MB, file kinds, code).
- `graph-alt1@wide.png`: `cs graph .agents --window "$w"`, Details closed, no zoom. `.agents/` opened under `chan/`, its notes (`README`, `principles`, `playbook`, `patterns`, `gateway`, `writing-rules`, `desktop`) and `skills/`, `orchestration/`, with the notes' links across the repo dimmed behind.
- `graph-alt2@wide.png`: `cs graph crates/chan-workspace --window "$w"`, Details closed, no zoom, the second open. `chan/` → `crates/` → `chan-workspace/` with `README`, `design`, `Cargo.toml`, `src/` and `tests/`. `src/` grazes `README`. The third open of this path; the second had `README`, `tests/` and `Cargo.toml` stacked.
- `graph@narrow.png`: `cs graph crates`, Details closed, 8 lines of zoom toward the fan. Several labels on the right collide at this width.

Also tried: Depth from the tab's right-click menu (one click on the slider track set 4: 551 nodes, too dense) and a double-click on `src/` inside `chan-workspace/` (opens it in place: 60 files, labels unreadable). Neither was saved.

## 7. What looks wrong at these sizes

- The windows refuse widths below 640 points (3).
- Graph at 640 wide: the status bar wraps (`134/4470 nodes · 257/11431` then `edges` on a second line) and its hint text is cut with an ellipsis (`double-click a directo…`).
- Graph, all sizes: neighbouring labels overlap in the default layout. Zoom helps; there is no setting that spaces them.
- Second window's tab strip: with several graph tabs open the strip scrolls with `<` `>` arrows, and the first visible tab's title is cut (`< :es/`, `< ath=.agents/`). This was only seen while exploring, not in a saved frame.
- File browser at 440 points: Details takes about half the pane, and names are cut with an ellipsis (`chan-revtun…`). Seen in the clips, which show Details as it comes.

## 8. What else Chan did that the order did not expect

- `cs window new` prints a library-prefixed id that `--window` refuses (4).
- `cs graph <PATH>` resolves PATH against the caller's working directory and refuses with `path escapes workspace root` from outside the workspace.
- The Depth slider in the graph's right-click menu: after a click on the track and Esc, the pane kept a translucent blue overlay that Esc and a canvas click did not clear, and the canvas click re-selected the workspace (`path=workspace`). Closing that graph tab (Cmd+W) cleared it.
- The new workspace window and the second window show an animation that cycles through several shapes, not one fixed image.
- The editor's Outline and Details have no keyboard shortcut; the file browser's Details is Cmd+Y.

## 9. Helpers and commands that failed or were replaced

- The first sitting's helpers were used, not this order's: the pid-targeted ones, with a check before each key, inside the same `osascript`, that Chan is in front. The clean shell is this order's step 7, plus a last line that writes the shell's `CHAN_*` variables to a file behind the `clear`, so `cs pane focus`, `cs window rm`, `cs pane close-tab` and `cs graph` could be run against the window from outside.
- New helpers: a Swift mouse tool for clicks (Details close buttons, a node click, double-click) and wheel zoom on the graph, and a launcher toggle (Cmd+K, query, Return, Esc).
- `cs open README.md --window "$w"` failed with `window "local::w-…" is not connected` until the prefix was stripped (4).
- `cs graph crates --window …` from outside the workspace failed with `path escapes workspace root`; it was run from the clone.
- The order's `type_in_chan` (one `osascript` per character) was not used; one `osascript` types the whole line with a front check before the first key and before Return.

## 10. Retakes

- `workspace-new@*`: chosen from six frames of the animation, for a visible figure.
- `graph@wide.png` and `graph-alt2@wide.png`: graph tabs reopened for a less crowded random layout.
- `shell-editor@wide.png`: the second window was created five times (removed with `cs window rm` in between) while finding the id problem; the saved frame is the fifth, with `w=$(cs window new); w=${w#*::}`.
- Nothing was retaken for a personal detail. The only path in any frame is `/private/tmp/demo/src/chan` (`open@*`) and `…demo/src/chan` in a graph Details panel not saved.

## 11. Output

Folder: `~/chan-home-captures-20261114-take2` on the owner's Mac.

```
ee8885a98383d60fbcf615815740fa91b43b9dfff2e25b3e483d4cd7b4b74055  editor-panels@wide.png
692c3bbfbb381c8d0e43e65b2aaa60c3c4ef87968947fb5b079e9ff83d7e7cf6  editor@narrow.png
d507d4c7902bade30e9de2a81caa37c7edf8c5fb7c7edb519294382290b7d7f1  editor@wide.png
c03caa3faf4fe50d6ff447c5df445a30c00927df16a275db5d6613c33954ac73  files-run@narrow.jpg
4160008a7ff29e1a96b002ed964a15d8cc4b1482fa1e74baa2c410a71405e4dc  files-run@narrow.mov
1a7a42ebfaf0e8aedfcbe0a47de21cf821cd6f7c9a7a05e478a716fd52d90ace  files-run@narrow.mp4
89b10716993c5ad62015a2d54b92470326985f7b37c85d08fbec096d01fc30f9  files-run@wide.jpg
31a68381c37f38ffb577af5062d51791ddbe73ecdc2f7547fa55ce612c91719e  files-run@wide.mov
fee56a891da932bc636bf65cee523eabbb1b0809cfb1e386acf41d080b4933fc  files-run@wide.mp4
cc2ed7df27e42c5bf4701f37873907fd24de9c3c6e71f54316e5e1b55e6fb387  files@narrow.png
72adff46439c9d98588c437fff9fc1a65474969dd35525c1ea1e33f91861b41e  files@wide.png
bb7df8df717e5392ce164fa2c9b446bddcb6410bd488d827181013e4d06bd07b  graph-alt1@wide.png
3889ce9dfaf1aa409ac2a3d819083a3ea4bef131a39013ff592e1f1446109a95  graph-alt2@wide.png
a229f9868ab525b37b01c74da20c82ca2cd8f256bc58751976e978795ec28728  graph-details@wide.png
f0fdb8a54543b94b90f159dbb739ed5d734ad56f631e14b43248f34ea479690d  graph@narrow.png
c97b0c4b54bf92c7089f4ade0db1a7f3df296dce41fe8e49664d92dc5a81b40d  graph@wide.png
de9a8f7fb40b45d70d68c4ca295909fdfe9802fc55d42b98c18a99535dddb4dd  open@narrow.png
d0f8ff1c7c853d478324d7dc06af7fcdaf4a049091c6851374fcfe6cb2d8a302  open@wide.png
467cf7e44c85d495233a5f0c95d74115ae139297dae3d3c03e0b5f2edefd3d3b  shell-editor@narrow.png
a0f6927294d307804c7d6c74c61266c1c4dc0c0606594a2f688ea48beab33cb4  shell-editor@wide.png
5402d7cfc1d452eba9a496f8e4fb20134e2a503e0825182f58abe7b3ea8657c6  shell-graph@narrow.png
8f6d78c07aeb17e3ef0a9fa7095b402314b2d64317cf32308ccfcc9f132c4eab  shell-graph@wide.png
253ffc414f999a2eff4f8c9ff4010366dc1884ebef49925124f8b29e7f290a83  terminal-run@narrow.jpg
9e42eda4179c849f05ec35ffb5a3aea6a2aab55a748c2402d9fda850673c325b  terminal-run@narrow.mov
79652311ea69c4bc34a80589eb93d397d9e3edf7f4e73fd9b41463c855fdd6db  terminal-run@narrow.mp4
e163c153e0b0d06e3358292a8a8adf807354ead6692dfbb1d9cbb05f4bbb4878  terminal-run@wide.jpg
06a1af4d20224e208fad5e242a98588e9a66ce9323672a7ce4a91eb5511234c5  terminal-run@wide.mov
cd40ca04ea44c9d30eafeef3061d57c733b746ee5199c2776cc3bbbf5127235c  terminal-run@wide.mp4
ed5324ce0570a225e676dbeb3948aa28a836a66ee8fcd952a6630a12ce2866f7  terminal@narrow.png
21ca0243b18b74b7b742a3e73d56cd16ab86cb39c7440bda0c740e88ef455dd7  terminal@wide.png
38a31d898a029451a3275828650058776b87528d500783f97ffd55a92553fcfd  workspace-new@narrow.png
ae9a450a0e257fb2ea584363472404aa4b18c35b43ce04c5a53263617774275b  workspace-new@wide.png
```
