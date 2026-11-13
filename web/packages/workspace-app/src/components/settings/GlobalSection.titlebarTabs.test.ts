// @vitest-environment jsdom
//
// Settings > Global in the window tab bar's terms: the title bar tabs row is
// offered only where the window can put its tabs in the title bar, on macOS
// and on Windows, writes chan-desktop's own preference rather than the
// server's, and shows a refusal under itself; the pane strip auto-hide row
// leaves while the tabs are in the title bar, where it has nothing to hide.

import { afterEach, describe, expect, test, vi } from "vitest";

import { resetHostVocabularyForTests } from "../../api/nativeVocabulary";
import { closeSettings, openSettings, settleSettings } from "../../__tests__/settings";
import {
  NO_TITLEBAR_CHROME,
  startWindowTabBar,
  TITLEBAR_TABS_COMMAND,
  TITLEBAR_WINDOW_CONTROL_COMMAND,
  windowTabBar,
  type WindowTabBarStart,
} from "../../state/windowTabBar.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

const invokes: Array<{ cmd: string; args?: unknown }> = [];
let started: WindowTabBarStart | null = null;

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
  started?.stop();
  started = null;
  closeSettings();
  invokes.length = 0;
  delete (window as W).__TAURI_INTERNALS__;
  resetHostVocabularyForTests();
  windowTabBar.available = false;
  windowTabBar.preferred = false;
  windowTabBar.on = false;
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  vi.restoreAllMocks();
});

/// Boot the window tab bar in a chan-desktop on Windows whose app advertises
/// `commands`, with the preference off, then open Settings.
async function bootOnWindows(commands: string[]): Promise<HTMLElement> {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0.0.0",
  );
  asDesktop((cmd) => {
    if (cmd === "native_vocabulary") return { version: "1", build: "b", commands };
    if (cmd === "titlebar_tabs_preference") return false;
    return NO_TITLEBAR_CHROME;
  });
  started = startWindowTabBar();
  await started.pending;
  return (await openSettings("Global")).target;
}

describe("Settings > Global > Title bar tabs", () => {
  test("a window that cannot put its tabs in the title bar offers no row and keeps auto-hide", async () => {
    const { target } = await openSettings("Global");
    expect(field(target, "Title bar tabs")).toBeNull();
    expect(field(target, "Pane strip auto-hide")).not.toBeNull();
  });

  test("on Windows the row is offered once the app can take the bar's window controls", async () => {
    const target = await bootOnWindows([TITLEBAR_TABS_COMMAND, TITLEBAR_WINDOW_CONTROL_COMMAND]);
    expect(field(target, "Title bar tabs")).not.toBeNull();
    expect(field(target, "Pane strip auto-hide"), "the tabs are still in the panes").not.toBeNull();
  });

  test("on Windows an app without the window control command offers no row", async () => {
    const target = await bootOnWindows([TITLEBAR_TABS_COMMAND]);
    expect(field(target, "Title bar tabs")).toBeNull();
    expect(field(target, "Pane strip auto-hide")).not.toBeNull();
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
    expect(field(target, "Pane strip auto-hide")).toBeNull();

    windowTabBar.on = false;
    await settleSettings();
    expect(field(target, "Pane strip auto-hide")).not.toBeNull();
  });
});
