# A JSON tab attached to a document session skips the save's parse check

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised during v0.101.0 on 2026-09-27; read in code and not reproduced, a source reading at `3f60c072d`.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0 as the lead recommended. The shape of the fix is still to be ruled: keep `.json` tabs out of document sync, the smaller, which gives up live co-editing of `.json` files, or have the authority hold back its flush of a `.json` document that does not parse, which needs the server's document sessions read first. It is asked of the owner when the order is cut, once those sessions have been read.

## What was seen

The workspace app refuses to save a `.json` buffer that does not parse. `performSaveOnce` in `web/packages/workspace-app/src/state/tabs.svelte.ts` runs `validateJsonBuffer` on a `.json` or Excalidraw tab and, when the buffer does not parse, sets "JSON parse error" on the tab and writes nothing (`:5781-5787`). The comment above `performSave` gives the purpose: invalid JSON written to disk would surface as a parse error the next time a tool or the app's own viewer reads the file, too late to recover the typo, so the write is refused at the editor boundary (`:5716-5721`).

That check comes after the hand-off to a document session. For a tab attached to one (`isDocAttached`, `:5679-5682`: attached, connecting or reconnecting), the save asks the registered session delegates first and, when one answers `saved`, returns before the check (`:5753-5763`). The document sync delegate (`registerLiveSessionKind` in `state/docSync.svelte.ts:1302-1314`) asks its session to flush, which confirms the local edits with the authority and waits for the authority's write to disk (`flush`, `:434-455`), and answers `saved` when that succeeds. Neither reads the buffer. While a tab is attached its edits reach the authority as they are typed, as collaboration updates, and a save means a flush rather than a write (the module's doc, `:1-7`). For such a tab the check runs only once a failed flush has degraded its session while its socket is still open (`isDocSavePaused`, `tabs.svelte.ts:5693-5697`, asked at `:5777`).

A `.json` tab in source mode attaches. Document sync is on by default (`DOCSYNC_DEFAULT_ON`, `:71-75`) in a workspace window (`docSyncEnabled`, `:133-149`), and `isDocSyncEligible` takes a tab in source or wysiwyg mode whose path is editable text and not an Excalidraw scene (`:156-164`); `.json` is editable text (`TEXT_EXTENSIONS` in `state/fileTypes.ts`). Excalidraw scenes never attach, so their check always runs; a `.json` tab in its default mode, the `pretty` tree (`defaultModeForPath` in `tabs.svelte.ts`), does not attach either.

So in a workspace window a malformed `.json` typed in source mode is sent to the authority, and a save flushes it, which is what the check exists to refuse. The client's own comments describe the authority flushing on a debounce of about 800 ms (`DOC_FLUSH_TIMEOUT_MS`, `docSync.svelte.ts:98-104`), which would put the buffer on disk without a save at all; what the server writes, and when, was not read. No test in the workspace app asserts the check's refusal, attached or not.

## Desired contract

A `.json` buffer that does not parse reaches disk from no editor path: attached to a document session or not, the tab says the JSON does not parse, as a save without a session does, and the file keeps the last content that parsed.

## What to do

Decide the shape first. Two meet the contract: keep `.json` tabs out of document sync, as Excalidraw scenes are, so every save takes the path with the check; or have the authority hold back its flush of a `.json` document that does not parse, and have the session's save report the parse error on the tab. The first is the smaller and gives up live co-editing of `.json` files; the second keeps it and needs the server's document sessions read first. Withdrawing the item instead leaves attached `.json` tabs as they are, and then the check's comment should say that it guards only the path without a session. Red first: a `.json` tab attached to a session in source mode, a buffer that does not parse, a save, and the check shown to be skipped.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`performSaveOnce`) and `state/docSync.svelte.ts` (`isDocSyncEligible`, the save delegate) and their tests; for the second shape, the server's document sessions (`crates/chan-server/src/doc_sessions/`, `routes/doc.rs`), not read for this item. `.json5` and the other JSON-like formats stay outside the strict check. Excalidraw scenes are unchanged.

## Acceptance

1. In a workspace window with document sync on, a `.json` tab in source mode whose buffer does not parse shows the parse error on save, and the file on disk keeps its last content that parsed, pinned by a test that drives the attached path, or, under the first shape, by a test that such a tab never attaches.
2. A test pins the check's refusal on the path without a session.
3. A `.json` buffer that parses saves as it does now, attached or not.
