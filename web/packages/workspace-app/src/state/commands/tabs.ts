// Send tab to side A and Send tab to side B, which close the Pane scope's
// Tab group: each moves the active tab to the pane's other side.

import { registerCommands, type Command } from "../commands";
import { moveActiveTabToSide, panesHaveSides, type PaneSide } from "../tabs.svelte";

function sendToSideCommand(targetSide: PaneSide): Command {
  const label = targetSide.toUpperCase();
  return {
    id: targetSide === "a" ? "app.tab.sendToA" : "app.tab.sendToB",
    title: `Send tab to side ${label}`,
    category: "Tabs",
    scope: "pane",
    group: "Tab",
    order: targetSide === "a" ? 4 : 5,
    requirement: "any",
    keywords: ["move", "send", "side", label.toLowerCase()],
    available: (ctx) =>
      panesHaveSides() &&
      ctx.activeTabId !== null &&
      ctx.activeSide !== null &&
      ctx.activeSide !== targetSide,
    unavailableReason: (ctx) =>
      !panesHaveSides()
        ? "Needs a pane with two sides"
        : ctx.activeTabId === null
          ? "Needs a tab"
          : `The tab is on side ${label}`,
    run: () => {
      moveActiveTabToSide(targetSide);
    },
  };
}

registerCommands([sendToSideCommand("a"), sendToSideCommand("b")]);
