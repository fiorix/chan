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

## Built, 2026-11-14

The overlay takes focus only when its terminal is the active tab on the visible side of the focused pane. It reads layout membership in the focus effect, so returning to a pane or relocating the terminal reclaims the survey card, and reads it again in queued focus and close-restoration callbacks. A remote close while another pane has focus leaves that pane's keyboard alone. A visible survey in an unfocused pane keeps its pointer answers, and window-wide surveys retain their existing focus behavior. The manual and workspace app design describe the ownership rule; terminal focus rules and survey key handling are unchanged.

The base fails eight assertions in the scoped regressions, including the mounted two-pane App retaining browser focus when the other terminal's survey appears. The fixed scoped run passes 69 tests across BubbleOverlay, pane browser focus and TerminalTab. Coverage includes focus pulses, a typed `1` reaching no survey reply until its pane is focused, return without a pulse, relocation without remounting, the active visible side, pointer answers, captured and fallback close restoration, and focus changes before queued callbacks run. The initial red run also exposed two fixture defects (survey state surviving a failed mounted test and an expected reply missing its actual option label); both were corrected before the final eight-assertion base run. Evidence: `dev/v0131-team/evidence/Edit131/surveykeys/base-red-2.log` and `focused-green.log`.

All nine isolated guard mutations fail at assertions: immediate eligibility, queued focus, close restoration, window-wide behavior, visible side, active tab, hidden surveys, focus pulses and reactive ownership. Every run restores the production source hash, and the restored scoped suite passes all 69 tests. Workspace typecheck reports zero errors and warnings; the browser instrument's syntax and the diff check pass. Evidence: `dev/v0131-team/evidence/Edit131/surveykeys/mutations/` (the results table, individual logs and restoration checks), and `typecheck.log`.

Browser check 263 raises three real surveys on each terminal backend over two terminal panes. Raw PTY controls establish where keyboard input goes; the background key must reach the focused terminal while the survey's CLI stays waiting, then separate surveys exercise a deliberate keyboard answer after focus returns and a pointer answer. The check records setup, interaction and cleanup separately. Browser base/tip proof and the committed scoped gate remain pending.
