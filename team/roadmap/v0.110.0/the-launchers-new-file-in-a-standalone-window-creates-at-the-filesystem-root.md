# The launcher's New file in a standalone window creates at the filesystem root

Status: raised for v0.110.0 on 2026-10-24 by the owner; not started.

## What was seen

The owner, on macOS, read on 2026-10-24: Cmd+K, New file, Enter on the proposed `untitled.md` creates the file in a workspace window. In a window with no workspace the same keystrokes fail with a read-only filesystem error, the prompt refuses a path that starts with `/`, and `Users/fiorix/untitled.md` creates the file in the home directory as expected. The owner's word: "the command launcher commands like new file (file browser related operations) should start from the user's homedir, not /".

Read at `840c4f594`; paths under `web/packages/workspace-app/src/` unless named.

- `App.svelte` answers `app.file.new` with `fileOps.createFile("")`. The empty parent is the window's wire root, and `proposeDefaultFilename("")` proposes `untitled.md` there. A workspace window's root is the workspace directory. A standalone window's filesystem surface is opened over `/` with the canonical home directory as its start (`construct_standalone_files` in `crates/chan-server/src/lib.rs` calls `MiniWorkspace::open("/", &home, ...)`), so the proposal is `/untitled.md`. macOS mounts `/` read-only, which is the error the owner saw; on Linux the same create is refused with "Permission denied" for an unprivileged user (checked on this host).
- The prompt's `validatePath` refuses a leading `/` ("absolute paths are not allowed") and the server's wire grammar refuses it too (`MiniWorkspace::wire_rel` answers a path escape), so the only spelling of the home directory is the wire-relative one the owner typed. The prompt's title says "relative path" and nothing says what the path is relative to.
- The window already knows the home directory. `bootstrapStandalone` in `state/store.svelte.ts` reads `GET /api/fs/context` and keeps the server's start directory as `filesContext.current.homeWire` (`state/fileContext.svelte.ts`; the server answers `start_rel()` in `routes/standalone_fs.rs`), then loads the tree down to it so the first File Browser opens with home in place under `/`. The terminal's "New file or directory ($CWD)" maps the shell's working directory through `wirePathFromAbsolute` and never lands at `/` by default.
- The same empty-parent default reaches three more launcher paths in a standalone window: "New file or directory" (`state/commands/browser.ts`, `targetDirFromSelection()` answers `""` when the File Browser has no selection), "Upload" (`raiseUploadPicker("")` with no selection), and the File Browser's empty-tree buttons "Create new file" and "Create new directory" (`components/FileTree.svelte`), which `/` never shows because it is never empty.
- The "New file" command's guard is `workspaceOnly`, which is `!terminalOnly`, so a standalone window that serves files offers it. That is right, since the window edits files, but the comment above it ("hidden only in a standalone terminal window") describes the terminal-only case and reads as if the command were withheld here.

## Desired contract

In a window with no workspace, a create or upload that takes a default directory starts in the user's home directory: New file proposes `untitled.md` under home with the stem selected, "New file or directory" and "Upload" with no File Browser selection target home, and the prompt names the directory the typed path is relative to. A File Browser selection still wins. A workspace window is unchanged: its root is the workspace. The default is the server's start directory, so a host whose home is elsewhere follows it.

## What to do

1. One rule for "the directory a create starts in when nothing names one": `filesContext.current?.homeWire ?? ""`. A standalone window with files holds the context before any command can run; a context fetch that failed leaves `""` and the status bar already reports it.
2. Use the rule at the `app.file.new` dispatch in `App.svelte`, in `targetDirFromSelection` and `uploadToSelection` of `state/commands/browser.ts`, and at the two empty-tree buttons in `components/FileTree.svelte`.
3. `proposeDefaultFilename(home)` already yields `home/untitled.md`; confirm the prompt selects only the stem when the proposal carries a directory prefix, as it does after a Tab-completed directory.
4. The prompt shows the directory the path is relative to: the display path of the parent (`displayPath` in `state/fileContext.svelte.ts`) in the title or the hint row, in both window kinds.
5. Reword the comment on the "New file" command's guard to say what it does.
6. Tests, red first: with `filesContext.current` set to a home of `home/u`, the `app.file.new` dispatch proposes `home/u/untitled.md` and creates there; "New file or directory" and "Upload" with no selection target `home/u`; with the context null the proposals are `untitled.md` and `""` as today (`state/store.create.test.ts` holds the create flows); `state/commands/surfaceCommands.test.ts` keeps "New file" visible in a files-capable standalone window and hidden in a terminal-only one.

## Boundaries

`App.svelte` (one dispatch line), `state/commands/browser.ts`, `components/FileTree.svelte` (two buttons), `state/fileContext.svelte.ts` (the rule), `components/PathPromptModal.svelte` (the relative-to hint), the comment in `state/commands/editor.ts`, their tests. Not changed: the wire grammar (a leading `/` stays refused), the server's start directory, the terminal's $CWD create, a workspace window's defaults.

## Acceptance

1. In a standalone window on macOS and on Linux, Cmd+K, New file, Enter creates `untitled.md` in the home directory and opens it.
2. "New file or directory" and "Upload" from the launcher with no File Browser selection target the home directory; with a selected directory they target it.
3. A workspace window's New file still proposes `untitled.md` at the workspace root.
4. The prompt names the directory a typed relative path lands in.
5. The tests above red first, green after.
