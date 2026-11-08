// @vitest-environment jsdom
//
// The window tab bar's mode: a stored "1" forces it on and "0" off in any
// host, and without either it follows the desktop's preference, off by
// default, in chan-desktop on macOS when the installed app advertises the
// title bar command and on Windows when it also advertises the window
// control command the bar's caption buttons need. In the desktop the page
// opts in with its band height, switches live when the desktop announces a
// new preference, follows the chrome on resize once the burst settles, and
// grows the band to centre its row on the window controls. On Windows the
// chrome also lists the menus the bar draws under the Computers launcher.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resetHostVocabularyForTests } from "../api/nativeVocabulary";
import {
  NO_TITLEBAR_CHROME,
  TITLEBAR_TABS_COMMAND,
  TITLEBAR_TABS_PREFERENCE_EVENT,
  TITLEBAR_WINDOW_CONTROL_COMMAND,
  TITLEBAR_WINDOW_TITLE_EVENT,
  WINDOW_TAB_BAR_MIN_HEIGHT,
  WINDOW_TAB_BAR_ROW_HEIGHT,
  WINDOW_TAB_BAR_STORAGE_KEY,
  normalizeTitlebarChrome,
  readWindowTabBarOverride,
  setWindowTabBarPreference,
  startWindowTabBar,
  titlebarTabsSupported,
  windowTabBar,
  windowTabBarCenterPad,
  windowTabBarHeight,
  windowTabBarSettled,
  windowTabBarWanted,
  type WindowTabBarStart,
} from "./windowTabBar.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0.0.0";
const WINDOWS_COMMANDS = [TITLEBAR_TABS_COMMAND, TITLEBAR_WINDOW_CONTROL_COMMAND];

/// The launcher menubar's menus a Windows desktop lists in the mode.
const WINDOWS_MENUS = [
  { id: "chan-file-submenu", label: "File" },
  { id: "chan-edit-submenu", label: "Edit" },
  { id: "chan-view-submenu", label: "View" },
];

/// What a Windows desktop answers in the mode: no inset at the left, the
/// three caption buttons' room at the right, and the page draws them, and
/// the menus it draws under the Computers launcher.
const windowsChrome = (partial: Partial<typeof NO_TITLEBAR_CHROME> = {}) => ({
  ...NO_TITLEBAR_CHROME,
  active: true,
  insetRight: 138,
  drawControls: true,
  menus: WINDOWS_MENUS,
  ...partial,
});

const chrome = (partial: Partial<typeof NO_TITLEBAR_CHROME> = {}) => ({
  ...NO_TITLEBAR_CHROME,
  active: true,
  insetLeft: 78,
  controlsCenterY: 16,
  ...partial,
});

let started: WindowTabBarStart | null = null;
const calls: Array<{ cmd: string; args?: unknown }> = [];
const listeners = new Map<string, (event: { payload: unknown }) => void>();
/// The desktop's stored preference, which `titlebar_tabs_preference` answers;
/// an error is a refusal.
let stored: boolean | Error = false;

/// A chan-desktop webview whose app advertises `commands`, answers the
/// preference pair from `stored` and the title bar commands from `answer`.
function asDesktop(
  commands: string[],
  answer: (cmd: string, args?: unknown) => unknown = () => chrome(),
): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === "native_vocabulary") return { version: "1", build: "b", commands };
        if (cmd === "titlebar_tabs_preference") {
          if (stored instanceof Error) throw stored;
          return stored;
        }
        if (cmd === "set_titlebar_tabs_preference") {
          stored = (args as { on: boolean }).on;
          return stored;
        }
        return answer(cmd, args);
      },
    },
  });
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: {
      event: {
        listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
          listeners.set(name, handler);
          return () => listeners.delete(name);
        },
      },
    },
  });
}

/// The desktop announces its preference to the window.
async function announce(on: boolean): Promise<void> {
  listeners.get(TITLEBAR_TABS_PREFERENCE_EVENT)?.({ payload: { on } });
  await vi.waitFor(() => {
    if (windowTabBar.on !== on) throw new Error("not switched yet");
  });
}

const switches = () => calls.filter((c) => c.cmd === "set_titlebar_tabs").map((c) => c.args);

function asOS(ua: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function start(): WindowTabBarStart {
  started = startWindowTabBar();
  return started;
}

beforeEach(() => {
  asOS(MAC_UA);
});

afterEach(() => {
  started?.stop();
  started = null;
  calls.length = 0;
  listeners.clear();
  stored = false;
  delete (window as W).__TAURI_INTERNALS__;
  delete (window as W).__TAURI__;
  localStorage.clear();
  resetHostVocabularyForTests();
  windowTabBar.on = false;
  windowTabBar.available = false;
  windowTabBar.preferred = false;
  windowTabBar.title = "";
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the mode", () => {
  const vocabulary = new Set([TITLEBAR_TABS_COMMAND]);
  const both = new Set(WINDOWS_COMMANDS);

  test("a stored override wins over every host and the preference", () => {
    for (const desktop of [false, true]) {
      for (const os of ["mac", "windows", "linux"] as const) {
        for (const preferred of [false, true]) {
          expect(windowTabBarWanted({ override: "on", desktop, os, vocabulary: null, preferred })).toBe(true);
          expect(windowTabBarWanted({ override: "off", desktop, os, vocabulary: both, preferred })).toBe(false);
        }
      }
    }
  });

  test("without one it follows the preference, only in the desktop on macOS when the command is advertised", () => {
    const host = { override: null, desktop: true, os: "mac", vocabulary, preferred: true } as const;
    expect(windowTabBarWanted(host)).toBe(true);
    expect(windowTabBarWanted({ ...host, preferred: false })).toBe(false);
    expect(windowTabBarWanted({ ...host, desktop: false })).toBe(false);
    expect(windowTabBarWanted({ ...host, os: "linux" })).toBe(false);
    expect(windowTabBarWanted({ ...host, vocabulary: new Set(["other"]) })).toBe(false);
    expect(windowTabBarWanted({ ...host, vocabulary: null })).toBe(false);
  });

  test("on Windows it also needs the window control command, and Linux is never a host", () => {
    const host = { override: null, desktop: true, os: "windows", vocabulary: both, preferred: true } as const;
    expect(windowTabBarWanted(host)).toBe(true);
    expect(windowTabBarWanted({ ...host, preferred: false })).toBe(false);
    expect(windowTabBarWanted({ ...host, desktop: false })).toBe(false);
    expect(windowTabBarWanted({ ...host, vocabulary }), "an app that cannot take the window controls").toBe(false);
    expect(windowTabBarWanted({ ...host, vocabulary: new Set([TITLEBAR_WINDOW_CONTROL_COMMAND]) })).toBe(false);
    expect(windowTabBarWanted({ ...host, vocabulary: null })).toBe(false);
    expect(windowTabBarWanted({ ...host, os: "linux" })).toBe(false);

    expect(titlebarTabsSupported("mac", vocabulary)).toBe(true);
    expect(titlebarTabsSupported("mac", both)).toBe(true);
    expect(titlebarTabsSupported("windows", vocabulary)).toBe(false);
    expect(titlebarTabsSupported("windows", both)).toBe(true);
    expect(titlebarTabsSupported("linux", both)).toBe(false);
  });

  test("the override reads 1 and 0 and ignores anything else, or blocked storage", () => {
    expect(readWindowTabBarOverride()).toBeNull();
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "1");
    expect(readWindowTabBarOverride()).toBe("on");
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "0");
    expect(readWindowTabBarOverride()).toBe("off");
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "yes");
    expect(readWindowTabBarOverride()).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readWindowTabBarOverride()).toBeNull();
  });
});

describe("the boot in a browser", () => {
  test("decides at once and asks nothing", () => {
    expect(start().pending).toBeNull();
    expect(windowTabBar.on).toBe(false);
  });

  test("a forced bar is a plain top bar with no insets", () => {
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "1");
    expect(start().pending).toBeNull();
    expect(windowTabBar.on).toBe(true);
    expect(windowTabBar.chrome).toEqual(NO_TITLEBAR_CHROME);
    expect(windowTabBar.height).toBe(WINDOW_TAB_BAR_MIN_HEIGHT);
  });
});

describe("the boot in chan-desktop", () => {
  test("on macOS with the preference off, the default, offers it and keeps the title bar", async () => {
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    await start().pending;
    expect(windowTabBar.available, "Settings offers the preference").toBe(true);
    expect(windowTabBar.preferred).toBe(false);
    expect(windowTabBar.on).toBe(false);
    expect(switches()).toEqual([{ enabled: false, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT }]);
  });

  test("with the preference on, opts in with the band height and takes the chrome", async () => {
    stored = true;
    asDesktop([TITLEBAR_TABS_COMMAND]);
    const { pending } = start();
    expect(windowTabBar.on, "nothing is drawn before the desktop answers").toBe(false);
    await pending;
    expect(windowTabBar.preferred).toBe(true);
    expect(windowTabBar.on).toBe(true);
    expect(windowTabBar.chrome).toEqual(chrome());
    // The opt-in asks for the boot height, then settles the band on the
    // controls: centred at 16, a 32 px band and no empty strip under the row.
    expect(switches()).toEqual([
      { enabled: true, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT },
      { enabled: true, bandHeight: 32 },
    ]);
    expect(windowTabBar.height).toBe(32);
  });

  test("without the command advertised, stays off, offers nothing and asks nothing more", async () => {
    stored = true;
    asDesktop(["native_vocabulary"]);
    await start().pending;
    expect(windowTabBar.on).toBe(false);
    expect(windowTabBar.available).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["native_vocabulary"]);
  });

  test("a preference the desktop cannot read leaves the tabs in the panes", async () => {
    stored = new Error("Command titlebar_tabs_preference not allowed by ACL");
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await start().pending;
    expect(windowTabBar.on).toBe(false);
    expect(windowTabBar.preferred).toBe(false);
  });

  test("on Linux, decides at once and asks nothing, a forced bar included", () => {
    asOS(LINUX_UA);
    stored = true;
    asDesktop(WINDOWS_COMMANDS);
    expect(start().pending).toBeNull();
    expect(windowTabBar.on).toBe(false);
    expect(windowTabBar.available).toBe(false);

    started?.stop();
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "1");
    expect(start().pending).toBeNull();
    expect(windowTabBar.on).toBe(true);
    expect(windowTabBar.chrome).toEqual(NO_TITLEBAR_CHROME);
    expect(calls).toEqual([]);
  });

  test("on Windows with the preference on, opts in and takes the chrome with the window controls", async () => {
    asOS(WINDOWS_UA);
    stored = true;
    asDesktop(WINDOWS_COMMANDS, () => windowsChrome());
    await start().pending;
    expect(windowTabBar.available, "Settings offers the preference").toBe(true);
    expect(windowTabBar.on).toBe(true);
    expect(windowTabBar.chrome).toEqual(windowsChrome());
    expect(windowTabBar.height, "no controls to centre on").toBe(WINDOW_TAB_BAR_MIN_HEIGHT);
    expect(switches()).toEqual([{ enabled: true, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT }]);
  });

  test("on Windows with the preference off, offers it and keeps the window frame", async () => {
    asOS(WINDOWS_UA);
    asDesktop(WINDOWS_COMMANDS, () => NO_TITLEBAR_CHROME);
    await start().pending;
    expect(windowTabBar.available).toBe(true);
    expect(windowTabBar.on).toBe(false);
    expect(switches()).toEqual([{ enabled: false, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT }]);
  });

  test("a Windows app without the window control command is never asked for the title bar", async () => {
    asOS(WINDOWS_UA);
    stored = true;
    asDesktop([TITLEBAR_TABS_COMMAND], () => windowsChrome());
    await start().pending;
    expect(windowTabBar.available, "Settings offers nothing").toBe(false);
    expect(windowTabBar.on, "the tabs stay in the panes").toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["native_vocabulary"]);

    started?.stop();
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "1");
    await start().pending;
    expect(windowTabBar.on, "a forced bar is a plain top bar").toBe(true);
    expect(windowTabBar.chrome).toEqual(NO_TITLEBAR_CHROME);
    expect(switches(), "the window keeps its frame").toEqual([]);
  });

  test("on Windows a maximize or restore reaches the chrome through the resize it makes", async () => {
    asOS(WINDOWS_UA);
    stored = true;
    let answer = windowsChrome();
    asDesktop(WINDOWS_COMMANDS, () => answer);
    await start().pending;
    expect(windowTabBar.chrome.maximized).toBe(false);
    expect(windowTabBar.chrome.menus, "the desktop's menus reach the bar").toEqual(WINDOWS_MENUS);
    vi.useFakeTimers();
    answer = windowsChrome({ maximized: true });
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(60);
    expect(windowTabBar.chrome.maximized).toBe(true);

    answer = windowsChrome({ insetRight: 0, drawControls: false, fullscreen: true });
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(60);
    expect(windowTabBar.chrome.drawControls, "fullscreen draws no controls").toBe(false);
    expect(windowTabBar.chrome.insetRight).toBe(0);
    expect(windowTabBar.chrome.menus, "a fullscreen window wears no menubar either").toEqual(WINDOWS_MENUS);
  });

  test("a forced 0 turns the overlay title bar off", async () => {
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "0");
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    await start().pending;
    expect(windowTabBar.on).toBe(false);
    expect(calls.find((c) => c.cmd === "set_titlebar_tabs")?.args).toEqual({
      enabled: false,
      bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT,
    });
  });

  test("a refused opt-in leaves the preference's choice off and a forced bar plain", async () => {
    stored = true;
    asDesktop([TITLEBAR_TABS_COMMAND], () => {
      throw new Error("Command set_titlebar_tabs not allowed by ACL");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await start().pending;
    expect(windowTabBar.on).toBe(false);

    started?.stop();
    resetHostVocabularyForTests();
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "1");
    await start().pending;
    expect(windowTabBar.on).toBe(true);
    expect(windowTabBar.chrome).toEqual(NO_TITLEBAR_CHROME);
  });

  test("grows the band so its row centres on window controls set lower than the default", async () => {
    stored = true;
    asDesktop([TITLEBAR_TABS_COMMAND], () => chrome({ controlsCenterY: 26 }));
    await start().pending;
    const sent = calls.filter((c) => c.cmd === "set_titlebar_tabs").map((c) => c.args);
    expect(sent).toEqual([
      { enabled: true, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT },
      { enabled: true, bandHeight: 52 },
    ]);
    expect(windowTabBar.height).toBe(52);
  });

  test("follows the chrome on resize once the burst settles", async () => {
    stored = true;
    let answer = chrome();
    asDesktop([TITLEBAR_TABS_COMMAND], () => answer);
    await start().pending;
    vi.useFakeTimers();
    answer = chrome({ insetLeft: 0, controlsCenterY: 0, fullscreen: true });
    for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.filter((c) => c.cmd === "titlebar_chrome")).toHaveLength(1);
    expect(windowTabBar.chrome.fullscreen).toBe(true);
    expect(windowTabBar.chrome.insetLeft).toBe(0);
  });

  test("a stopped boot writes nothing and stops following resizes", async () => {
    stored = true;
    asDesktop([TITLEBAR_TABS_COMMAND]);
    const run = start();
    run.stop();
    await run.pending;
    expect(windowTabBar.on).toBe(false);
    vi.useFakeTimers();
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.filter((c) => c.cmd === "titlebar_chrome")).toEqual([]);
  });
});

describe("the preference in chan-desktop", () => {
  test("an announced change switches the window both ways without a reload", async () => {
    let active = false;
    asDesktop([TITLEBAR_TABS_COMMAND], (cmd, args) => {
      if (cmd === "set_titlebar_tabs") active = (args as { enabled: boolean }).enabled;
      return active ? chrome({ controlsCenterY: 26 }) : NO_TITLEBAR_CHROME;
    });
    await start().pending;
    expect(windowTabBar.on).toBe(false);

    await announce(true);
    expect(windowTabBar.preferred).toBe(true);
    expect(windowTabBar.height).toBe(52);
    expect(windowTabBar.chrome.active).toBe(true);

    await announce(false);
    expect(windowTabBar.preferred).toBe(false);
    expect(windowTabBar.chrome, "the chrome resets with the title bar").toEqual(NO_TITLEBAR_CHROME);
    expect(windowTabBar.height).toBe(WINDOW_TAB_BAR_MIN_HEIGHT);
    expect(switches()).toEqual([
      { enabled: false, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT },
      { enabled: true, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT },
      { enabled: true, bandHeight: 52 },
      { enabled: false, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT },
    ]);
  });

  test("a quick off and on again ends in the last choice", async () => {
    asDesktop([TITLEBAR_TABS_COMMAND]);
    await start().pending;
    listeners.get(TITLEBAR_TABS_PREFERENCE_EVENT)?.({ payload: { on: true } });
    listeners.get(TITLEBAR_TABS_PREFERENCE_EVENT)?.({ payload: { on: false } });
    listeners.get(TITLEBAR_TABS_PREFERENCE_EVENT)?.({ payload: { on: true } });
    await vi.waitFor(() => {
      if (!windowTabBar.on) throw new Error("not switched yet");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(windowTabBar.on).toBe(true);
    expect(switches().at(-1)).toEqual({ enabled: true, bandHeight: 32 });
  });

  test("a stored override ignores the preference and its changes", async () => {
    stored = true;
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "0");
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    await start().pending;
    expect(windowTabBar.on).toBe(false);
    listeners.get(TITLEBAR_TABS_PREFERENCE_EVENT)?.({ payload: { on: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(windowTabBar.on).toBe(false);
    expect(switches()).toEqual([{ enabled: false, bandHeight: WINDOW_TAB_BAR_MIN_HEIGHT }]);
  });

  test("Settings stores the preference through the desktop", async () => {
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    await start().pending;
    await setWindowTabBarPreference(true);
    expect(calls.find((c) => c.cmd === "set_titlebar_tabs_preference")?.args).toEqual({ on: true });
    expect(stored).toBe(true);
    expect(windowTabBar.preferred, "the toggle shows the stored value at once").toBe(true);
  });

  test("a stopped page stops listening", async () => {
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    const run = start();
    await run.pending;
    expect(listeners.has(TITLEBAR_TABS_PREFERENCE_EVENT)).toBe(true);
    expect(listeners.has(TITLEBAR_WINDOW_TITLE_EVENT)).toBe(true);
    run.stop();
    expect(listeners.has(TITLEBAR_TABS_PREFERENCE_EVENT)).toBe(false);
    expect(listeners.has(TITLEBAR_WINDOW_TITLE_EVENT)).toBe(false);
  });

  test("the window title the desktop sends is kept for the bar, and anything else reads empty", async () => {
    asDesktop([TITLEBAR_TABS_COMMAND], () => NO_TITLEBAR_CHROME);
    await start().pending;
    expect(windowTabBar.title).toBe("");
    listeners.get(TITLEBAR_WINDOW_TITLE_EVENT)?.({ payload: { title: "Work Window 2 [deploy]" } });
    expect(windowTabBar.title).toBe("Work Window 2 [deploy]");
    listeners.get(TITLEBAR_WINDOW_TITLE_EVENT)?.({ payload: { title: 7 } });
    expect(windowTabBar.title).toBe("");
  });
});

describe("the geometry", () => {
  test("the band is the minimum without controls, else the row's or the controls' band, whichever is taller", () => {
    expect(windowTabBarHeight(NO_TITLEBAR_CHROME)).toBe(WINDOW_TAB_BAR_MIN_HEIGHT);
    expect(windowTabBarHeight(chrome({ controlsCenterY: 14 })), "the macOS title bar at 100%").toBe(28);
    expect(windowTabBarHeight(chrome({ controlsCenterY: 16 }))).toBe(32);
    expect(windowTabBarHeight(chrome({ controlsCenterY: 25.2 }))).toBe(51);
    // At 150% the controls' 28pt band is 18.7 CSS px; the row sets the band.
    expect(windowTabBarHeight(chrome({ controlsCenterY: 14 / 1.5 }))).toBe(WINDOW_TAB_BAR_ROW_HEIGHT);
    expect(windowTabBarHeight(chrome({ controlsCenterY: 14 / 2 }))).toBe(WINDOW_TAB_BAR_ROW_HEIGHT);
  });

  test("the pad below the row puts the row's centre on the controls' centre and leaves no empty strip", () => {
    expect(windowTabBarCenterPad(NO_TITLEBAR_CHROME, 38)).toBe(0);
    for (const center of [14, 16, 25.2, 26]) {
      const c = chrome({ controlsCenterY: center });
      const height = windowTabBarHeight(c);
      const pad = windowTabBarCenterPad(c, height);
      expect((height - pad) / 2, `the row centres on y=${center}`).toBeCloseTo(center, 0);
      expect(pad, "under one px of rounding").toBeLessThan(1);
    }
    // A bar still at the boot height keeps the row on the controls' centre.
    expect((38 - windowTabBarCenterPad(chrome({ controlsCenterY: 14 }), 38)) / 2).toBe(14);
  });

  test("a zoomed-in row fills the bar from its top with no pad", () => {
    for (const zoom of [1.25, 1.5, 2]) {
      const c = chrome({ controlsCenterY: 14 / zoom });
      const height = windowTabBarHeight(c);
      expect(height).toBe(WINDOW_TAB_BAR_ROW_HEIGHT);
      expect(windowTabBarCenterPad(c, height)).toBe(0);
    }
  });

  test("a partial or malformed answer reads as zero lengths", () => {
    expect(normalizeTitlebarChrome(null)).toEqual(NO_TITLEBAR_CHROME);
    expect(normalizeTitlebarChrome({ active: true, insetLeft: "78", controlsCenterY: Number.NaN })).toEqual({
      ...NO_TITLEBAR_CHROME,
      active: true,
    });
  });

  test("the window control flags are true only when the desktop says true", () => {
    expect(NO_TITLEBAR_CHROME.drawControls).toBe(false);
    expect(NO_TITLEBAR_CHROME.maximized).toBe(false);
    expect(normalizeTitlebarChrome({ drawControls: true, maximized: true })).toMatchObject({
      drawControls: true,
      maximized: true,
    });
    for (const odd of [undefined, null, 1, "true", {}, false]) {
      expect(normalizeTitlebarChrome({ drawControls: odd, maximized: odd })).toMatchObject({
        drawControls: false,
        maximized: false,
      });
    }
    expect(normalizeTitlebarChrome({ active: true, insetRight: 138 }), "an app that predates the flags").toEqual({
      ...NO_TITLEBAR_CHROME,
      active: true,
      insetRight: 138,
    });
  });

  test("the menus are the desktop's, in its order, and only well-formed ones", () => {
    expect(NO_TITLEBAR_CHROME.menus).toEqual([]);
    expect(normalizeTitlebarChrome({ active: true, menus: WINDOWS_MENUS }).menus).toEqual(WINDOWS_MENUS);
    expect(
      normalizeTitlebarChrome({
        menus: [
          null,
          7,
          "File",
          { id: "chan-file-submenu" },
          { label: "Edit" },
          { id: "", label: "Edit" },
          { id: "chan-edit-submenu", label: "" },
          { id: "chan-edit-submenu", label: 3 },
          { id: "chan-view-submenu", label: "View", accelerator: "Alt+V" },
        ],
      }).menus,
    ).toEqual([{ id: "chan-view-submenu", label: "View" }]);
    for (const odd of [undefined, null, "File", {}, 1, true]) {
      expect(normalizeTitlebarChrome({ menus: odd }).menus).toEqual([]);
    }
    expect(
      normalizeTitlebarChrome({ active: true, insetRight: 138, drawControls: true }).menus,
      "an app that predates the menus offers none",
    ).toEqual([]);
  });

  test("the boot wait is bounded", async () => {
    vi.useFakeTimers();
    let done = false;
    void windowTabBarSettled(new Promise<void>(() => {}), 400).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });
});
