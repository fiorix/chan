// @vitest-environment jsdom
//
// A workspace's first boot opens one empty pane: no Files tab is spawned
// and no Files browser is docked on either side. The docks start off before
// any preferences arrive, the same default chan-server writes into a fresh
// preferences file, and a user's saved choice docks them.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { demoData, mountApp, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { browserSidePanes } from "./state/store.svelte";
import { layout } from "./state/tabs.svelte";

stubAppEnvironment();

afterEach(async () => {
  await unmountApp();
  browserSidePanes.left = false;
  browserSidePanes.right = false;
});

describe("a workspace's first boot", () => {
  test("docks no Files browser before preferences arrive", async () => {
    vi.resetModules();
    const fresh = await import("./state/store.svelte");

    expect({ ...fresh.browserSidePanes }).toEqual({ left: false, right: false });
  });

  test("opens one empty pane, with no Files tab and nothing docked", async () => {
    const target = await mountApp();

    const leaves = Object.values(layout.nodes).filter((node) => node.kind === "leaf");
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ tabs: [] });
    expect(target.querySelector(".browser-side-pane")).toBeNull();
  });

  test("docks the Files browser where the user's saved preferences say", async () => {
    const target = await mountApp(demoData(), {
      preferences: { browser_side_panes: { left: true, right: false } },
    });

    expect({ ...browserSidePanes }).toEqual({ left: true, right: false });
    expect(target.querySelectorAll(".browser-side-pane")).toHaveLength(1);
  });
});
