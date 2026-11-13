// @vitest-environment jsdom
//
// A window's launcher reaches its own library alone. On chan-desktop the app
// hands it the way to every computer: its Computers scope ends with All
// computers..., which asks the desktop to show its Computers launcher over
// the window. In a browser there is no such panel, and no such row.
//
// The desktop is stood in for by `isTauriDesktop` and by the helper the row
// calls; api/desktop.launcherPanel.test.ts holds the command that helper
// sends.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

const host = vi.hoisted(() => ({ desktop: false, toggle: vi.fn(async () => {}) }));

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => host.desktop,
  toggleLauncherPanel: (...args: unknown[]) => (host.toggle as (...given: unknown[]) => Promise<void>)(...args),
}));

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { resetLayout } from "./__tests__/tabs";
import { launcherPanel } from "./state/store.svelte";

stubAppEnvironment();

afterEach(async () => {
  launcherPanel.open = false;
  launcherPanel.query = "";
  await unmountApp();
  host.desktop = false;
  host.toggle.mockClear();
});

/// Mount the app, open its launcher and type `query`.
async function search(query: string): Promise<void> {
  await mountApp();
  resetLayout([]);
  await settle();
  launcherPanel.open = true;
  await settle();
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>(".deck-input");
    expect(found, "the launcher's input").not.toBeNull();
    return found!;
  });
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: query }));
  await settle();
}

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".deck-result")];
}

function titled(title: string): HTMLButtonElement | undefined {
  return rows().find((row) => row.querySelector(".deck-result-title")?.textContent === title);
}

describe("the way from a window to every computer", () => {
  test("on chan-desktop, All computers... asks the desktop for its launcher panel", async () => {
    host.desktop = true;
    await search("all computers");
    const row = await vi.waitFor(() => {
      const found = titled("All computers...");
      expect(found, "the Computers scope's last row").toBeDefined();
      return found!;
    });

    row.click();
    await vi.waitFor(() => expect(host.toggle).toHaveBeenCalledTimes(1));

    expect(host.toggle.mock.calls[0], "the desktop's toggle takes no argument").toEqual([]);
    expect(launcherPanel.open, "the panel covers the window, so the launcher leaves").toBe(false);
  });

  test("in a browser the launcher lists no such row", async () => {
    await search("all computers");
    // The window's own library has loaded once its New terminal window row
    // can be found, so the row's absence is not a list still loading.
    const input = document.querySelector<HTMLInputElement>(".deck-input")!;
    input.value = "new terminal window";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: input.value }));
    await vi.waitFor(() => expect(titled("New terminal window")).toBeDefined());

    input.value = "all computers";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: input.value }));
    await settle();

    expect(titled("All computers...")).toBeUndefined();
    expect(host.toggle).not.toHaveBeenCalled();
  });
});
