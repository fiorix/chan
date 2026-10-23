# Tab does not move focus in the draft close dialog

Status: built on 2026-10-23 on the seat's branch; the section Built 2026-10-23 holds the evidence; it closes at the GA as shipped.

## What was seen

The owner's words of 2026-10-23: "one bug in the editor draft window: when i click to close the draft tab and the popup opens asking whether i want to save or discard, i used to be able to press tab to change the selected field from the path to the discard, and pressing again would cycle through the buttons.. now the tab key is no longer working; i want this fixed".

The dialog is `DraftCloseModal.svelte` inside `ModalShell.svelte`, whose Tab wrapping comes from `createModalFocus` (`web/packages/web-shared/src/modalFocus.ts`) and whose window-level keys come from `registerModalShell` (`components/modalStack.ts`); the shell's own key handling answers only while `isTop()` holds, and its registered handler prevents the default of a key it sees while the shell is not on top. None of these four files changed between `980864e24` and `741089ff9`, so the cause, and whether v0.108.0 has it, is not yet established.

## Desired contract

In the draft close dialog, Tab moves focus forward through the dialog's controls in their order (the path field where the draft can be saved, then Discard, Cancel and Save) and wraps from the last to the first; Shift+Tab moves backward and wraps from the first to the last; focus never leaves the dialog while it is open. This holds when the dialog opens from a click on the draft tab's close control, and from every other way the dialog opens.

## What to do

First step, a reading: reproduce in a real browser the owner's path (a draft tab in an editor window, a click on its close control, then Tab and Shift+Tab) at `741089ff9` and at the base `980864e24`, place the fault at source with file and line (what takes or swallows the key, and why), and name the change that brought it if it is in the round or later than v0.108.0's base. Then the change, pinned red first by a test on the real modal stack and focus, and a browser check of the owner's path.

## Acceptance

1. At the parent, a test of the owner's path fails on the focused element after Tab; with the change it and the Shift+Tab, wrap and every-opening-path pins pass; one mutation per guard.
2. A browser check clicks a draft tab's close control and walks Tab and Shift+Tab through the dialog, green at the commit and red at the parent, alone and in the whole suite at the frozen commit; `make web-check` passes.

## Boundaries

The dialog's buttons, labels, order and the save path do not change. Other `ModalShell` dialogs keep their keys; a fix in the shared shell or the modal stack is read against every dialog that uses them.

## Built 2026-10-23

Read first, at `741089ff9` and at the base `980864e24`, in a real browser (Chrome in the frontend guest): an edited draft's Close Draft dialog, opened by a click on the tab's close control, by Ctrl+D and by the `app.tab.close` command, kept focus on the path input through four Tabs, and the second Shift+Tab stayed on Save; no key's default was prevented. The workspace modal stack queued its focus repair in a microtask on every `focusout`, and during a native move between two of the dialog's controls that microtask saw the body as the active element and returned focus to the input (`modalStack.ts`, its capture-phase `focusout` listener). The listener dates from 2026-09-29 and first shipped in v0.101.0, so the defect predates this version. Ruled by the lead the same day: the acceptance's opening paths are the three that open Close Draft; the pane-wide close refuses a draft and the web window close takes another path, so neither opens it. Reading, traces and design: `reports/design-Frontend109-dcltab.md`, `evidence/Frontend109/dcltab/`; the design accepted with conditions in `tasks/task-Review109-Lead109-201.md`.

Built (Acceptance 1): the stack runs a `focusout`'s repair in a zero-delay task that re-reads the active control and the top shell while its generation is current; an outside `focusin` and the top panel's mutation repairs stay microtasks on their own token; the dialog's controls, the shell's wrap and the opener restoration are unchanged (`9134223a9`). At F' `d1cf5dc7d` the mounted regression on the real `DraftCloseModal` and `ModalShell` failed four focus assertions ("native transition still owns focus at the microtask checkpoint") with 81 controls passing; at the fix the two mounted files passed 85 of 85, covering usable and null destinations, a blur with no arrival, an outside `focusin` before the held task, a generation replacement, the final close's restoration, the unsavable variant's reverse move and the path prompt's completion Tab. Five guard mutants (the task as a microtask, the fallback removed, the generation check removed, the outside `focusin` repair removed, the valid-control check removed) each failed its assertion; none survived. `make web-check` at the fix passed: 218 shared, 624 launcher, 7,722 workspace app and 20 profile tests, the Svelte checks and both builds; no package outside the workspace app imports `modalStack.ts`. Logs: `evidence/Frontend109/dcltab/build/`.

Browser check 181 (Acceptance 2), `181-draft-close-tab-focus.mjs` (`4573ddd89`): a native Tab control outside any dialog, then each of the three opening paths with four Tabs and four Shift+Tabs, asserting Discard, Cancel, Save, the input, Save, Cancel, Discard and the input, and containment, after every trusted key. Alone at F' it failed at "close button key 1 Tab: expected Discard, focus=INPUT"; alone at `8265b0af7`, whose paths other than one mounted test file equal `9134223a9`'s, it passed with all 24 key steps. Logs: `evidence/Hygiene109/dcltab/parent5-results/`, `green2-results/`. Its runs alone and in the whole suite at the frozen commit belong to the freeze. Chrome only: the desktop shells' WebKitGTK and WKWebView are not exercised.
