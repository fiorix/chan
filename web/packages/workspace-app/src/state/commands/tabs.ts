import { registerCommands, type Command } from "../commands";
import { moveActiveTabToSide, type PaneSide } from "../tabs.svelte";

function sendToSideCommand(targetSide: PaneSide): Command {
  const label = targetSide.toUpperCase();
  return {
    id: targetSide === "a" ? "app.tab.sendToA" : "app.tab.sendToB",
    title: `Send tab to side ${label}`,
    category: "Tabs",
    requirement: "any",
    keywords: ["move", "send", "side", label.toLowerCase()],
    available: (ctx) =>
      ctx.activeTabId !== null &&
      ctx.activeSide !== null &&
      ctx.activeSide !== targetSide,
    run: () => {
      moveActiveTabToSide(targetSide);
    },
  };
}

registerCommands([sendToSideCommand("a"), sendToSideCommand("b")]);
