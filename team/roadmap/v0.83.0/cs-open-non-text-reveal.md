# `cs open` on a non-text file reveals it, and views it when the type has a viewer

Status: REGISTERED for v0.83.0, grounded 2026-08-02, ruled 2026-08-02, ready to spec.

## What

`cs open` on a media file refuses:

```
$ cs open projects/commercials/scenes/chan-future/out/chan-future-12s-1080p.mp4
Error: cannot open binary file projects/commercials/scenes/chan-future/out/chan-future-12s-1080p.mp4
```

It should land the file browser on that file, selected, with the inspector open, and raise the file's viewer on top of it.

The refusal is removed for the whole non-text class, not just media. For an existing path `cs open` becomes: directory -> file browser entered on it; editable or sniffed text -> editor tab; anything else -> file browser with the file selected and the inspector open, plus the media viewer when the SPA can view the type. A missing path keeps today's create-then-open behavior, and `write_text`'s own refusal of a binary-class name is unchanged. A path that escapes the workspace root still refuses. The string `cannot open binary file` is deleted.

`POST /api/open` (the command launcher's Open) inherits all of it, because both callers ride one `open_path`.

## What is already known (grounding, verified 2026-08-02)

The semantics live in one function and are never reimplemented:

- `open_path` (`crates/chan-server/src/control_socket.rs:3954`) is called by both the `cs open` control-socket handler and `routes/open.rs`. Its four branches are empty-path -> browser at root, dir -> `OpenBrowser` with `enter: true`, `is_editable_text` or `sniff_is_text` -> `OpenFile`, else the refusal at `:3999`. Only that last branch changes.
- `WindowCommand::OpenBrowser` (`:62`) already carries `select: Option<String>` alongside `path`, `enter`, and `destination`, and the SPA already honors it: `handleWindowCommand` (`web/packages/workspace-app/src/state/store.svelte.ts:1598`) routes a non-`enter` frame to `revealPathInBrowser(select ?? path, { inspectorOpen: true, destination })`.
- `select` has no producer today. Both `OpenBrowser` construction sites (`:3970`, `:3983`) pass `None`, so this item is its first real use. The field and the SPA branch that reads it are already tested (`control_socket.rs:5119`, `state/store.test.ts:705`).

The viewer router already exists and is already shared:

- `openMediaViewer(path)` (`web/packages/workspace-app/src/state/mediaOpen.ts:33`) maps image and SVG to the image zoom with the same-directory sibling set, video to the video viewer, PDF to the PDF viewer, and returns `false` for everything else including `.mp3`. It is the single mapping behind the file browser's double-click / Enter (`components/FileTree.svelte:520`) and the inspector's main media action (`components/FileInfoBody.svelte:637`).
- The classifiers it uses (`isImage` / `isVideo` / `isPdf`, `state/fileTypes.ts:286,297,306`) exist only in TypeScript. `chan-server` has no media classifier; `routes/graph.rs:541,784` has narrow graph-local helpers that are not this list.

## Contract

- Server: `open_path`'s final branch stops returning `Err` and sends `OpenBrowser { path: parent_rel(&rel), select: Some(rel), enter: false, destination }`. `parent_rel` (`control_socket.rs:4067`) already exists for exactly this shape. The server decides "not text", nothing more.
- SPA: in the `open_browser` non-`enter` branch, after `revealPathInBrowser`, call `openMediaViewer(frame.select)`. A `false` return means the type has no viewer and the reveal alone stands. The trigger is the frame shape, not a new wire field: the server cannot name "media" without forking the classifier into Rust, and the SPA already owns the only list. If a reveal-without-view caller ever appears, that is when an explicit flag earns its place.
- The browser tab: `revealPathInBrowser` spawns a new file-browser tab per call and does not dedupe. That stays. Reuse would change `cs open <dir>` and every launcher Open too, and needs its own rule for which tab wins across panes and sides.
- `.mp3` reveals and selects but does not view, because `openMediaViewer` returns `false` for audio until an audio preview surface lands.

## Rough size

Small. One branch in `open_path` plus its tests, one call in the SPA's `open_browser` handler, and the removal of the refusal string and the tests that pin it (`control_socket.rs:5219`, `routes/open.rs:288`). No new wire field, no new tab kind, no classifier work.

## Open

- Browser-tab reuse on repeated `cs open`. Ten `cs open out.mp4` calls leave ten file-browser tabs. Pre-existing for directories, more visible once media stops erroring. Deliberately not in this item.
- Whether `.mp3` joins the viewer path here or waits for the audio preview UI carried on [video-preview-and-range-serving](../done/video-preview-and-range-serving.md).
