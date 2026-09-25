# Two hundred frontend tests pin spelling, not behaviour

Status: landed on 2026-09-25 in two file-disjoint lanes and an integration step; accepted for v0.101.0 by the owner on 2026-09-24; raised for v0.101.0 from the frontend review (findings ORPH-01 and ORPH-02, high, and 21 medium findings about the same convention), phased out of v0.100.0 because it waits on two owner rulings. The count was re-taken against `main` at `d3de0180b`.

## Owner ruling

Accepted on 2026-09-24. The owner's decision reads the spelling pins as the make-it-work version of these tests, a guardrail rather than a test of the behaviour, and rules that with the code now in place the work is to do it right: refactor and de-duplicate the tests toward behaviour, and make the code idiomatic along the way. The decision answered the lead's recommendation on the two shape questions, which is the shape the lane starts from: `?raw` pins survive only for build-time contracts with no runtime seam (the review's narrow rule) and everything else moves to a mounted or behavioural test, in two commits per file (rename first, edit second). The work runs as several file-disjoint lanes by package and comes before [one-question-is-answered-in-many-places](one-question-is-answered-in-many-places.md) and [graph-bodies-have-no-mounted-test](graph-bodies-have-no-mounted-test.md), which move the same test files.

## What was seen

203 test files under `web/packages` import a production module's source with Vite's `?raw` and assert on its text: 199 in the workspace app and 4 in the launcher, one more than when the review counted. They do not test behaviour; they test that certain characters appear in certain files. `Wysiwyg.svelte` is pinned from thirteen test files across four directories and has no behavioural test of its own; `GraphPanel.svelte` is read as text by 31 suites; the three biggest components have 80 pinning files between them.

The cost is concrete. Three tests assert on the text of source comments, and five more pin the prose of production comments, so rewriting a comment to follow the house writing rules turns the suite red. 24 of 28 sampled "must not contain" identifiers exist nowhere in the tree, so those assertions are tombstones that cannot fail. One file is twelve negative assertions that pass against an empty string. The convention also hid real defects: every terminal mock stubs the key handler, so a double-dispatched Ctrl+D was invisible, and a test pinned the bare `crypto.randomUUID()` call that throws on plain http.

v0.100.0 works under a narrow rule so its fixes are not blocked: a lane that changes code a source-text test pins replaces that test with a behavioural one in the same change. This item is the rest.

## Desired contract

A frontend test fails when behaviour breaks and passes when a comment or a spelling changes. Source-text assertions survive only where nothing else can express the check, and the cases are written down.

Two rulings decide the shape, and the review puts them first among its questions for the owner: whether `?raw` pins stay as a policy with tighter rules, shrink to a narrow set of named cases with the rest converted or deleted, or go wherever jsdom allows; and how the deletion is done so history survives, in one pass or rename first and edit second. The review recommends the narrow rule and the two-commit path.

## What shipped

Two lanes took the 203 test files that imported a production module with `?raw` (lane 1 the policy, the shared harnesses and 104 files; lane 2 the `Wysiwyg`, `GraphPanel` and `TerminalTab` families and their neighbours, 99 files), each with an independent review and a second round, and an integration step gave both halves one set of harnesses. 19 such files remain. The webdev standards (`.agents/skills/webdev/SKILL.md`, `## Tests`) state the contract, the narrow rule and every allowed case; each surviving read carries a one-line contract comment and was shown red against a violation.

- The survivors are the tree-wide scans (native dialogs in both packages, the one id mint, the Tauri invoke boundary, the widget write predicate, the launcher theme tokens) and CSS or import contracts jsdom never applies whose break ships a visible failure: the flip back face that once blanked every Linux window, keep-alive by `visibility`, the split chrome constant, the Wysiwyg paint layers and list-indent variables, no scale on a pane, the per-surface theme token blocks, the graph palette, the terminal font's entry import, relative src and family, and the Excalidraw island's offscreen `display` and stylesheet chunk. `terminal/protocol.test.ts` still reads `routes/terminal.rs`, until a Rust test pins the attach prelude order ([the-attach-prelude-order-has-no-rust-test](the-attach-prelude-order-has-no-rust-test.md)).
- Shared harnesses live under `web/packages/workspace-app/src/__tests__/`: one tab-factory module, the standalone boot and typed preferences, the mounted App over the demo transport, one xterm stand-in that records the key handler, canvas contexts, the transport recorder, Settings, Wysiwyg, GraphPanel and the Excalidraw stand-ins.
- `Wysiwyg.svelte`, `GraphPanel.svelte` and `TerminalTab.svelte` have mounted behavioural coverage for what their pins guarded. One production seam was added, `GraphCanvas.svelte`'s `nodeScreenCircle`, so a test can click a node the layout placed.
- Every drop of coverage is listed in the lane reports (`dev/v0101-tasks/report-rawa.md`, `report-rawb.md` and their `-2` rounds). About two dozen inline tab factories in files outside both lanes' lists remain, and the four `node:fs` source readers outside both lanes are [four-tests-still-read-source-with-node-fs](four-tests-still-read-source-with-node-fs.md).
- The mounts found product defects: [the-settings-date-format-never-saves](the-settings-date-format-never-saves.md) landed with lane 1; [a-sent-prompt-stays-editable-while-pending](a-sent-prompt-stays-editable-while-pending.md), [a-click-beside-a-graph-node-clears-the-selection](a-click-beside-a-graph-node-clears-the-selection.md), [a-mirrored-value-focuses-an-unfocused-editor](a-mirrored-value-focuses-an-unfocused-editor.md) and [mounted-components-mutate-props-they-do-not-own](mounted-components-mutate-props-they-do-not-own.md) are raised.

## Boundaries

Test files under `web/packages/workspace-app/src` and `web/packages/launcher/src`, plus shared fixtures: the FileTab layout harness copied into twelve files and the standalone-window boot harness copied twice become shared helpers here. No production code changes except where a component needs a seam to be mountable. Re-homing the 46 incident-named test files onto the `<module>[.<concern>].test.ts` convention is part of it.

## Acceptance

1. The ruled policy is written into the webdev standards, with the cases where a source-text assertion is allowed.
2. No test asserts on comment text, and no test asserts the absence of an identifier that exists nowhere in the tree.
3. `Wysiwyg.svelte`, `GraphPanel.svelte` and `TerminalTab.svelte` each have mounted behavioural coverage for what their pins were guarding, and the count of `?raw` test files is recorded before and after.
4. `make web-check` stays green throughout, and no commit lowers coverage of a behaviour without saying so.
