# The launcher's window counters are collapse toggles

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; not started.

## What was asked

The owner's words of 2026-10-27: "in the computers window, on the "This machine" screen, we have a toggle button which counts the number of windows openen on that machine (or a devserver), and it can show and hide all terminals and workspaces... we no longer need that button, but we can keep the counter; the one on workspaces we also don't need because the workspaces already have the chevron; in there we can also keep the window counter, just no need for the toggle".

## Evidence

Read at `0119a1912`, paths under `web/packages/launcher/src/`:

- `components/Library.svelte` `windowCountToggle` (around line 473) renders the machine card's window count as a `button.count-badge.machine-toggle` that collapses or expands the whole card through `state/machineCollapse.svelte.ts`; it is rendered for This machine and for each devserver header.
- The workspace card head (around line 296) renders `button.count-badge` with the same expand action as the workspace's chevron button beside it.
- Tests that pin the toggles: `components/Library.test.ts` (around lines 766-918), `components/LibraryReadOnly.test.ts` (around line 195), `components/Library.deck.test.ts` (line 98, focus lands on `.machine-toggle`), `LauncherDemo.test.ts` (line 148), and `state/machineCollapse.test.ts`.

## Desired contract

- The machine card header (This machine and every devserver) shows its window count as plain text with the same badge look; it is not a button and nothing collapses the machine card.
- The workspace card head shows its window count as plain text; the chevron is the only control that expands or collapses the workspace's windows.
- Both counts keep their "N windows" title, and the deck's keyboard walk (Left and Right across a row's controls) skips them because they are no longer controls.

## Boundaries

- Remove `state/machineCollapse.svelte.ts` and its persisted collapse state if nothing else reads it; check for a stored key that a migration should clear.
- No change to the chevron, the All windows card, or the counts' values.

## Acceptance

- No button in a machine or workspace header carries the count; the count still reads the window total.
- A machine card that a user had collapsed before the change shows its windows.
- Library, deck, read-only and demo tests updated; launcher vitest and svelte-check green; a screenshot of the demo shows the counts.

## Build findings and evidence (2026-10-27)

Built on the worktree branch `worktree-agent-a31804304f6d2e6ea` from `572c3692c`; paths under `web/packages/launcher/`.

- `src/components/Library.svelte`: one `windowCount(count)` snippet renders the badge as a `span.count-badge` with the "N window(s)" title and an `aria-hidden` icon, on the This machine header, every devserver header and each workspace head with windows. The machine cards render their content unconditionally, the workspace chevron is the only expand control, and the badge's `cursor`, `transition`, `:hover` and reduced-motion rules are gone; the badge look (padding, radius, tint, size) is unchanged.
- `src/state/machineCollapse.svelte.ts` and its test are removed (nothing else read them), with its `reconcileCollapsedMachines()` call in `src/App.svelte`. Persisted state: the set lived in localStorage under `chan-launcher-collapsed-machines` as a first-paint cache and in the desktop config's `collapsed_machines` through `GET`/`PUT /api/library/collapsed-machines`. The launcher now ignores both: it reads neither and writes neither, so a card collapsed before renders its windows. Nothing clears them; the stale localStorage key and config field are inert.
- Deck walk: `Carousel.svelte`'s `rowControls` collects `button, input[type="checkbox"], a[href]`, so the span badge drops out of Left/Right without a Carousel change. Two side effects follow from the unchanged rules: Enter on the This machine header now activates its first control, New terminal, where it collapsed the card before; and on the read-only surface the This machine header has no controls left, so Up/Down skips it (a devserver header without the desktop bridge likewise).
- Tests: `Library.test.ts` replaces the machine-collapse block with "window counts" (machine and workspace counts are spans outside any button, titles and digits match `machineWindowCount`, no `button.count-badge` and no "... windows" aria-label, New terminal leads the local actions, a disconnected devserver shows 0, a stored collapsed set leaves the content shown) and drives the workspace expand tests through the chevron. `Library.deck.test.ts`, `LibraryReadOnly.test.ts` and `LauncherDemo.test.ts` follow the new markup. `design.md` drops the collapsed-machine write from the launcher's direct fetches.
- Red first: the new tests run against the old `Library.svelte` (`git show 572c3692c:...`) gave 4 failed of 44 in `Library.test.ts`, e.g. "This machine: expected 'BUTTON' to be 'SPAN'" and "expected 'Collapse windows of This machine' to be 'New local terminal'"; the stored-set test passes on the old markup too, since the old module read localStorage at import, before the test wrote it.
- Verification: `timeout 900 npx vitest run` 64 files, 692 tests passed; `timeout 600 npx svelte-check --tsconfig ./tsconfig.json` 0 errors, 0 warnings over 4376 files. A headless Chrome run of `wave-preview.html` (the demo) on the vite dev server read the This machine card's badges as `SPAN:4 windows:4` and `SPAN:2 windows:2`, lima-vm's as `SPAN:1 window:1`, and no `button.count-badge`; the screenshot showed the counts beside the header buttons. The screenshot sits in the build seat's scratchpad, not in the tree.

Left open: the server route `/api/library/collapsed-machines`, the `CollapsedMachinesStore` in `chan-library`, the desktop config's `collapsed_machines` field and their mentions in `desktop/design.md`, `docs/config-reference.md` and `web/packages/launcher/design.md`'s refusal list now have no client; removing them is a Rust and config change outside this build's scope. Whether Enter on the This machine header should open a terminal is the owner's call.
