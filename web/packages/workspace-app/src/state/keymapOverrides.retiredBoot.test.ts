// @vitest-environment jsdom
//
// A window that boots over a saved shortcut table holding a chord for a
// removed command: the app's own boot loads the table, the saved table loses
// the row, and the status bar says so.

import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { api } from "../api/client";
import { updateGlobalConfigSerial } from "./configWrite";
import { hydrateOverrides, overrideChordFor } from "./keymapOverrides.svelte";
import { dismissStatus } from "./store.svelte";

stubAppEnvironment();

afterEach(async () => {
  dismissStatus();
  hydrateOverrides(null);
  await unmountApp();
});

test("booting over a saved chord for a removed command drops it from the saved table and says so", async () => {
  const target = await mountApp(undefined, {
    preferences: {
      shortcuts: {
        "app.theme.dark": { web: "Mod+Alt+D" },
        "app.search.toggle": { web: "Mod+Alt+J" },
      },
    },
  });

  await vi.waitFor(() =>
    expect(target.querySelector('[aria-label="status message"]')?.textContent?.trim()).toBe(
      "Dropped saved shortcuts for 1 removed command",
    ),
  );
  expect((await api.config()).preferences.shortcuts).toEqual({
    "app.search.toggle": { web: "Mod+Alt+J" },
  });
  expect(overrideChordFor("app.theme.dark")).toBeUndefined();
  expect(overrideChordFor("app.search.toggle")).toBe("Mod+Alt+J");
});

test("booting over a saved table with no such chord says nothing", async () => {
  const saved = { "app.search.toggle": { web: "Mod+Alt+J" } };
  const target = await mountApp(undefined, { preferences: { shortcuts: saved } });
  // A write-back would be on the window's one write chain: let it end.
  await updateGlobalConfigSerial(() => null);
  await settle();

  expect(overrideChordFor("app.search.toggle")).toBe("Mod+Alt+J");
  expect(target.querySelector('[aria-label="status message"]')).toBeNull();
  expect((await api.config()).preferences.shortcuts).toEqual(saved);
});
