import { describe, expect, test } from "vitest";
import graph from "./GraphPanel.svelte?raw";

// `Reload graph` is the one graph command whose work lives in the component:
// the /api/graph fetch and its depth probe are here, so the catalog entry
// dispatches `app.graph.reload` and this panel serves it. The right-click row
// stays gone (menuTrims pins that); these pin the bridge that replaced it, so
// a rename on either side fails loudly instead of leaving a dead command.

describe("GraphPanel serves app.graph.reload", () => {
  test("a chan:command listener routes the id to reloadGraph", () => {
    expect(graph).toMatch(
      /\(e as CustomEvent\)\.detail\?\.name !== "app\.graph\.reload"[\s\S]{1,300}void reloadGraph\(\)/,
    );
  });

  test("only the graph the launcher targeted reloads", () => {
    // The command's availability gate is the active surface, so the acting
    // panel has to agree: every mounted graph hears the window event.
    expect(graph).toMatch(/activeGraphTab\(\)\?\.id !== tab\.id\) return;/);
  });

  test("the listener is registered and torn down on the window", () => {
    expect(graph).toMatch(
      /window\.addEventListener\("chan:command", onLauncherCommand\)[\s\S]{1,200}window\.removeEventListener\("chan:command", onLauncherCommand\)/,
    );
  });
});
