# Owner desktop readings

These fixtures prepare readings; generating them does not pass a product check. Record candidate/build, OS, engine/version, machine, starting arrangement and actual result for every arm. Use `passed`, `failed`, `inconclusive` or `unavailable`. The automated page helpers use Linux WebKitGTK's inspector. WKWebView and WebView2 need their own adapter and are not covered by these helpers.

Bind the original inputs at reading time: `OWNER_DRAWING_DOC`, `OWNER_HUNG_DECK`, `OWNER_ARRANGEMENT`, `OWNER_ENGINE`, `OWNER_CANDIDATE` and, for the VM reading, `OWNER_VM`. These are owner inputs, not names of generated stand-ins. The generated drawing and deck are controls and never answer a reading of an original document.

## Prepare the disposable controls

Run commands in the owning guest, as its unprivileged desktop user. Name the candidate's built binaries and choose a new absolute directory. The generator refuses an existing directory and leaves `make-seed.py` unchanged.

```bash
export CHAN_BIN=/home/ubuntu/target/product/debug/chan
export CHAN_DESKTOP_BIN=/home/ubuntu/target/product/debug/chan-desktop
export FIXTURE_ROOT=/home/ubuntu/owner-control-01
export FIXTURE_TOOLS=/home/ubuntu/fixtures/scripts/e2e/desktop-observations
python3 "$FIXTURE_TOOLS/owner-fixtures.py" generate "$FIXTURE_ROOT"
python3 "$FIXTURE_TOOLS/owner-fixtures.py" verify "$FIXTURE_ROOT"
```

`fixture.json` records the initial file hashes and a unique recovery marker. The workspace contains a drawing with one rotated and one cropped picture, its embedding document, a three-slide deck, a connecting-page note, a recovery note and a drawing with exactly two differently colored rectangles sharing one input id. Preserve this initial manifest; later file hashes are observation outputs.

For native controls, launch a disposable desktop with its own home and runtime directory. The selected inspector port must be free inside the guest. Keep the shell holding these process variables until cleanup, and use only these recorded processes for stops. Do not point this recipe at the desktop or devserver hosting the team.

```bash
export HOME="$FIXTURE_ROOT/.home"
export CHAN_HOME="$FIXTURE_ROOT/.desktop-home"
export XDG_RUNTIME_DIR="$FIXTURE_ROOT/.run"
export TMPDIR="$FIXTURE_ROOT/.tmp"
mkdir -m 700 "$HOME" "$CHAN_HOME" "$XDG_RUNTIME_DIR" "$TMPDIR"
export OWNER_INSPECTOR=127.0.0.1:21061
export WEBKIT_INSPECTOR_HTTP_SERVER="$OWNER_INSPECTOR"
"$CHAN_DESKTOP_BIN" > "$FIXTURE_ROOT/desktop.log" 2>&1 &
FIXTURE_DESKTOP_PID=$!
"$CHAN_BIN" serve "$FIXTURE_ROOT"
```

Use a real desktop display or the existing Xvfb fixture. In a terminal inside this disposable workspace, set `OWNER_PAGE` to a unique substring of its inspector page listing, obtained with `node "$FIXTURE_TOOLS/inspect.mjs" "$OWNER_INSPECTOR" list`. Keep raw logs private: the listing, process logs and `cs window list` may carry throwaway credentials.

## 1. Original drawing picture in PDF

Open `OWNER_DRAWING_DOC` in its original arrangement. Confirm the picture is visible in preview. Use the document's Export to PDF action, open the PDF beside that preview, and compare presence, rotation and crop. Then, from a chan terminal belonging to that workspace/window, capture `cs export` through the wrapper:

```bash
export OWNER_ARRANGEMENT='caller window, renderer window, visibility and machine'
export OWNER_ENGINE='engine and version'
bash "$FIXTURE_TOOLS/owner-export.sh" "$OWNER_DRAWING_DOC" /absolute/new/drawing-export-01
```

Run it from the workspace's root and name the document by its workspace-relative path: `cs export` writes through the workspace, so the wrapper exports to a fresh name beside the document, moves that PDF into the evidence directory, and refuses an absolute document path. The wrapper records the source hash, build, window list, stdout, stderr, real command status and output hash. Its JSON explicitly leaves visual reading pending. Repeat with `drawing-picture.md` as a separate generated control. The plain teal image, rotated blue/magenta image and cropped green/orange image must match the page; the cropped image's brown outer ring must be absent from both page and PDF.

## 2. Original hanging deck and arrangement

Open `OWNER_HUNG_DECK` in the original arrangement and run the same export wrapper into a new directory for each arm. Record which window actually renders. Read every slide of the resulting PDF beside preview and play. Repeat with that renderer minimized, on another virtual desktop, and with a second window of the workspace on the other machine. Each arm has its own arrangement, raw logs and output hash. A successful generated `deck.md` control does not erase a timeout of the original deck.

The product's export operation bounds no-progress to 90 seconds and total work to 15 minutes; preserve whichever status it returns. A PDF file existing is not evidence that its pictures rendered. The wrapper never reuses an output directory or retries an export automatically.

## 4. Connecting-page hide through reconnect

Use a second fresh server home and a free guest loopback port for this control. The foreground server is independent of the desktop's embedded local workspace.

```bash
export FIXTURE_PORT=21062
mkdir -m 700 "$FIXTURE_ROOT/.server-home"
CHAN_HOME="$FIXTURE_ROOT/.server-home" "$CHAN_BIN" devserver run \
    --service=none --bind 127.0.0.1 --port "$FIXTURE_PORT" \
    > "$FIXTURE_ROOT/server-first.log" 2>&1 &
FIXTURE_SERVER_PID=$!
```

Register the launch URL printed by this fixture server as `owner-hide` in the disposable desktop, connect it, serve the generated workspace on `owner-hide`, and open one workspace window. Record its persisted window id and its single Hidden Windows count of zero.

A Reload does not reach the connecting page. A window whose devserver is down keeps its page and retries, and a connect or a desktop relaunch while the devserver is down builds no window. A window is on its connecting page only while it is being built, so the devserver has to stop answering after the desktop starts building the window and before the page's first probe is answered. On Linux WebKitGTK, with the desktop's log and the inspector at hand, these steps reach it:

1. Disconnect `owner-hide` (`"$CHAN_BIN" devserver disconnect owner-hide`). The window closes and the server's record of it stays shown.
2. Connect it again (`"$CHAN_BIN" devserver connect owner-hide`) and freeze the fixture server at once with `kill -s STOP "$FIXTURE_SERVER_PID"`, at the desktop's log line `build_workspace_window_with_completion` that names the window. A frozen server accepts the connection and never answers. A script that watches the log for that line is quick enough; a hand is not.
3. See the window on "Connecting to workspace" with its attempt count rising, and hide it there: the page's Disconnect once the page offers it, or the window's close. Both send the desktop the same close command, `request_close_window`, which a script can send from that page through the inspector.
4. Disconnect `owner-hide`. End the frozen server with `kill -s KILL "$FIXTURE_SERVER_PID"` and start it again with the identical command and home, capturing a new log and PID.
5. Before connecting, read the restarted server's window records (`GET /api/library/windows` with its token). The window is still published as shown there (a shown record carries no `hidden` field), so a window that stays hidden from here on is the desktop's doing and not the server's.
6. Connect `owner-hide` and wait thirty seconds.

`owner-connecting-hide.sh` is the script for these steps. It starts its own fixture server, disposable desktop and generated workspace under a fresh absolute directory, so it needs none of the setup above. Keep that directory's path to 44 characters or fewer: the desktop's control socket lives under it, and the script refuses a longer one with status 2.

```bash
bash "$FIXTURE_TOOLS/owner-connecting-hide.sh" /absolute/new/hide-01
```

It exits 0 when the hide held, 1 when the window opened by itself or its record is not one hidden window, 2 when the environment cannot run it and 3 when a step did not reach; its steps are in `steps.log` under that directory. It reads the server's records and X and not the Window menu, sends the close command from the connecting page, and reopens the window with `cs window open`.

Confirm the selected window stays hidden, appears exactly once under Hidden Windows, and is absent from the open list; the server's record of it now reads `hidden: true`, one record for the workspace. Reopen it once and confirm the same persisted id and the actual workspace page. Keep the desktop process alive throughout; a desktop restart tests another boundary.

By hand, on any engine, the same reading needs the real situation: a devserver that hangs rather than dies while one of its windows is being opened, so that the window sits on its connecting page. Hide it there, disconnect, and connect once the devserver answers again.

## 6. Recovery after a local desktop restart

Use the local workspace opened by `chan serve`, not the remote `owner-hide` workspace. For this generated control, opt the disposable origin out of document sessions before opening the note. An attached document can be acknowledged by the server while its disk save is blocked; that does not establish an unsaved edit held by the page's recovery buffer. The same opt-out is used by `hide-flush.sh`; it changes the fixture's session setting and writes no recovery entry.

```bash
node "$FIXTURE_TOOLS/inspect.mjs" "$OWNER_INSPECTOR" eval "$OWNER_PAGE" \
    "localStorage.setItem('chan.docsync', '0'); true"
```

Hide this workspace window and reopen it from Hidden Windows so the new page reads the setting. Wait until that window's own socket is connected and its page is usable; an inspector response alone does not establish control-client readiness. Verify the new page reports the opt-out, then open `recovery/note.md` and confirm its editor is editable before applying the save barrier:

```bash
node "$FIXTURE_TOOLS/inspect.mjs" "$OWNER_INSPECTOR" eval "$OWNER_PAGE" \
    "localStorage.getItem('chan.docsync')"
```

The result must be `"0"`. Now make the generated note's parent directory read-only with the helper. Opening the note after this barrier gives a filesystem-locked editor and cannot establish the pending-edit premise. The barrier prevents atomic file replacement while the already-open note remains editable. This is a control for a page-owned edit with document sessions off; it does not answer the attached-document case.

```bash
python3 "$FIXTURE_TOOLS/owner-fixtures.py" block-save "$FIXTURE_ROOT"
```

Type the exact `recovery_marker` from `fixture.json` through the real editor. Wait for the actual save error and confirm the marker is visible. Hide the window through its real Hide action; read the origin's storage from the surviving launcher page by setting `OWNER_PAGE` to that page. The read-only helper observes product-created `chan:editor-buffer:` entries and never writes localStorage.

```bash
bash "$FIXTURE_TOOLS/owner-controls.sh" reading "$FIXTURE_ROOT" /absolute/new/recovery-before.json
python3 "$FIXTURE_TOOLS/owner-fixtures.py" recovery-proof "$FIXTURE_ROOT" \
    --page-reading /absolute/new/recovery-before.json
```

Proceed only if this proves the marker in an actual recovery entry and absent from disk. Preserve the reported origin and the `embedded_port` in `$CHAN_HOME/desktop/config.json`. Quit only the disposable desktop, wait for `FIXTURE_DESKTOP_PID` to exit, and relaunch with the same home and environment while that saved port is free. The relaunched desktop may show no workspace window: one that had been ended with TERM came back with none, and whether one ended by its own Quit brings its window back is not established. If none comes back, serve the workspace again with `"$CHAN_BIN" serve "$FIXTURE_ROOT"`; the window it opens has a new id at the same origin. Reopen the note. A banner reads "Unsaved changes from a previous session were found." and offers Restore and Discard, with the editor showing the text on disk; record it, choose Restore and confirm the complete marker after that text. Capture another page reading: its origin must match the first. A fallback to another port is a separate limitation, not the stable-origin arm. Restore directory permissions with `allow-save` after the reading, including failed or abandoned readings; the helper only changes its generated `recovery` directory.

## 7. Duplicate drawing ids and two quick reloads

Open `duplicate-id.excalidraw` in the disposable workspace with scene sync enabled. Confirm the two rectangles and select that tab. Do not draw, rename or change its style during this reading.

Opening this control with scene sync on rewrites the file once, about a second after it opens: the second rectangle is saved under `repeated-id-2` and both elements at version 2. That save is the first open's, not a reload's. From then on the file must hold two elements and must not change, at the two reloads or after them. Reloads made at a person's pace fall after that save, on a file that no longer holds the repeated id: the reading holds there without a reload having met the repeat. Only reloads made within about a second of the open, before that save, fall on the repeat; a script that opens the drawing and triggers at once can make them, a hand cannot.

Set `OWNER_PAGE` to this workspace page, then run:

```bash
bash "$FIXTURE_TOOLS/owner-controls.sh" double-reload "$FIXTURE_ROOT" /absolute/new/reloads.json
```

The trigger uses the actual tab context menu and its Reload from disk action twice. It records both click times from the same page clock and refuses a gap of one second or more. It does not call internal store functions. A confirmation prompt, unavailable menu or paused page can make this inconclusive; two recorded clicks do not themselves prove the reloads completed. Observe both reloads in the page. No scene save follows them when they come after the first open's save, so do not wait for one: watch the file for two minutes instead and record a save in that time, or a third element, as a result. Reopen the drawing, then run:

```bash
python3 "$FIXTURE_TOOLS/owner-fixtures.py" check-scene "$FIXTURE_ROOT"
```

This file reading checks exactly two live rectangles with the original geometry and colors, permitting id repair. It returns 0 for a match, 10 for an inspected mismatch and 3 for malformed or inconclusive inputs, with a structured reason. An interpreter crash is not a mismatch verdict. It is only a disk check: combine it with the observed actions, their measured gap and whether the file changed after them. Record any extra copy or missing rectangle. Run the trigger only once per page load; a rerun needs a fresh page and a separate output.

## Record and remaining readings

For each visual outcome, capture a short factual reading beside its raw evidence:

```bash
export OWNER_RESULT=passed
export OWNER_CANDIDATE='<full candidate commit>'
export OWNER_ARRANGEMENT='the observed windows, service and origin'
export OWNER_OBSERVATION='what was shown, including any missing prerequisite'
bash "$FIXTURE_TOOLS/owner-controls.sh" record "$FIXTURE_ROOT" /absolute/new/reading.json
```

Rows 3 (pending edits at hide on WKWebView or WebView2) and 5 (one desktop retrying while another keeps its socket) require separate platform/client controls. They are not implemented by this pathspec. Row 8 repeats the original deck comparison separately on Linux, macOS and the named browser. Row 9 uses the owner's VM and control terminal to open their printed URL, with no service mutation. Row 10 requires the real gateway stack and native gateway readiness before restarting only its fixture devserver. Preserve those rows as pending owner or fixture work until their prerequisites and observations exist.
