# The dashboard's slot-back component is mounted by no surface

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the icon-set change; closes in the round.

## What was seen

`web/packages/workspace-app/src/components/dashboard/DashboardSlotBack.svelte` is mounted by nothing but its own test: the pane's back-side switch stopped importing and mounting it when the pane tab flip was added (`0d59d01f0`), and Settings became the one configuration surface the same month (`4cee61b9b`). `WorkspaceSlotConfig.svelte` is imported only by that component and its own test. Three comments still describe the flip-back as live (`EmptyPaneCarousel.svelte` near its slot-back note, `WorkspaceInfoBody.svelte` in its head comment and at its configure action).

## Desired contract

The two components that no surface mounts are gone, and no comment describes the flip-back they served.

## What to do

Remove the two components and their tests, and rewrite or drop the three comments so they describe the surfaces as they are. A grep of the app for the two component names, red at the parent and green at the commit, is the pin.

## Boundaries

The two components, their two tests, the three commented files. Not changed: the dashboard's cards, the pane's back side, Settings.

## Acceptance

1. The grep pin red first; `make web-check` green at the commit.
2. The three comments read true against the code at the commit.
