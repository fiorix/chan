// The pane tree command: the launcher row that opens the overlay listing
// every pane, side and tab of the window. It shares its id with the chord's
// SHORTCUTS entry so the launcher shows the chord. The App dispatch has no
// case for it; run() opens the overlay directly, the way the chord does from
// PaneTreeOverlay's window listener.

import { registerCommands } from "../commands";
import { openPaneTree, PANE_TREE_COMMAND_ID, paneTreeMayOpen } from "../paneTree.svelte";

registerCommands([
  {
    id: PANE_TREE_COMMAND_ID,
    title: "Show panes and tabs",
    category: "Panes",
    scope: "window",
    order: 7,
    kind: "open",
    // Pure layout state: every window kind has panes and tabs to list.
    requirement: "any",
    keywords: ["tab search", "switch", "tabs", "panes", "sides", "tree", "find", "go to"],
    // paneTreeMayOpen also refuses the control terminal, which has one pane
    // and no strip.
    available: () => paneTreeMayOpen(),
    run: () => openPaneTree(),
  },
]);
