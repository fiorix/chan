# A desktop upload's transfer row reads "Uploading Upload"

Status: raised by the owner on 2026-11-10 from chan-desktop on his Mac, with a screenshot of the Transfers bubble reading "Uploading Upload to dev (100%)", and placed in v0.127.0 the same day ("it's ok to fix in v127"). Built on `fix/desktop-upload-transfer-label` (`f39b43549`, one commit over `40959b57e`) and merged into the integration branch as `a61073bf8`. The text dated from the native transfer work of v0.76.0 (`81f9b9fbe`).

## What was there

Every text of a transfer's row in the Transfers bubble is a verb before the transfer's name (`components/TransferBubble.svelte` in the workspace app). A browser upload names its row after what is uploaded: the file's name, or "N files". On the desktop the native picker and the upload run inside one command, so the page does not know the files when the row begins, and it named the row with the upload's own label, "Upload to dev" or "Upload files". The row read "Uploading Upload to dev", ended "Uploaded Upload to dev", and read as wrongly in its waiting, cancelled, failed and interrupted states.

## Contract as built

1. The desktop's polled transfer status carries an upload's selection once the picked files are validated: the first file's base name, cut at 255 characters, and the file count (`picked` in `native_transfer_status`, `desktop/src-tauri/src/native_transfer.rs`). No path leaves the desktop, the payload does not grow with the selection, and no command, permission or `invoke` name changed. The field is optional on the page; a status without it names nothing.
2. While the picker is open the row reads "Waiting for file selection" with a still bar, for a replace too; its Cancel and the window's close guard cover the pick as before.
3. Once named, the row reads "Uploading report.pdf (25%)" for one file and "Uploading 3 files (50%)" for several, and ends "Uploaded report.pdf" or "Uploaded 3 files". An upload that ends between two polls is named from the paths the server stored.
4. A row that ends with no name reads "Cancelled upload", "Failed upload: <reason>" or "Interrupted upload (window reloaded)"; one whose desktop reports a total and no selection reads "Uploading files".
5. A replace keeps its target's name whatever file is picked, and a row that has ended is not renamed by a late status. A browser upload's texts are unchanged.

## Boundaries

- The row's name only. The status-line texts of an upload and the desktop upload's cancel and error paths are unchanged.
- A failure within one poll of the pick reads unnamed, since the page never saw the selection.

## Acceptance

1. Tests (met): 23 page tests through the store, the desktop bridge and the mounted bubble with a stand-in for the IPC, 22 of them red against the earlier page (the store's on the rendered text "Uploading Upload to docs..."); 3 desktop tests of the status as the page reads it, as JSON, with their reds shown by mutation since the earlier desktop code has nothing for them to call.
2. The integration branch's gate and Windows cross-check green with the merge.
3. On chan-desktop on macOS (owner): from the file browser upload one file, then several, then replace a file; the row names the file, then "N files", then the replaced file, and no state reads "Upload" after its verb.
