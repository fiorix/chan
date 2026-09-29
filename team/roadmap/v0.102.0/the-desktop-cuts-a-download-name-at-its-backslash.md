# chan-desktop saves a download under the part of its name after the last backslash, on every platform

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the report of the order that built the web app's half of [a-backslash-in-a-name-reads-two-ways-on-the-wire](../v0.101.0/a-backslash-in-a-name-reads-two-ways-on-the-wire.md) (`dev/v0101-team/reports/report-Clients-32.md` in the development tree, "Found beside the order", its second bullet), whose plan found it (`dev/v0101-team/followups/followup-Clients-Lead-12.md`, leaning 6); the lead ruled it raised and not built (`dev/v0101-team/followups/followup-Lead-Clients-21.md`, ruling 5). Read at `a6834b1ee`; not run. It is an item of its own because the contract and the boundary of [an-upload-cuts-a-name-at-its-backslash](an-upload-cuts-a-name-at-its-backslash.md) hold an upload's name and the desktop's upload target and no download's name; the two are one cut in two directions, a name taken at its last `\` by the server on the way in and by the desktop on the way out.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with [typed-and-dropped-names-disagree-on-a-backslash](typed-and-dropped-names-disagree-on-a-backslash.md) and [an-upload-cuts-a-name-at-its-backslash](an-upload-cuts-a-name-at-its-backslash.md): the three wait on one rule for a backslash in a name, which is not ruled and is chosen with them. Two rules were put forward: a name may keep a `\` that it already holds and may not gain one, on every surface that takes a typed or dropped name; or a name holds `\` on Unix on every surface that takes or gives a name, with what a Windows client may send decided with the upload. When it was raised the lead recommended deciding it with the upload's item, in the version the owner gives that one. It is not part of v0.101.0.

## What was seen

- **The desktop names a download by the part after its last `/` or `\`,** whatever its platform: `sanitize_filename` takes that part, trims it, replaces the characters Windows refuses in a name and renames a Windows device name (`desktop/src-tauri/src/download.rs:516-554`, the cut at `:517-521`).
- **It names both of the desktop's downloads:** a file download (`download_file_native`, `:134-166`, its target at `:166`) and a download of bytes the web app made (`begin_generated_download`, `:340-346`), which the PDF export uses on chan-desktop (`saveBytesToDownloads`, `web/packages/workspace-app/src/api/desktop.ts:626-648`; `exportPathToPdf`, `web/packages/workspace-app/src/state/fileActionExecutors.ts:30-32`).
- **The web app hands over the whole name.** A download's name is the path's last component cut at `/` alone (`downloadFilename`, `web/packages/workspace-app/src/state/store.svelte.ts:5600-5603`, handed to the desktop at `:5686`), and the export's is `pdfFilenameFor`'s, which cuts at `/` alone since 2026-09-28 (`web/packages/workspace-app/src/editor/pdf_export.ts:110-116`). So on chan-desktop a download of `a\b.md` is saved as `b.md` and its export as `b.pdf`, on Linux and macOS as on Windows; the changelog says so (`CHANGELOG.md:27` at the landing's tip).
- **The cut guards the Downloads folder where `\` is a separator.** Its tests pin names such as `C:\x` and `\\server\share` saved as `x` and `share`, and no `\` in any name they save, on every platform (`sanitize_windows_filename_characters_and_devices`, `download.rs:776-811`), and on Windows that each such name stays in the Downloads folder (`sanitized_windows_downloads_stay_in_downloads_directory`, `:813-824`).

## Desired contract

chan-desktop saves a download under a name that keeps the whole of the name the web app hands it, with only what the host cannot hold in a name replaced, and every name still lands in the Downloads folder.

## What to do

The owner rules with [an-upload-cuts-a-name-at-its-backslash](an-upload-cuts-a-name-at-its-backslash.md). Suggestions beyond the record: replace a `\` as `sanitize_filename` replaces `:` and the other characters Windows refuses, which keeps the rest of the name on every platform and a Downloads folder that a Windows machine can read; or cut at `\` on Windows alone. Red first: `sanitize_filename("a\\b.md")` answers as ruled; today `b.md`.

## Boundaries

`desktop/src-tauri/src/download.rs` (`sanitize_filename`) and its tests, and the changelog's sentence that says what chan-desktop does with such a name. The web app's names are not in scope: they hand over the whole name already.

## Acceptance

1. A download and an export of `a\b.md` on chan-desktop are saved under the name the ruling gives, pinned at `sanitize_filename`.
2. Every name still lands in the Downloads folder, the existing pins kept.
3. The changelog says what chan-desktop saves such a download as.
