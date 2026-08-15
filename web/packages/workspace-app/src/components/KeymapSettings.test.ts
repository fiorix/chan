// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate from the real catalog (install pulls every lane's module).
vi.mock("../state/commands/install", () => ({}));

import KeymapSettings from "./KeymapSettings.svelte";
import { registerCommands, type Command } from "../state/commands";
import { hydrateOverrides } from "../state/keymapOverrides.svelte";

function cmd(id: string, title: string, extra: Partial<Command> = {}): Command {
  return {
    id,
    title,
    category: "Global",
    requirement: "any",
    available: () => true,
    run: () => {},
    ...extra,
  };
}

registerCommands([
  cmd("app.search.toggle", "Search"),
  cmd("app.custom.demo", "Demo"),
  cmd("app.pane.kill", "Close pane", {
    shortcutEditable: false,
    shortcutIds: ["app.tab.close", "app.window.close"],
  }),
]);

const mounted: Array<Record<string, unknown>> = [];

async function flush(): Promise<void> {
  await tick();
  await tick();
}

function mountGrid(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(KeymapSettings, { target }) as Record<string, unknown>);
  return target;
}

describe("KeymapSettings grid", () => {
  beforeEach(() => {
    // Web mac client -> the web column is "this device".
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
  });
  afterEach(() => {
    for (const c of mounted.splice(0)) unmount(c);
    document.body.innerHTML = "";
    hydrateOverrides(null);
    vi.unstubAllGlobals();
  });

  test("renders a column per OS slot and marks the current client", async () => {
    const target = mountGrid();
    await flush();
    const heads = [...target.querySelectorAll(".head .col-slot")].map((e) =>
      e.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(heads[0]).toContain("Web");
    expect(heads.map((h) => h?.replace("this device", "").trim())).toEqual([
      "Web",
      "macOS",
      "Linux",
      "Windows",
    ]);
    // The web column is flagged for this client (browser).
    expect(target.querySelector(".head .col-slot.active .here")?.textContent).toBe(
      "this device",
    );
  });

  test("renders an assign cell per command per slot", async () => {
    const target = mountGrid();
    await flush();
    const rows = [...target.querySelectorAll(".grid .row:not(.head)")];
    const searchRow = rows.find(
      (r) => r.querySelector(".col-cmd")?.textContent === "Search",
    ) as HTMLElement;
    // Four slots, each a CommandChordAssign chord button.
    expect(searchRow.querySelectorAll(".chord-btn").length).toBe(4);
  });

  test("renders non-editable commands as read-only shortcut cells", async () => {
    const target = mountGrid();
    await flush();
    const rows = [...target.querySelectorAll(".grid .row:not(.head)")];
    const closePaneRow = rows.find(
      (r) => r.querySelector(".col-cmd")?.textContent === "Close pane",
    ) as HTMLElement;
    expect(closePaneRow.querySelectorAll(".chord-btn.readonly").length).toBe(4);
    expect(closePaneRow.querySelector(".reset")).toBeNull();
  });

  test("the filter narrows the command list", async () => {
    const target = mountGrid();
    await flush();
    const input = target.querySelector(".search") as HTMLInputElement;
    input.value = "demo";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    const names = [...target.querySelectorAll(".col-cmd")].map((e) => e.textContent);
    expect(names).toContain("Demo");
    expect(names).not.toContain("Search");
  });
});
