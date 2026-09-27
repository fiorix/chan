// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { hydrateOverrides, overrideChordFor } from "./keymapOverrides.svelte";
import { settingsPanel } from "./store.svelte";

stubAppEnvironment();

afterEach(async () => {
  settingsPanel.open = false;
  hydrateOverrides(null);
  await unmountApp();
});

test("a stored Shift-only override leaves capital-letter input to the text field", async () => {
  await mountApp(undefined, { preferences: { shortcuts: { "app.settings.open": { web: "Shift+Q" } } } });
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  const key = new KeyboardEvent("keydown", { key: "Q", code: "KeyQ", shiftKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(key);
  await settle();

  expect(key.defaultPrevented).toBe(false);
  expect(settingsPanel.open).toBe(false);
  expect(overrideChordFor("app.settings.open")).toBeUndefined();
});
