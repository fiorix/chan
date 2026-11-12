# A desktop upload's cancel and error paths leave traces and name local paths

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-10 while fixing v0.127.0's transfer row for desktop uploads, found by reading and left alone there; moved to v0.128.0 by the owner the same day ("move all items to v128"). Built on 2026-11-11; acceptance 3 (macOS and the Windows VM) is the owner's, in batch 3.

## What is there now

A chan-desktop upload runs the native picker and the upload inside one desktop command (`upload_files_native`, `desktop/src-tauri/src/upload.rs`), and the page shows it as one row in the Transfers bubble (`runDesktopUpload`, `web/packages/workspace-app/src/api/desktop.ts`). Four things about its cancel and error paths, each older than v0.127.0:

- **A cancel reads as a failure.** A cancelled desktop upload sets the persistent status line "upload failed: upload cancelled" (`raiseDesktopUploadPicker` and `raiseDesktopReplacePicker`, `web/packages/workspace-app/src/state/store.svelte.ts`). A browser upload's cancel shows the transient "Upload cancelled".
- **A dismissed picker leaves a row.** Closing the native picker without choosing leaves a "Cancelled upload" row that has to be dismissed; the browser path leaves nothing. A test pins this as the current behaviour (`api/desktop.upload.test.ts`).
- **Cancel does not close the picker.** Cancelling the row while the native picker is open ends the command with "upload cancelled", and nothing closes the dialog: it stays up, and a file picked in it afterwards is dropped without a word. Read from the command's cancel arm, not run.
- **Errors carry local paths to the page.** The command's errors for a file it cannot open or stat, a picked path that is not a regular file and a file name that is not UTF-8 name the file by its local absolute path, and the text goes to the page as the row's reason and the status line. The page can be a remote devserver's, and the module's own header says no file path crosses the webview IPC. Read, not run.

A fifth is smaller: a failure within one status poll of the pick (a size cap, a name that exists) reads "Failed upload: <reason>" with no file name, because the page never saw the selection.

## Desired contract

1. A cancelled desktop upload reads as a browser upload's does: a transient "Upload cancelled" and no failure line.
2. A picker closed without a choice leaves no row.
3. Cancelling the row closes the native picker, or the row cannot be cancelled while the picker is open; either way no later pick is dropped silently.
4. No local path reaches the page: an error names a file by its base name.
5. A failure after the pick names what was picked.

## Boundaries

- The desktop upload's page side and its command. The browser upload path and the download paths are the reference and do not change.
- Contract 3 depends on what each platform's native dialog allows; the item says which of its two forms each platform gets.

## Acceptance

1. Page tests through the desktop bridge with a stand-in for the IPC, as v0.127.0's row tests are: a cancel's status line, no row after a dismissed picker, a named failure. The test that pins the dismissed picker's row is replaced.
2. Desktop tests: every error the command returns for a picked file, with a temp path as the fixture, holds the base name and not the directory.
3. On chan-desktop on macOS and on the Windows VM (owner): cancel during the pick, dismiss the picker, cancel during the upload, and upload a file that fails; each reads as the contract says.

## Built, 2026-11-11

A desktop upload's cancel and dismissal read as a browser upload's: a cancel rejects with an `AbortError` and both store pickers show the transient "Upload cancelled" with no failure line, and a picker closed without a choice leaves no row (`d03f37be5`). The command answers a page that asks for a named failure (`namedFailure`) with `{ message, cancelled?, picked? }` and any other page with the bare reason (`bcd235044`), so a gateway-served page older than the desktop still reads what it always did: `picked` is the first file's base name and the count, recorded once the picker returns and before the files are validated, so every failure after the pick names its row; `cancelled: true` is set only by the page's own cancel, so a server reason that mentions a cancel stays a failure (`c92ed4874`). Every error for a picked file names it by its base name, never its directory (stat, not a regular file, not UTF-8, open), and a refusal's reason no longer carries an "upload failed" the page adds again. Contract 3 takes its second form on macOS, Windows and Linux alike, because `tauri-plugin-dialog` gives no handle to close an open native dialog and closing one would take platform code on each: the row offers no Cancel until the picker returns, so no file picked after a cancel is dropped silently (`3e6ff57cc`). The manual's Transfers section and both design documents say so (`1206fb7ae`); merged as `6adbedeb7` and `00cf69cda`.

Checks: page tests through the IPC stand-in (the dismissed-picker pin replaced; base red 15 and 8 on their own assertions), desktop tests that read every error for a picked file against a temporary directory, the named failure's shape for a refused selection and for the cancel mark; eleven mutations, each red at its own guard (seven Rust, four page, plus the first stage's three); chan-desktop fmt, clippy and 915 tests; web-check; the marketing check. A third stage keeps the page's bearer token out of a send failure's reason (reqwest's error prints the request URL, which carries the token as a query). Open: the owner's macOS and Windows readings (batch 3, section E).

The owner's Mac reading passed on 2026-11-11 (`dev/owner-mac-checks-v0128.md`, section I, built at 811bd5eb8): every step reported passing.
