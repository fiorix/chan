# An Excalidraw tab opens an empty Outline, offers a style toolbar, and has no Details in a standalone window

Status: built on 2026-10-25 on v0110/xdcard; the section Built and verified holds the evidence; it closes at the v0.110.0 GA.

## What was seen

The owner read on 2026-10-24: `cs open foo.excalidraw` opens the drawing canvas with the Outline card showing, no Details entry in the tab menu, and a style toolbar toggle that has nothing to style. The owner's words: the Outline is "absolute nonsense because what would it even show there for excalidraw", the tab "does not have an option for the file details, which it should because we can actually inspect the file.excalidraw being edited and backlinks etc", and "there's no need to support the Show Style Toolbar for excalidraw files".

Read at `840c4f594`; paths under `web/packages/workspace-app/src/` unless named.

- Outline. Since v0.109.0 the editor tab constructor in `state/tabs.svelte.ts` opens the Outline on a wide screen for every file kind (`outlineOpen: opts.outlineOpen ?? wideScreen()`). The Outline parses ATX headings from the tab's content (`components/OutlineBody.svelte`); an Excalidraw scene is JSON, so the card reads "No headings yet". The tab menu's "Toggle outline" (`components/FileEditorTab.svelte`) and the launcher's `app.editor.outline` (`state/commands/editor.ts`) are offered on every file tab in every mode. JSON, CSV and source-only text tabs open the same empty card on a wide screen; one rule decides them all.
- Details. The tab menu's "Toggle details" sits inside `{#if windowCaps.workspace}`, the launcher's `app.editor.details` has `requirement: "workspace"`, and the constructor's default is `inspectorOpen: opts.inspectorOpen ?? (wideScreen() && windowCaps.workspace)`. In a workspace window an Excalidraw tab offers Details and opens it on a wide screen; in a window with no workspace no editor tab of any kind offers Details. The owner's reading fits a standalone window: `cs open` on a path outside the workspace is routed to the standalone window (the `cs open` help's CAVEATS), and the owner's other readings of the day were in that window. In the same window the File Browser's Details works: `components/FileInfoBody.svelte` skips the index-backed requests (`/api/inspector`, `/api/report/*`) when the window has no workspace and shows the file's path, size, modified time and actions. The editor's gate withholds a card whose body already renders without an index; only the refs section (`showRefs`, the backlinks stream) has no such guard and would need one.
- Style toolbar. In canvas mode the tab menu hides "Toggle style toolbar" (`tab.mode === "wysiwyg" || (tab.mode === "source" && hasRenderedMode)`), but the launcher's `app.editor.styleToolbar` is available on every file surface and flips the flag with nothing mounted. In source mode `hasRenderedMode` is true for Excalidraw, so the menu offers the toolbar and it mounts, formatting row disabled, over the scene's JSON, for a rendered/source toggle the tab menu's "Show source code" already carries.

## Desired contract

An Excalidraw tab has no Outline and no style toolbar: neither opens by default, the tab menu and the launcher do not offer them on that tab, and a saved open Outline on such a tab restores closed. Its Details is offered wherever the File Browser's Details is: in a workspace window with the index-backed sections (backlinks, tags, dates, the code report), and in a standalone window with the filesystem facts the browser's Details shows there. Markdown tabs are unchanged.

The owner's two decisions of 2026-10-24, taken on the recommendations put to him:

1. The Details gate is one condition shared by every file kind, so it is lifted for every editor tab, not for Excalidraw alone: a markdown file opened in a standalone window gains the same Details the File Browser already shows for it there.
2. The Outline belongs to document-kind tabs (markdown, including slides) in either mode, and not to canvas, JSON, CSV or source-only text tabs, which have no headings to list.

## What to do

1. A per-tab rule `tabHasOutline(tab)` in `state/tabs.svelte.ts`, used by the constructor default (`outlineOpen: opts.outlineOpen ?? (wideScreen() && tabHasOutline(tab))`), by the restore of the saved `ol` bit, by the tab menu entry and by the launcher command's `available`.
2. A per-tab rule `tabHasStyleToolbar(tab)`, false for Excalidraw in both modes, used by the tab menu entry, the launcher command's `available`, the two mount sites in `components/FileEditorTab.svelte` and `setTabStyleToolbarOpen`. `hasRenderedMode` stays as it is for the mode toggle.
3. Details: drop the `windowCaps.workspace` gate at the tab menu entry and the constructor default, and change the launcher command's requirement from `workspace` to `files`; guard the refs section's backlinks stream in `components/FileInfoBody.svelte` on the workspace capability as the inspector and report effects already are.
4. Tests, red first: an Excalidraw tab constructed at 1280px opens with no Outline and a markdown tab with one; a restored Excalidraw tab with `ol: 1` opens closed; the tab menu offers no Outline or style toolbar entry on a canvas tab and no style toolbar entry in its source mode; `state/commands/surfaceCommands.test.ts` hides `app.editor.outline` and `app.editor.styleToolbar` on a canvas tab and shows `app.editor.details` in a files-capable standalone window; `FileInfoBody` with `showRefs` in a standalone window makes no index request.
5. The manual's editor page (`web/packages/marketing/src/pages/manual/editor.html`, "Details and outline") says Details inspects "the file and its workspace information"; add that in a window with no workspace it shows the file's facts alone, and that the Outline is a Markdown card.

## Boundaries

`state/tabs.svelte.ts` (the two rules, the constructor defaults, the `ol` restore), `components/FileEditorTab.svelte` (menu entries, mount conditions), `state/commands/editor.ts` (three commands), `components/FileInfoBody.svelte` (the refs guard), the manual's editor page, their tests. Not changed: the Excalidraw canvas, the Outline's parser, the File Browser's Details, markdown tabs' defaults and cards.

## Acceptance

1. `cs open foo.excalidraw` into a standalone window on a wide screen: the canvas, no Outline card, the tab menu offers Toggle details and neither Toggle outline nor Toggle style toolbar, and Details shows the file's path, size and modified time.
2. The same in a workspace window: Details open on a wide screen with backlinks and tags, no Outline, no style toolbar in canvas or source mode.
3. A markdown tab is unchanged: Outline and Details on a wide screen, the style toolbar toggle in both modes.
4. The tests above red first, green after.

## Built and verified 2026-10-25

`tabHasOutline` now admits document-kind Markdown and slide tabs in either mode. It controls the wide-screen default, restored `ol` bit, tab menu, command availability and card mount. `tabHasStyleToolbar` excludes Excalidraw in canvas and source mode across the menu, command, setter and mounts. Every files-capable editor window offers Details; standalone windows render filesystem facts while workspace windows also request references and reports. The manual and workspace app design describe these rules.

The four touched test files ran red against the base with 13 intended assertion failures and 169 passes (`dev/v0110-team/evidence/Web110/xdcard/red-tests.log`, exit 1), then green with 182 passes (`dev/v0110-team/evidence/Web110/xdcard/focused-green-2.log`, exit 0). Tests cover a wide standalone Excalidraw tab's closed Outline, absent toolbar controls and available Details with no index requests; a wide workspace Excalidraw tab's Details and absent Outline/toolbar; Markdown's cards and toolbar; and an Excalidraw `ol: 1` restore that closes Outline. The style toolbar rule is the tab menu's condition with Excalidraw excluded, so the launcher command now matches the menu on JSON and CSV tabs in pretty and table modes.

The browser-reader grep passed with a positive control (`dev/v0110-team/evidence/Web110/xdcard/browser-readers.log`, exit 0). Checks 40, 61, 170, 173, 174, 175 and 176 each passed alone at the tip and base (`dev/v0110-team/evidence/Web110/xdcard/browser-tip-<number>.log` and `browser-base-<number>.log`, all exit 0); their separate `results.json` files are under `/home/ubuntu/evidence/xdcard-{tip,base}-<number>/` in the test guest. Check 173 exercises Markdown's Outline, toolbar and Details; 174 exercises Details reload state; 40 and 61 exercise Excalidraw scenes; 170 and 175 exercise adjacent Details surfaces; 176 exercises the Outline resize surface. The manual's `make web-marketing-check` passed (`dev/v0110-team/evidence/Web110/xdcard/web-marketing-check.log`, exit 0). The whole `make web-check` reached 7,731 of 7,733 passing tests with the updated Details requirement snapshot (`web-check-3.log`, exit 2); the terminal keep-alive timeout and duplicate session-save assertion passed when their files ran alone with the snapshot file (`gate-failures.log`, 37 passes, exit 0).

Acceptance 1 is covered by the wide standalone tab and FileInfoBody tests for Outline, menu and command availability, Details facts and absence of index requests; the actual `cs open` standalone window still awaits a hand. Acceptance 2 is covered by workspace tab and component tests for Details, Outline and both Excalidraw modes, plus the paired scene checks; the wide workspace window with live backlinks and tags still awaits a hand. Acceptance 3 is covered by the Markdown tab and menu tests and browser check 173. Acceptance 4 is covered by the red-first and green focused runs, the corrected command requirement snapshot and the paired browser checks.

The owner's decisions are applied to all editor file kinds: Details is available in every files-capable window, and Outline belongs to document-kind tabs alone, including slides in either mode.
