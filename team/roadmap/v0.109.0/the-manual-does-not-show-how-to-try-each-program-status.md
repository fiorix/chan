# The manual does not show how to try each program status

Status: raised for v0.109.0 by the owner's word of 2026-10-21 ("im running the `cs terminal status` with the various options and some of them arent changing the status in the terminal tab but they do show up correctly in the terminal's details window; for example: done, idle, error; did we introduce a bug, or am i not doing something right?", then, after the answer that this is the designed seen rule, "i want to include an item about this exact testing of the program status which i think we need to document in the web/marketing site in the section about osc 7501 program status"); owner the frontend seat.

## What was seen

The owner ran `cs terminal status done`, `idle` and `error` in the terminal tab in front and saw no tab mark, while the tab's Details window listed each record. That is the shipped behaviour: `programVisual` in `web/packages/workspace-app/src/state/programStatus.ts` shows a done or error mark only while its record is unseen, a record read while its tab is in front is seen at once (`TerminalTab.programStatus.test.ts`, "a completion received in front is hidden locally"), idle has no mark, and Details lists every record, seen or not.

The manual's section (`web/packages/marketing/src/pages/manual/terminal.html`, `#program-status`) states the rule in one closing paragraph ("A done or error report read while its session is focused is already seen and has no attention mark. To see that mark, report while another tab is in front") and gives four example commands. It does not show how to report while another tab is in front, does not say that Details lists records with no mark, does not say what each state looks like in the tab, and still calls the window "the terminal tab's program status inspector", which the tab menu names Details since v0.108.0.

## Desired contract

A reader of the manual's program status section can try every state and know what they should see: the tab mark (or none) and the Details window for each state, why done and error show nothing in the tab in front, and a command that shows them, without reading the source.

## What to do

In the `#program-status` section:

1. Name the window as the product does: the terminal tab menu's Details, which shows the program status records when the feature is on and there is status, beside the tab's queued messages.
2. A short table of what each state shows in the tab and in Details, from the shipped marks: working (a typing prompt; with `--progress`, a pie in a ring), blocked with each kind (permission, question, auth, none), done, error, idle, clear; the colours as the tab draws them; which marks clear when seen.
3. A "try it" step for the seen marks: a delayed report from the tab under test, such as `(sleep 5; cs terminal status done --msg "Tests passed") &`, then switching to another tab within the five seconds; the mark appears on the first tab and clears when it comes back to the front. The same for `error`. Check the exact command in a test server before it is written down, including that a background subshell's report reaches its own terminal.
4. Keep the existing examples and paragraphs; the closing paragraph's rule moves next to the table.

Read the section's other pages for the same stale name (`manual/settings.html`, the Program status row) and fix them in the same change.

## Boundaries

`web/packages/marketing/src/pages/manual/terminal.html` (the `#program-status` section), `manual/settings.html` if it names the inspector, the marketing site's tests and build. Not changed: the product, the seen rule, `cs terminal status`.

## Acceptance

1. Each command the section shows run once in a test server, with the tab mark and the Details content each produces recorded here beside the table's row.
2. `make web-marketing-check` green; the page read in a browser at a desktop and a phone width.
3. No page under `manual/` names a "program status inspector".
