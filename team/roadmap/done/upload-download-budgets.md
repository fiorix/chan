# Review upload/download budgets (large-file download hangs chan-desktop)

> Status: shipped in [v0.76.0](../../release/release-v0.76.0.md): bounded server byte stream, backpressured multipart upload, desktop native streaming (temp + atomic rename), and bounded 2-download/1-upload concurrency; HTTP range/206 stays in v0.77.0 (video-preview-and-range-serving).

Status: REGISTERED for v0.76.0, NOT specced, NOT yet root-caused. Symptom
reported by the owner; the notes below are pointers and hypotheses for the
next session to investigate, not conclusions.

## Symptom

Downloading large files can hang the WHOLE chan-desktop UI (the desktop app,
not just the transfer). The owner wants to review the upload/download
"budgets" (concurrency caps, per-transfer size limits, chunking) as part of
fixing this.

## What is already known / relevant areas (grounding, not diagnosis)

- Desktop download bridge: web/.../api/desktop.ts runDesktopDownload is the
  desktop-specific save path (Tauri). A UI hang on the desktop points here or
  at whatever it awaits on the WebView main thread. PRIME SUSPECT: a
  synchronous or main-thread-blocking step in the desktop save.
- Transfer bookkeeping: web/.../state/transfers.svelte.ts
  (activeTransferCount, beginTransfer, setTransferProgress, finishTransfer,
  uploadInFlight, ...). Reactive progress updates on many chunks could thrash
  if not throttled.
- Server file read: crates/chan-server/src/routes/files.rs. The binary read
  path read_file_sync returns ReadFileResult::Data(Bytes) = the WHOLE file in
  memory. If a large download rides this rather than the chunked stream
  (stream_read_file_sync / FileStreamMessage, and the tar/dir download
  stream), it balloons memory and delays first-byte. Confirm which path a
  large single-file download actually takes.
- The "budgets" to review: any concurrency limit on simultaneous transfers,
  any per-file size cap, chunk size, and backpressure between the server
  stream and the client.

## Hypotheses to check next session (profile first, do not assume)

1. Main-thread block in the desktop download (runDesktopDownload / Tauri
   command) freezing the WebView, vs
2. Whole-file-into-memory buffering on the server (read_file_sync Data(Bytes))
   for large binaries, vs
3. Progress/reactivity thrash in transfers.svelte on a fast large transfer.
Profile a real large-file download in chan-desktop to find which one it is
BEFORE changing budgets.

## Related

Overlaps with video-preview-and-range-serving.md: adding HTTP range /
streaming to the file route (needed for video) would also let large downloads
stream instead of buffering the whole file, which may be part of this fix.
Sequence the two together if the root cause is server-side buffering.
