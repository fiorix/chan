// The Pane scope's divider commands. Move divider left, right, up and down
// are Hybrid Nav's resize keys outside the mode: each moves the divider of
// the nearest split that holds the focused pane along its axis, by the
// mode's step and within its bounds, on the live layout, and reports the
// split's share so the launcher steps it in place. Equalize panes halves the
// pane's own split. A pane with no split on the axis, and a tmux window,
// whose layout is tmux's, are told why the command cannot run.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store.svelte")>()),
  scheduleSessionSave: vi.fn(),
  schedulePersistStateToHash: vi.fn(),
}));

import { terminalTab } from "../../__tests__/tabs";
import {
  PANE_GROUPS,
  commandById,
  commandContext,
  commandPlacement,
  commandUnavailableReason,
  type Command,
} from "../commands";
import { schedulePersistStateToHash, scheduleSessionSave } from "../store.svelte";
import {
  cancelPaneMode,
  enterPaneMode,
  layout,
  paneMode,
  paneModeEqualize,
  paneModeResize,
  type LeafNode,
  type SplitNode,
} from "../tabs.svelte";

import "./install";

const leaf = (id: string, tabs: LeafNode["tabs"] = []): LeafNode => ({
  kind: "leaf",
  id,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
});

/// A window split left and right, its right half split top and bottom:
///
///   left | top
///        | ------
///        | bottom
function threePanes(active: "left" | "top" | "bottom", tabs: LeafNode["tabs"] = []): void {
  layout.nodes = {
    left: leaf("left", tabs),
    top: leaf("top"),
    bottom: leaf("bottom"),
    column: { kind: "split", id: "column", direction: "column", a: "top", b: "bottom", ratio: 0.5 },
    row: { kind: "split", id: "row", direction: "row", a: "left", b: "column", ratio: 0.5 },
  };
  layout.rootId = "row";
  layout.activePaneId = active;
}

function ratio(id: "row" | "column", state: { nodes: typeof layout.nodes } = layout): number {
  return (state.nodes[id] as SplitNode).ratio;
}

function command(id: string): Command {
  const found = commandById(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

function available(id: string): boolean {
  return command(id).available(commandContext());
}

function reason(id: string): string | null {
  return commandUnavailableReason(command(id), commandContext());
}

const DIVIDERS = [
  { id: "app.pane.dividerLeft", title: "Move divider left", axis: "row", forward: false },
  { id: "app.pane.dividerRight", title: "Move divider right", axis: "row", forward: true },
  { id: "app.pane.dividerUp", title: "Move divider up", axis: "column", forward: false },
  { id: "app.pane.dividerDown", title: "Move divider down", axis: "column", forward: true },
] as const;

beforeEach(() => {
  vi.mocked(scheduleSessionSave).mockClear();
  vi.mocked(schedulePersistStateToHash).mockClear();
});

afterEach(() => {
  cancelPaneMode();
  threePanes("left");
});

describe("where the divider commands are listed", () => {
  test("in the Pane group, after Flip pane and before the two closes", () => {
    const order = (id: string): number => command(id).order!;
    const ids = [...DIVIDERS.map((divider) => divider.id), "app.pane.equalize"];
    for (const id of ids) {
      expect(commandPlacement(command(id)), id).toEqual({ scope: "pane", surfaces: [], group: PANE_GROUPS[2] });
      expect(order(id), id).toBeGreaterThan(order("app.pane.flip"));
      expect(order(id), id).toBeLessThan(order("app.pane.closeTabs"));
    }
    expect(DIVIDERS.map((divider) => command(divider.id).title)).toEqual(DIVIDERS.map((divider) => divider.title));
    expect(command("app.pane.equalize").title).toBe("Equalize panes");
    expect(order("app.pane.closeTabs")).toBeLessThan(order("app.pane.kill"));
  });
});

describe("moving a divider", () => {
  test.each(DIVIDERS)("$title moves the split on its axis one step and saves the layout", ({ id, axis, forward }) => {
    threePanes("top");

    command(id).run();

    const moved = axis === "row" ? "row" : "column";
    const still = axis === "row" ? "column" : "row";
    expect(ratio(moved)).toBeCloseTo(forward ? 0.52 : 0.48, 10);
    expect(ratio(still)).toBe(0.5);
    expect(scheduleSessionSave).toHaveBeenCalledTimes(1);
    expect(schedulePersistStateToHash).toHaveBeenCalledTimes(1);
  });

  test.each(DIVIDERS)("$title moves it as the Hybrid Nav key does in the mode's draft", ({ id, axis, forward }) => {
    threePanes("bottom");
    command(id).run();
    const live = { row: ratio("row"), column: ratio("column") };

    threePanes("bottom");
    enterPaneMode();
    paneModeResize(axis, forward);

    expect({ row: ratio("row", paneMode.draft!), column: ratio("column", paneMode.draft!) }).toEqual(live);
  });

  test("stops at the share the mode keeps for a pane", () => {
    for (const { id, axis, forward } of DIVIDERS) {
      threePanes("top");
      for (let step = 0; step < 40; step += 1) command(id).run();
      const live = ratio(axis === "row" ? "row" : "column");

      threePanes("top");
      enterPaneMode();
      for (let step = 0; step < 40; step += 1) paneModeResize(axis, forward);
      const draft = ratio(axis === "row" ? "row" : "column", paneMode.draft!);
      cancelPaneMode();

      expect(live, id).toBe(forward ? 0.95 : 0.05);
      expect(live, id).toBe(draft);
    }
  });

  test("reports the split's share, which keeps the launcher on the row", () => {
    threePanes("top");
    const right = command("app.pane.dividerRight");

    expect(right.state!(commandContext())).toBe("50%");
    right.run();
    expect(right.state!(commandContext())).toBe("52%");
    expect(command("app.pane.dividerLeft").state!(commandContext())).toBe("52%");
    expect(command("app.pane.dividerDown").state!(commandContext())).toBe("50%");
  });

  test("a pane with no split on the axis says what it needs", () => {
    threePanes("left");

    expect(available("app.pane.dividerLeft")).toBe(true);
    expect(available("app.pane.dividerUp")).toBe(false);
    expect(reason("app.pane.dividerUp")).toBe("Needs a pane above or below");
    command("app.pane.dividerUp").run();
    expect([ratio("row"), ratio("column")]).toEqual([0.5, 0.5]);

    layout.nodes = { only: leaf("only") };
    layout.rootId = "only";
    layout.activePaneId = "only";
    for (const { id, axis } of DIVIDERS) {
      expect(available(id), id).toBe(false);
      expect(reason(id), id).toBe(
        axis === "row" ? "Needs a pane to the left or the right" : "Needs a pane above or below",
      );
    }
    expect(reason("app.pane.equalize")).toBe("Needs a split pane");
  });
});

describe("Equalize panes", () => {
  test("halves the focused pane's own split, as the Hybrid Nav key does, and saves the layout", () => {
    threePanes("top");
    (layout.nodes.row as SplitNode).ratio = 0.3;
    (layout.nodes.column as SplitNode).ratio = 0.7;

    command("app.pane.equalize").run();

    expect([ratio("row"), ratio("column")]).toEqual([0.3, 0.5]);
    expect(scheduleSessionSave).toHaveBeenCalledTimes(1);

    (layout.nodes.column as SplitNode).ratio = 0.7;
    enterPaneMode();
    paneModeEqualize();
    expect([ratio("row", paneMode.draft!), ratio("column", paneMode.draft!)]).toEqual([0.3, 0.5]);
  });
});

describe("in a tmux window", () => {
  test("the layout is tmux's, so no divider command is offered", () => {
    threePanes("top", [terminalTab({ id: "tmux-1", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })]);

    for (const id of [...DIVIDERS.map((divider) => divider.id), "app.pane.equalize"]) {
      expect(available(id), id).toBe(false);
      expect(reason(id), id).toBe("Not available in a tmux window");
      command(id).run();
    }
    expect([ratio("row"), ratio("column")]).toEqual([0.5, 0.5]);
    expect(scheduleSessionSave).not.toHaveBeenCalled();
  });
});
