# A terminal's survey takes the keyboard from another pane

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); not started.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", focus; `dev/panekeys/report.md`): `BubbleOverlay` takes the keyboard on every pulse in any pane. The decisions document for v0.131.0 checked it against the code and sorted it as a row of its own: a keystroke meant for another pane can answer an agent's survey with an answer nobody chose. The owner took that recommendation.

## What is there now

Read at `f7457becb`, by reading; not run.

- A per-terminal survey's overlay (`web/packages/workspace-app/src/components/BubbleOverlay.svelte`, the focus effect from about line 52) reads the tab-focus pulse (`tabFocusPulse.value`) when it has a slot, and on each run with a survey active and its terminal shown it blurs the active element and focuses the survey card.
- Nothing in the effect asks whether the owning terminal's pane is the focused pane. A pulse from any pane re-runs it while the survey's terminal is visible in another pane, and the card takes the keyboard there. The card answers 1 to 9 with an option, F with a follow-up and X or Escape with a dismissal.

## Desired contract

1. A per-terminal survey takes the keyboard only when its terminal's pane is the focused pane: when it is shown there, and when focus returns to that pane.
2. A survey on a terminal in an unfocused pane stays visible and answerable by a press, and keys typed in the focused pane reach that pane.
3. A window-wide survey behaves as now.

## Boundaries

- The focus effect in `BubbleOverlay.svelte` and what it reads of the pane's focus.
- Not here: the survey's keys and layout, and the terminal tab's own focus rules.

## Acceptance

1. Workspace app tests: two panes, a survey on the terminal of the unfocused one; focus pulses in the focused pane leave the keyboard there and a typed `1` answers nothing; moving focus to the survey's pane gives the card the keyboard. Red on today's code.
2. A browser check in a guest: the same two panes with a real survey raised through `cs terminal survey` on the unfocused pane's terminal, keys typed in the focused pane, and the survey still open.
