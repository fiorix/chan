# Hybrid Nav: staged draft and diagram editors get a tab chip

Status: REGISTERED for v0.83.0, grounded 2026-08-02, ruled 2026-08-02, ready to spec.

## What

In Hybrid Nav, `t` / `o` / `g` / `b` each show a dimmed dashed ghost tab in the target pane the moment they are pressed, so the draft layout you are about to commit is visible before you commit it. `i` (new diagram) shows nothing. Press it and Nav looks unchanged until Enter, so there is no feedback that the intent registered and no way to tell one press from three.

`n` (new draft) has the same gap. Both keys queue through the same function, so this item covers both.

Pressing `i` three times should show three chips reading "New diagram" in the pane focused at each press, each removable on its own, and Esc should keep discarding the whole transaction as it does now.

## What is already known (grounding, verified 2026-08-02)

There are two staging mechanisms in Hybrid Nav, and only one of them can produce a ghost tab:

- `t` / `o` / `g` / `b` (`web/packages/workspace-app/src/App.svelte:755,760,765,770`) call `paneModeOpenTerminal` / `Browser` / `Graph` / `Dashboard`, which push a real tab into `paneMode.draft`. The ghost rendering then falls out for free: `paneModeStagedTabIds()` (`state/tabs.svelte.ts:4097`) diffs the draft against the live layout, `Pane.svelte:361` derives the set, and `Pane.svelte:1194` binds `class:staged` on the tab div. The dimmed dashed style is `Pane.svelte:1838`.
- `n` and `i` (`App.svelte:775,780`) both call `paneModeStageDraftEditor(kind)` (`state/tabs.svelte.ts:4078`; `paneModeStageDiagramEditor` at `:4089` is a one-line wrapper passing `"diagram"`). That pushes `{ paneId, side, kind }` onto `paneMode.stagedDraftEditors` (`:1138`, `PaneModeDraftEditorKind` at `:1119`) and touches the draft layout not at all, so `paneModeStagedTabIds()` cannot see it and no chip renders.

The split exists for a reason. A draft editor needs a file on disk first: `materializeStagedDraftEditors` (`App.svelte:1011`) drains the queue only after commit, awaiting `api.createDraft()` or `api.createDiagram()` per entry before `openInPane`. The server picks the name (`crates/chan-server/src/routes/drafts.rs:159,196`, `next_untitled_draft_name` with a race retry at `:239,262`), so at press time neither the path nor the final tab title is known to the client.

The queue already carries everything a per-pane render needs (`paneId` and `side` pinned at press time) and is already torn down on both exits: `commitPaneMode` clears it at `state/tabs.svelte.ts:3597` and `cancelPaneMode` at `:3609`.

## Contract

- Render from the queue, not from the layout. `Pane.svelte` gains a second chip source beside `visibleTabs` (`:112`): the `paneMode.stagedDraftEditors` entries whose `paneId` and `side` match this pane, rendered in queue order after the real tabs, reusing the existing `.tab.staged` style so staged is one visual language. No synthetic tab enters `paneMode.draft`, so `cloneLayoutState`, session persistence, and `killStagedTerminalSessions` are untouched.
- Label the intent, not a guessed file: "New draft" and "New diagram". The server owns the name and retries on collision, so any client-side prediction can be wrong by commit time.
- The chip carries a close affordance that drops that one queue entry (a small `paneModeUnstageDraftEditor`), and nothing else. No staged entry can be removed individually during Nav: a staged `t` / `o` / `g` / `b` tab renders a close button (`Pane.svelte:1329`), but `closeTab` resolves the pane in the live layout (`state/tabs.svelte.ts:1204`), where the staged tab does not exist, so the close does nothing. The only in-Nav undo is Esc, which discards the whole transaction; without the affordance, a stray `i` is stuck the same way. There is no selection behavior, because there is no tab to select.

## Rough size

Small, and entirely in the SPA. A derived per-pane filter over the queue, a chip block in the tab strip, one unstage function, and the source-pin tests in `state/paneModeStaging.test.ts` extended to cover the new render source and the removal path.

## Open

- A queue entry pins `paneId` at press time. If that pane is destroyed later in the same Nav transaction, `openInPane` at commit has no home for the file. Pre-existing in `materializeStagedDraftEditors`, made visible by the chip. Whether the chip re-homes, disappears, or the entry is dropped is not ruled here.
