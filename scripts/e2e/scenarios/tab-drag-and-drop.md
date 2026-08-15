# Tab drag and drop

End-to-end expectations for moving a tab: between panes of one window, between two windows of one workspace, and across the boundaries a move must refuse. Owner-run: see [`../README.md`](../README.md) for the model and the rules that apply to every run.

Each scenario states behavior that must hold today. Where an executable check or test already proves it, that check is named under **Backing**; where none exists, the scenario says so and stays manual.

## What this covers

- every tab kind moves between windows and arrives as itself, never converted into another kind;
- a moved tab arrives with the state it left with, and the source releases it exactly once;
- a terminal moves its running shell rather than spawning a new one;
- a moved file is flushed first, and a moved draft is released rather than discarded or promoted;
- a move the target cannot complete is refused, and refusing leaves the source tab untouched;
- moves that must not happen — across workspaces, across libraries, between mismatched surfaces — still do not;
- the same holds in the shipped desktop WebViews, which are not Chrome.

## Why this pack exists

Drag and drop has no server round trip and no persisted artifact to inspect afterwards. The whole contract lives in one `DataTransfer` payload, written by the source window and read by a target that cannot see the source's memory. That makes it uniquely easy to break silently: a payload can be well-formed, accepted, and wrong.

It broke exactly that way. `crossWindowPayload` ended in a catch-all that returned `{ kind: "terminal" }` for every kind it did not explicitly list, so a dragged graph, file browser or dashboard tab announced itself to the other window as a terminal. The target read a terminal with no session id, opened a fresh one, and the accepted drop then closed the original in the source. Every layer behaved correctly on the data it was given; only the label was wrong. No unit test covered the payload, and no browser check drove two windows.

The lesson the pack encodes: assert the KIND that arrives, not merely that something arrived.

## When to re-run

Look up the area you changed and run the scenarios listed against it.

- **`crossWindowPayload`, `acceptCrossWindowTab`, or either drop handler**: TD-01, TD-02, TD-03, TD-07
- **A new tab kind, or a new field on an existing kind**: TD-01, TD-02 (the payload is the only place a kind decides how it travels)
- **`SerTab`, `serializeTab`, or any `restore*FromSer`**: TD-02 (a moved view-state tab is rebuilt through the reload path)
- **Terminal close sinks, `markTerminalMovingOut`, or the PTY registry**: TD-03
- **`closeTab`, the draft close flow, or autosave**: TD-04
- **Drag scope, `dragScopeMimeToken`, or window identity**: TD-05, TD-06
- **Anything in the desktop shell's WebView, or a Tauri version bump**: TD-08

## Scenarios

| ID | Scenario | Kind |
| --- | --- | --- |
| TD-01 | Every kind crosses as itself | automated (web) |
| TD-02 | A moved tab keeps its state | mixed |
| TD-03 | A moved terminal keeps its shell | mixed |
| TD-04 | A moved file is flushed; a moved draft is released | mixed |
| TD-05 | A move the target cannot complete is refused | mixed |
| TD-06 | Moves that must not happen still do not | mixed |
| TD-07 | Intra-window moves still work | mixed |
| TD-08 | The same holds in the desktop WebViews | manual |

The automated coverage runs from two places. Component cases run under the normal frontend test command from `web/packages/workspace-app`; the browser case runs through the smoke harness:

```sh
SMOKE_ONLY=124 node scripts/e2e/browser-smoke/run.mjs
```

---

### TD-01 - every kind crosses as itself

**Expectation.** Dragging a tab from one window of a workspace to another window of that workspace produces, in the target, a tab of the SAME kind. A graph arrives as a graph, a file browser as a file browser, a dashboard as a dashboard, a file as a file, an extension as an extension, a terminal as a terminal. No kind is silently converted into another, and the target gains exactly one tab.

A kind with no cross-window representation would have to refuse the drag outright rather than travel as something else. No kind is in that position today: all six carry a payload the target can rebuild.

**Why this is load-bearing.** This is the invariant the shipped bug violated, and it violated it while every individual step succeeded. A drop that is accepted and produces the wrong kind is worse than one that is refused, because the source has already let go.

**Run.** Browser check `124-tab-cross-window-drag.mjs` for the dashboard and file-browser kinds. For graph, file, terminal and extension, open two windows on one workspace and drag one of each.

**Backing.** `124-tab-cross-window-drag.mjs` drives the real dragstart and drop handlers across two real windows for two of the three kinds the catch-all used to swallow. `Pane cross-window transfer of view-state tab kinds` in `Pane.test.ts` covers the payload and the rebuild for graph, browser and dashboard at component level, and pins the exhaustiveness binding that turns a NEW kind into a compile error rather than a silent mislabel.

**Evidence.** The `application/x-chan-tab+json` payload as the source wrote it, the target's tab strip before and after, and the source's tab strip after the drop.

### TD-02 - a moved tab keeps its state

**Expectation.** A moved tab arrives with the state the user left it in, not a default instance of its kind. A graph keeps its mode, scope, depth, expansion, filters, inspector and selection. A file browser keeps its selection, expansion, scroll and inspector. A dashboard keeps its carousel slide, disabled slots and auto-rotate. A file keeps its path, mode and inspector. A terminal keeps its name, group and working directory.

The rebuilt tab carries a freshly minted id, so a move can never collide with a tab already live in the target window.

**Why this is load-bearing.** The view-state kinds cross through the SESSION serializer — the same `SerTab` a window reload writes, rebuilt by the same `restore*FromSer` functions. That is deliberate: a moved tab is exactly as faithful as a reload, and a newly persisted field has to be taught to one mapping instead of two that drift apart. The coupling is the point, and it is also the risk: anything that narrows what a reload preserves silently narrows what a move preserves.

**Run.** Set each kind to a non-default state, drag it to the other window, and compare every field named above. Reload the target window afterwards and confirm the moved tab survives that too.

**Backing.** `a graph tab rebuilt in the target keeps its view state` in `Pane.test.ts` covers mode, scope, depth, inspector and the fresh id for the graph kind. No check compares the full field set for browser or dashboard, and none covers the post-move reload.

**Evidence.** Each field before and after, side by side, and the target's session payload after the move.

### TD-03 - a moved terminal keeps its shell

**Expectation.** Moving a terminal moves the RUNNING shell. The target re-attaches to the same PTY by session id, keeping scrollback, working directory, group and environment; it does not spawn a fresh shell. The source releases the tab without killing the process, and no confirmation prompt appears — a move is not a destroy. A terminal that never spawned, or whose shell exited, carries no session id and correctly opens fresh in the target.

**Why this is load-bearing.** A terminal may hold a long-running agent. Respawning it instead of moving it destroys work that has no undo, and the visual result — a terminal tab in the target window — looks identical either way.

**Run.** Start a distinctive long-running process, note the PID and scrollback, drag the terminal to the other window, and compare PID, scrollback and cwd. Confirm the source window shows no close confirmation.

**Backing.** `a terminal carrying a live session still re-attaches by id` in `Pane.test.ts` pins the payload. The re-attach itself has server-side coverage in the terminal session tests. No browser check drives a cross-window terminal move.

**Evidence.** The PID and cwd before and after, the scrollback in the target, and `chan ps --json` across the move.

### TD-04 - a moved file is flushed; a moved draft is released

**Expectation.** Moving a file tab with unsaved edits flushes the buffer to disk first, because the target window reads the file from disk — an unflushed move would silently roll the edits back. If that save fails, the tab stays in the source window rather than disappearing: a tab visible in two windows is recoverable, a buffer that reached neither disk nor a window is not.

Moving a DRAFT releases it. The draft's promote / discard / cancel flow must not run: the discard would delete the file the target just opened, the promote would move it out from under the target's path, and the cancel would leave the same draft open in both windows. An empty or pristine-seed draft is the sharpest case, because the ordinary close path discards it with no prompt at all.

**Why this is load-bearing.** Drafts are unpromoted user writing with no other home. This is the one path where a drag can destroy a file outright, and it destroys it in the window the user dragged AWAY from, where they are no longer looking.

**Run.** Drag a dirty file tab and confirm the target opens the edited content. Drag an empty draft, a seeded draft, and a draft with attachments, and confirm each survives on disk at its original path with no dialog.

**Backing.** `a draft moved to another window is released, not discarded`, `a dirty file moved to another window flushes to disk first`, and `a move whose save fails keeps the tab rather than losing the buffer` in `tabs.test.ts`. No browser check drives a draft across windows.

**Evidence.** The file on disk before and after, the target's rendered content, and the absence of any draft dialog in the source.

### TD-05 - a move the target cannot complete is refused

**Expectation.** When the target cannot rebuild what it was handed — a snapshot naming a kind it does not know, an extension id it rejects — it refuses the drop rather than accepting an empty one. Refusing means not calling `preventDefault`, which leaves `dropEffect` at `"none"`, which is what tells the source to keep its tab. Nothing is created in the target and nothing is lost in the source.

**Why this is load-bearing.** `preventDefault` is the entire acceptance signal, and it used to be called BEFORE the target knew whether the rebuild worked. Any failure past that point destroyed the tab. Two windows on different builds is the realistic way to reach it.

**Run.** Point two windows at one workspace from different builds — one that knows a kind the other does not — and drag that kind across. Then drag an extension tab whose id the target rejects.

**Backing.** `an unrebuildable snapshot is refused instead of swallowing the tab` and `a drop is claimed only after the adopt succeeds` in `Pane.test.ts`. No browser check drives a version-mismatched pair.

**Evidence.** The source tab still present, the target unchanged, and the pointer showing no-drop.

### TD-06 - moves that must not happen still do not

**Expectation.** A tab move is refused across a workspace boundary and across a library boundary, and the drag scope that decides this deliberately does NOT include the window id, so two windows of one workspace stay compatible. The refusal shows a no-drop cursor at `dragover`, not just a failure at drop. A workspace-key collision across two libraries stays refused.

**Run.** Open two windows on different workspaces and attempt a move each way. Repeat across two libraries. Confirm the cursor during the drag, not only the outcome.

**Backing.** The scope tests in `Pane cross-kind / cross-workspace tab DnD guard` in `Pane.test.ts` pin the scope construction, its hex encoding for WKWebView, and both `dragover` rejections. Those are source-level assertions; no check drives a real cross-workspace drag.

**Evidence.** The pointer during each drag and both windows' tab strips afterwards.

### TD-07 - intra-window moves still work

**Expectation.** Every kind still moves between panes of one window and reorders within a tab strip, including kinds whose cross-window behavior changed. An intra-window move is decided by window identity rather than pane id, because pane ids are a per-window counter and collide across windows.

**Why this is load-bearing.** The cross-window payload and the intra-window move ride different MIME types on the same gesture. A change to one is one edit away from disabling the other, and the intra-window move is by far the more common action.

**Run.** In one window, split a pane and move each kind between the panes, then reorder tabs within a strip.

**Backing.** `Pane cross-window tab DnD (pane-id collision fix)` in `Pane.test.ts` pins the window-identity rule at source level. No check drives an intra-window drag.

**Evidence.** Both panes' tab strips after each move.

### TD-08 - the same holds in the desktop WebViews

**MANUAL.** No automated coverage is possible today, on any platform.

**Expectation.** Everything above holds in the shipped desktop apps, between two `chan-desktop` windows: WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows.

**Why this cannot be automated.** Two distinct limits stack. No browser automation protocol can perform a drag between two top-level windows — CDP's drag interception is per-page, so even the Chrome arm replays the payload rather than performing the gesture. And the desktop shells expose no automation endpoint at all: `terminal-pixels.mjs` reaches WebView2 only by hosting a page inside a built `chan-desktop.exe`, which is enough to measure pixels and not enough to drive a two-window drag.

**Why it must still be checked.** These engines have already diverged from Chrome on this exact surface. WKWebView mangles a MIME type containing `:` or `|`, which is why the drag scope is hex-encoded through `dragScopeMimeToken` — without that encoding every drop is rejected, and no Chrome check can see it. `webview-flip-render.py` exists because WebKitGTK ignores a CSS property Chrome honors. A green web suite is not evidence about these engines; it is evidence about Chrome.

**Run.** On each of the three platforms, with a release desktop build: open two windows on one workspace (`cs window new`), and perform TD-01 for every kind, TD-03, TD-04's draft case, and TD-06's refusal, using a real pointer drag. Record the platform, the OS version, the app version and the commit.

**Evidence.** Per platform: a screenshot of both windows after each move, the payload observed in the WebView inspector where one is available, and an explicit statement of which scenarios were run and which were skipped.

## Standing decisions

- **A kind decides how it travels, and the compiler enforces that it decides.** `crossWindowPayload` is exhaustive over the `Tab` union and ends in a `never` binding, so adding a seventh kind is a compile error rather than a silent inheritance of someone else's payload. The catch-all it replaces is the whole reason this pack exists.
- **View-state kinds cross through the session serializer, not a bespoke payload.** A moved graph, browser or dashboard tab is rebuilt by the same code a reload runs. One mapping, one fidelity guarantee, one place to teach a new field.
- **A move is not a destroy, on either side.** The source releases a terminal without killing its shell and a draft without discarding or promoting it. Any close path that asks the user a question is the wrong path for a move, because the question arrives after the tab has already left.
- **Acceptance is claimed only after the rebuild succeeds.** `preventDefault` is the signal that makes the source let go, so it is called last, never in anticipation.
