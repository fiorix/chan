# Survey keyboard focus survives a tab switch

Status: REGISTERED for v0.81.0, grounded statically 2026-07-29; the live repro is the first acceptance step.

## Observed

A terminal received a survey. The user switched tabs and came back to the tab holding the survey, then typed: keystrokes went to the terminal PTY behind the card, visibly echoing under the overlay, instead of operating the survey.

## Desired contract

- While a survey is present on the tab being shown, the survey card owns the keyboard: on arrival and on every return to that tab. No keystroke reaches the PTY under the card.
- When the survey resolves (option / follow-up / dismiss), focus returns to that tab's terminal.
- A survey on a hidden tab leaves focus alone entirely. This already holds by construction (the per-terminal overlay is only mounted while its tab is shown, `TerminalTab.svelte:2491`; comment at `:2485-2490` states the intent) and must stay true. When the user selects the tab, the survey takes the keyboard then.

## Review of 8859987 (what it fixed, and the gap)

`fix(workspace): preserve shortcut focus routing` (2026-07-28) closed the arrival race and the resolve path: the grab in `BubbleOverlay.svelte:41-63` blurs immediately and focuses the card one microtask later so a terminal refocus already queued at arrival time cannot take the keyboard back; it is keyed on `surveyId`, captures the previously focused element, and restores it when the survey resolves (`:43-51`).

The gap is the tab-return path, and it is structural, not a missed call site. Switching away unmounts the per-terminal overlay (`{#if active}`, `TerminalTab.svelte:2491`), which also drops the return-focus capture; switching back remounts it and the grab re-fires, but the same flush runs the tab-activation terminal refocus. Every switch path funnels there: click (`selectTabInPane`, `state/tabs.svelte.ts:4164-4174`) and the chords (`:2923-2960`) all call `bumpTabFocusPulse` (`:2908-2921`), which blurs the current element and pulses the terminal focus effect (`TerminalTab.svelte:409-433`), whose microtask calls `term?.focus()` guarded only by `isRichPromptVisible` (`:431`), never by a survey. Two unguarded `queueMicrotask` focus calls race and the last one wins; the observed winner is the terminal. Which effect ordering produces that winner is the hypothesis the live repro confirms before any change.

## Fix shape (proposal, to be confirmed by the repro)

- Give the pulse refocus a survey carve-out symmetric with the Rich Prompt one: check `surveyFor(tab.id)` (from `state/survey.svelte`) next to `isRichPromptVisible` at `TerminalTab.svelte:431`.
- Make the card grab deterministic instead of ordering-dependent, e.g. re-grab on `tabFocusPulse` while a survey is active, rather than only on mount / `surveyId` change.
- Sweep the other `term?.focus()` sites in `TerminalTab.svelte` for any that can fire while a survey is up (menu actions, find-close, reconnect) and apply the same guard where reachable: fix the class, not the instance.

## Acceptance

- Live repro first: raise a survey (`cs terminal survey`), switch the tab away and back, type. Today's failure is keystrokes reaching the PTY behind the card; confirm before changing anything.
- Browser smoke: extend `96-survey-followup-signal.mjs` (or add a sibling check) with the tab-away/tab-back assertion: after returning, 1..N / F / X operate the card, nothing reaches the PTY, and focus lands on the terminal once the survey resolves.
- The 8859987 pins stay green: `BubbleOverlay.test.ts`, `Pane.test.ts`, `chordEscapeRegistry.test.ts`.

## Rough size

Small. One guard plus one deterministic grab; most of the work is the smoke check.

## Open

- Whether the window-wide fallback overlay (`App.svelte:1548`, always mounted, for surveys with no resolvable terminal) needs the same tab-switch treatment.
