// @vitest-environment jsdom
//
// Settings > Global in the window tab bar's terms: the title bar tabs row is
// offered only where the window can put its tabs in the title bar, writes
// chan-desktop's own preference rather than the server's, and shows a
// refusal under itself; the pane strip auto-hide row leaves while the tabs
// are in the title bar, where it has nothing to hide.

import { afterEach, describe, expect, test } from "vitest";

import { closeSettings, openSettings, settleSettings } from "../../__tests__/settings";
import { windowTabBar } from "../../state/windowTabBar.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

const invokes: Array<{ cmd: string; args?: unknown }> = [];

function asDesktop(answer: (cmd: string, args?: unknown) => unknown): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (cmd: string, args?: unknown) => {
        invokes.push({ cmd, args });
        return answer(cmd, args);
      },
    },
  });
}

function field(target: HTMLElement, label: string): HTMLElement | null {
  const heading = [...target.querySelectorAll<HTMLElement>(".field h3")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  return heading?.closest<HTMLElement>(".field") ?? null;
}

afterEach(() => {
  closeSettings();
  invokes.length = 0;
  delete (window as W).__TAURI_INTERNALS__;
  windowTabBar.available = false;
  windowTabBar.preferred = false;
  windowTabBar.on = false;
});

describe("Settings > Global > Title bar tabs", () => {
  test("a window that cannot put its tabs in the title bar offers no row and keeps auto-hide", async () => {
    const { target } = await openSettings("Global");
    expect(field(target, "Title bar tabs")).toBeNull();
    expect(field(target, "Pane strip")).not.toBeNull();
  });

  test("the row shows the desktop's preference and writes it through the desktop", async () => {
    windowTabBar.available = true;
    asDesktop((_cmd, args) => (args as { on: boolean }).on);
    const { target, writes } = await openSettings("Global");
    const row = field(target, "Title bar tabs")!;
    const toggle = row.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(toggle.checked).toBe(false);

    toggle.click();
    for (let turn = 0; turn < 10 && !windowTabBar.preferred; turn++) await settleSettings();
    expect(invokes).toEqual([{ cmd: "set_titlebar_tabs_preference", args: { on: true } }]);
    expect(writes, "the server's preferences are untouched").toEqual([]);
    expect(windowTabBar.preferred).toBe(true);
    expect(toggle.checked).toBe(true);
  });

  test("a refused write shows under the row", async () => {
    windowTabBar.available = true;
    asDesktop(() => {
      throw new Error("Command set_titlebar_tabs_preference not allowed by ACL");
    });
    const { target } = await openSettings("Global");
    field(target, "Title bar tabs")!.querySelector<HTMLInputElement>("input")!.click();
    let alert: Element | null = null;
    for (let turn = 0; turn < 20 && !alert; turn++) {
      await settleSettings();
      alert = field(target, "Title bar tabs")!.querySelector('[role="alert"]');
    }
    expect(alert?.textContent).toContain("not allowed by ACL");
    expect(windowTabBar.preferred).toBe(false);
  });

  test("the auto-hide row leaves while the tabs are in the title bar and returns after", async () => {
    windowTabBar.available = true;
    windowTabBar.preferred = true;
    windowTabBar.on = true;
    const { target } = await openSettings("Global");
    expect(field(target, "Pane strip")).toBeNull();

    windowTabBar.on = false;
    await settleSettings();
    expect(field(target, "Pane strip")).not.toBeNull();
  });
});
