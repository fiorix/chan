# `cs open` non-text reveal and audio preview

Status: REGISTERED for v0.84.0, grounded 2026-08-02, specified 2026-08-03, ready to implement.

## What

`cs open` currently refuses an existing non-text file. It should instead open a
File Browser at the file's parent, select the file, open the inspector, and
raise a viewer when the SPA supports that file type.

This item also adds browser-native audio support for `.mp3`, `.wav`, `.aif`,
`.aiff`, and `.ogg`. Audio gets an inline inspector player and a dedicated
viewer. The server serves bytes and MIME types; it does not decode or transcode
media.

`POST /api/open` gets the same behavior because it and `cs open` share
`open_path`.

## Verified current state

- `open_path` in `crates/chan-server/src/control_socket.rs` owns all path
  routing for both callers. Its existing non-text branch returns `cannot open
  binary file`.
- `WindowCommand::OpenBrowser` already carries `path`, `select`, `enter`, and
  `destination`. The SPA's `handleWindowCommand` already reveals a non-entered
  selection with the inspector open.
- `openMediaViewer` in
  `web/packages/workspace-app/src/state/mediaOpen.ts` is the shared viewer
  router for File Browser activation and inspector actions. It returns `false`
  when no viewer owns the path.
- Media classification is intentionally SPA-owned. `isImage`, `isPdf`, and
  `isVideo` live in `state/fileTypes.ts`; the Rust file classifier has no
  equivalent viewer taxonomy.
- `/api/files` already provides bounded byte ranges for binary files. Audio
  needs content types and UI routing, not another transfer path.
- The completed video-preview item explicitly left audio UI and mixed-media
  viewer navigation for follow-up.

## Contract

### Path routing

The shared `open_path` decision table is:

| path | result |
| --- | --- |
| empty or workspace root | File Browser at the workspace root |
| existing directory | File Browser entered into that directory |
| existing editable or sniffed text | editor tab |
| existing non-text file | File Browser at its parent, file selected, inspector open, supported viewer raised |
| missing path | today's create-through-`write_text`, then editor behavior |

The existing non-text branch sends:

```text
OpenBrowser {
  path: parent_rel(rel),
  select: Some(rel),
  enter: false,
  destination,
}
```

The branch no longer returns `cannot open binary file`. The empty, directory,
text, and missing-path branches do not change. `write_text` still refuses a
missing binary-class filename, and every branch still rejects paths that escape
the workspace root.

On an `open_browser` frame with `enter: false`, the SPA first reveals the
selected path and opens its inspector, then passes `select` to
`openMediaViewer`. A `false` return leaves the reveal in place without an
error. No viewer capability or media kind is added to the wire protocol.

Every invocation continues to create a new File Browser tab. This item does
not add tab reuse or deduplication.

### Audio classification and serving

Add a standalone `isAudio(path)` classifier with exactly these
case-insensitive extensions and response MIME types:

| extension | `Content-Type` |
| --- | --- |
| `.mp3` | `audio/mpeg` |
| `.wav` | `audio/wav` |
| `.aif`, `.aiff` | `audio/aiff` |
| `.ogg` | `audio/ogg` |

`classifyPath` continues to classify these as binary. Audio is a viewer
capability, not a new file or wire kind.

The existing `/api/files` token and range behavior is unchanged. Both audio
surfaces build their source URL with `withTokenQuery`, matching image and video
media elements that cannot set an Authorization header.

### Audio surfaces

- `FileInfoBody.svelte` recognizes `isAudio`, shows an inline
  `<audio controls preload="metadata">`, and exposes a `View Audio` main action.
- `openMediaViewer` routes audio to a dedicated, setless viewer. It has one
  path, one `<audio controls preload="metadata">`, and no previous/next or
  mixed-media playlist behavior.
- Audio never autoplays. Opening either surface may load metadata but must not
  start playback.
- Close, Escape, and empty-backdrop click dismiss the viewer. Dismissal pauses
  playback, removes `src`, calls `load()`, removes the key listener, and removes
  the viewer, matching the video teardown contract.
- A browser decode or container rejection does not undo the File Browser
  reveal. The inline player or viewer reports:

  ```text
  This audio format is not supported by this browser.
  ```

  The error is local to that media element; it is not recast as an open-path
  failure.

## Implementation shape

Server and shared routing:

- Change only the existing non-text branch in
  `crates/chan-server/src/control_socket.rs`; reuse `parent_rel` and the current
  `OpenBrowser` frame.
- Keep `crates/chan-server/src/routes/open.rs` on the shared `open_path` path.
- Extend the static asset/file content-type mapping for the five extensions.
  Do not add a Rust media classifier.

SPA:

- Extend `state/store.svelte.ts` to invoke the shared viewer router after a
  non-enter reveal.
- Add `isAudio` in `state/fileTypes.ts` and route it in `state/mediaOpen.ts`.
- Add a small audio viewer helper beside `state/videoViewer.ts`, reusing its
  token URL and teardown pattern but setting `autoplay` to false.
- Extend `components/FileInfoBody.svelte` with the audio kind, player, error
  state, and `View Audio` action.

No new API, tab kind, session field, codec library, or server-side media probe
is required.

## Acceptance checks

Automated coverage must prove:

- `open_path` emits the parent/select/non-enter frame for an existing binary
  file, while root, directory, text, missing, binary-class missing, and
  workspace-escape cases retain their current results;
- `POST /api/open` inherits the same existing-non-text result;
- the SPA reveal happens with the selection and inspector before viewer
  routing, and an unsupported non-text file remains a successful reveal;
- all five audio extensions are case-insensitive, map to the specified MIME
  types, remain binary to `classifyPath`, and route to audio rather than video;
- the inline and fullscreen players are paused on creation, use tokenized URLs,
  and tear down completely on every close path;
- an intentionally undecodable audio fixture produces the exact unsupported
  message without closing or losing the selected File Browser tab; and
- existing image, PDF, video, text, directory, missing-path, and escape tests
  remain green.

Add one real-browser smoke using a deterministically generated PCM WAV rather
than a committed media fixture. Through the real control socket, run `cs open`
on that WAV and assert a new File Browser tab, the selected file, the open
inspector, and the audio viewer. Assert no autoplay, then play, seek, and close
the element. Extension and MIME breadth belongs in unit/integration tests; the
smoke does not need a codec matrix.

## Boundaries

- No server-side decode, transcoding, waveform, metadata extraction, or codec
  compatibility promise.
- No custom audio controls or autoplay.
- No audio playlist or mixed-media previous/next navigation.
- No File Browser tab reuse or deduplication.
- No change to the bounded `/api/files` transfer model.
