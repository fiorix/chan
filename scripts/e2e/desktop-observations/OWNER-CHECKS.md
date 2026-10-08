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

Register the launch URL printed by this fixture server as `owner-hide` in the disposable desktop, connect it, serve the generated workspace on `owner-hide`, and open one workspace window. Record its persisted window id and its single Hidden Windows count of zero. Stop only `FIXTURE_SERVER_PID` with TERM and wait for that process to exit. Reload that selected window once until its connecting page is visible, then hide it from that page. Disconnect and reconnect `owner-hide` in the same desktop process. Restart the foreground fixture server with the identical command and home, capturing a new log and PID. Confirm the selected window stays hidden, appears exactly once under Hidden Windows, and is absent from the open list. Reopen it once and confirm the same persisted id and the actual workspace page. Keep the desktop process alive throughout; a desktop restart tests another boundary.

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

Proceed only if this proves the marker in an actual recovery entry and absent from disk. Preserve the reported origin and the `embedded_port` in `$CHAN_HOME/desktop/config.json`. Quit only the disposable desktop, wait for `FIXTURE_DESKTOP_PID` to exit, and relaunch with the same home and environment while that saved port is free. Reopen the note, record the Restore prompt, choose Restore and confirm the complete marker. Capture another page reading: its origin must match the first. A fallback to another port is a separate limitation, not the stable-origin arm. Restore directory permissions with `allow-save` after the reading, including failed or abandoned readings; the helper only changes its generated `recovery` directory.

## 7. Duplicate drawing ids and two quick reloads

Open `duplicate-id.excalidraw` in the disposable workspace with scene sync enabled. Confirm the two rectangles and select that tab. Do not draw, rename or change its style during this reading. Set `OWNER_PAGE` to this workspace page, then run:

```bash
bash "$FIXTURE_TOOLS/owner-controls.sh" double-reload "$FIXTURE_ROOT" /absolute/new/reloads.json
```

The trigger uses the actual tab context menu and its Reload from disk action twice. It records both click times from the same page clock and refuses a gap of one second or more. It does not call internal store functions. A confirmation prompt, unavailable menu or paused page can make this inconclusive; two recorded clicks do not themselves prove the reloads completed. Observe both reloads in the page and the next durable scene save, reopen the drawing, then run:

```bash
python3 "$FIXTURE_TOOLS/owner-fixtures.py" check-scene "$FIXTURE_ROOT"
```

This file reading checks exactly two live rectangles with the original geometry and colors, permitting id repair. It returns 0 for a match, 10 for an inspected mismatch and 3 for malformed or inconclusive inputs, with a structured reason. An interpreter crash is not a mismatch verdict. It is only a disk check: combine it with the observed actions, their measured gap and the later save. Record any extra copy or missing rectangle. Run the trigger only once per page load; a rerun needs a fresh page and a separate output.

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
