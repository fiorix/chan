# Two hundred frontend tests pin spelling, not behaviour

Status: raised for v0.101.0 from the frontend review (findings ORPH-01 and ORPH-02, high, and 21 medium findings about the same convention), phased out of v0.100.0 because it waits on two owner rulings. The count was re-taken against `main` at `d3de0180b`.

## What was seen

203 test files under `web/packages` import a production module's source with Vite's `?raw` and assert on its text: 199 in the workspace app and 4 in the launcher, one more than when the review counted. They do not test behaviour; they test that certain characters appear in certain files. `Wysiwyg.svelte` is pinned from thirteen test files across four directories and has no behavioural test of its own; `GraphPanel.svelte` is read as text by 31 suites; the three biggest components have 80 pinning files between them.

The cost is concrete. Three tests assert on the text of source comments, and five more pin the prose of production comments, so rewriting a comment to follow the house writing rules turns the suite red. 24 of 28 sampled "must not contain" identifiers exist nowhere in the tree, so those assertions are tombstones that cannot fail. One file is twelve negative assertions that pass against an empty string. The convention also hid real defects: every terminal mock stubs the key handler, so a double-dispatched Ctrl+D was invisible, and a test pinned the bare `crypto.randomUUID()` call that throws on plain http.

v0.100.0 works under a narrow rule so its fixes are not blocked: a lane that changes code a source-text test pins replaces that test with a behavioural one in the same change. This item is the rest.

## Desired contract

A frontend test fails when behaviour breaks and passes when a comment or a spelling changes. Source-text assertions survive only where nothing else can express the check, and the cases are written down.

Two rulings decide the shape, and the review puts them first among its questions for the owner: whether `?raw` pins stay as a policy with tighter rules, shrink to a narrow set of named cases with the rest converted or deleted, or go wherever jsdom allows; and how the deletion is done so history survives, in one pass or rename first and edit second. The review recommends the narrow rule and the two-commit path.

## Boundaries

Test files under `web/packages/workspace-app/src` and `web/packages/launcher/src`, plus shared fixtures: the FileTab layout harness copied into twelve files and the standalone-window boot harness copied twice become shared helpers here. No production code changes except where a component needs a seam to be mountable. Re-homing the 46 incident-named test files onto the `<module>[.<concern>].test.ts` convention is part of it.

## Acceptance

1. The ruled policy is written into the webdev standards, with the cases where a source-text assertion is allowed.
2. No test asserts on comment text, and no test asserts the absence of an identifier that exists nowhere in the tree.
3. `Wysiwyg.svelte`, `GraphPanel.svelte` and `TerminalTab.svelte` each have mounted behavioural coverage for what their pins were guarding, and the count of `?raw` test files is recorded before and after.
4. `make web-check` stays green throughout, and no commit lowers coverage of a behaviour without saying so.
