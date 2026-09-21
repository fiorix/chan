// The desktop's injected keyboard scripts follow the same layout contract as
// the workspace app's `shortcutKey`. Each script is read out of the file that
// ships it and executed against an isolated host, so these are the chords the
// desktop runs, not a copy of them: KEY_BRIDGE_JS (every workspace window),
// the launcher's reload bridge, and the connecting page's close keys.
//
// Two kinds of check. Explicit cases pin what a keystroke from a published
// layout does. The differential case runs every shared layout vector twice,
// once as typed on its layout and once as the US-QWERTY key naming the same
// symbol, and requires the bridge to do the same thing both times: a chord
// follows the symbol, never the position.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { KEY_VECTORS, type KeyVector } from "@chan/web-shared/keyboard-vectors";

const serveSource = readFileSync("../../../desktop/src-tauri/src/serve.rs", "utf8");
const KEY_BRIDGE = serveSource.match(/const KEY_BRIDGE_JS: &str = r#"([\s\S]*?)"#;/)![1];
const mainSource = readFileSync("../../../desktop/src-tauri/src/main.rs", "utf8");
const RELOAD_BRIDGE = mainSource.match(
  /const LAUNCHER_RELOAD_BRIDGE_JS: &str = r#"([\s\S]*?)"#;/,
)![1];
const CONNECTING_JS = readFileSync("../../../desktop/src/connecting.js", "utf8");
const CONNECTING_HTML = readFileSync("../../../desktop/src/connecting.html", "utf8");

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64)";

type KeyInit = KeyboardEventInit & { altGraph?: boolean };

type BridgeOutcome = { commands: string[]; ipc: string[]; prevented: boolean };

function keydown({ altGraph, ...init }: KeyInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    cancelable: true,
    ...init,
    modifierAltGraph: altGraph ?? false,
  });
}

/// Run KEY_BRIDGE_JS on a fresh host and press one key. The host records
/// command events and IPC invokes, so a duplicate dispatch is visible.
function pressKeyBridge(init: KeyInit, mac: boolean): BridgeOutcome {
  const commands: string[] = [];
  const ipc: string[] = [];
  const listeners: Array<(e: KeyboardEvent) => void> = [];
  const host = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === "keydown") listeners.push(fn);
    },
    dispatchEvent: (e: CustomEvent<{ name: string; index?: number }>) => {
      const { name, index } = e.detail;
      commands.push(index === undefined ? name : `${name}:${index}`);
      return true;
    },
    __TAURI__: {
      core: {
        invoke: (cmd: string) => {
          ipc.push(cmd);
          return Promise.resolve();
        },
      },
    },
  };
  new Function("window", "location", "CustomEvent", "navigator", KEY_BRIDGE)(
    host,
    { pathname: "/" },
    CustomEvent,
    { userAgent: mac ? MAC_UA : LINUX_UA },
  );
  const event = keydown(init);
  for (const fn of listeners) fn(event);
  return { commands, ipc, prevented: event.defaultPrevented };
}

const CMD = { metaKey: true };

describe("KEY_BRIDGE_JS follows the layout's symbols", () => {
  test.each<[string, KeyInit, Partial<BridgeOutcome>]>([
    ["US Cmd+/ splits right", { key: "/", code: "Slash" }, { commands: ["app.pane.splitRight"] }],
    [
      "US Cmd+Shift+/ types ? and splits down",
      { key: "?", code: "Slash", shiftKey: true },
      { commands: ["app.pane.splitDown"] },
    ],
    ["US Cmd+[ is the previous pane", { key: "[", code: "BracketLeft" }, { commands: ["app.pane.prev"] }],
    [
      "US Cmd+Shift+[ types { and is the previous tab",
      { key: "{", code: "BracketLeft", shiftKey: true },
      { commands: ["app.tab.prev"] },
    ],
    ["US Cmd+= zooms in", { key: "=", code: "Equal" }, { ipc: ["zoom_in"] }],
    ["US Cmd+1 jumps to the first tab", { key: "1", code: "Digit1" }, { commands: ["app.tab.jump:0"] }],
    [
      "Dvorak / on BracketLeft splits right",
      { key: "/", code: "BracketLeft" },
      { commands: ["app.pane.splitRight"] },
    ],
    [
      "Dvorak [ on Minus is the previous pane, not zoom out",
      { key: "[", code: "Minus" },
      { commands: ["app.pane.prev"], ipc: [] },
    ],
    [
      "Dvorak { on Shift+Minus is the previous tab",
      { key: "{", code: "Minus", shiftKey: true },
      { commands: ["app.tab.prev"] },
    ],
    [
      "Dvorak = on BracketRight zooms in, not the next pane",
      { key: "=", code: "BracketRight" },
      { commands: [], ipc: ["zoom_in"] },
    ],
    [
      "QWERTZ - on Slash zooms out, not split right",
      { key: "-", code: "Slash" },
      { commands: [], ipc: ["zoom_out"] },
    ],
    [
      "QWERTZ + on BracketRight zooms in, not the next pane",
      { key: "+", code: "BracketRight" },
      { commands: [], ipc: ["zoom_in"] },
    ],
    [
      "AZERTY shifted / on Period takes the explicit Shift and splits down",
      { key: "/", code: "Period", shiftKey: true },
      { commands: ["app.pane.splitDown"] },
    ],
    [
      "AZERTY & on Digit1 keeps the digit position",
      { key: "&", code: "Digit1" },
      { commands: ["app.tab.jump:0"] },
    ],
    [
      "AZERTY dead ^ on BracketLeft is not a chord",
      { key: "Dead", code: "BracketLeft" },
      { commands: [], ipc: [], prevented: false },
    ],
    [
      "Colemak T on KeyF opens a terminal",
      { key: "t", code: "KeyF" },
      { commands: ["app.terminal.toggle"] },
    ],
    [
      "Colemak G on KeyT is find next, not a terminal",
      { key: "g", code: "KeyT" },
      { commands: ["app.find.next"] },
    ],
    [
      "an IME composition is not a chord",
      { key: "w", code: "KeyW", isComposing: true },
      { commands: [], ipc: [], prevented: false },
    ],
    ["numpad + zooms in by position", { key: "+", code: "NumpadAdd" }, { ipc: ["zoom_in"] }],
    [
      "numpad 0 resets zoom with Num Lock off",
      { key: "Insert", code: "Numpad0" },
      { ipc: ["zoom_reset"] },
    ],
  ])("macOS: %s", (_name, init, expected) => {
    const outcome = pressKeyBridge({ ...CMD, ...init }, true);
    expect(outcome).toMatchObject(expected);
  });

  test("macOS Cmd+Option+I opens DevTools when Option makes I a dead key", () => {
    const outcome = pressKeyBridge({ key: "Dead", code: "KeyI", metaKey: true, altKey: true }, true);
    expect(outcome.ipc).toEqual(["open_devtools"]);
  });

  test("macOS Option reported as AltGraph still opens DevTools", () => {
    const outcome = pressKeyBridge(
      { key: "Dead", code: "KeyI", metaKey: true, altKey: true, altGraph: true },
      true,
    );
    expect(outcome.ipc).toEqual(["open_devtools"]);
  });

  test("Linux Ctrl+AltGr+8 typing [ is character entry, not tab 8", () => {
    const outcome = pressKeyBridge(
      { key: "[", code: "Digit8", ctrlKey: true, altGraph: true },
      false,
    );
    expect(outcome).toEqual({ commands: [], ipc: [], prevented: false });
  });

  test("Windows AltGr+W typing å does not close the window", () => {
    const outcome = pressKeyBridge(
      { key: "å", code: "KeyW", ctrlKey: true, altKey: true, altGraph: true },
      false,
    );
    expect(outcome).toEqual({ commands: [], ipc: [], prevented: false });
  });

  test("Linux Ctrl+Alt+W still closes the window", () => {
    const outcome = pressKeyBridge({ key: "w", code: "KeyW", ctrlKey: true, altKey: true }, false);
    expect(outcome.commands).toEqual(["app.window.close"]);
  });
});

/// US-QWERTY positions of the symbols a chord can name, and each one's
/// shifted glyph there.
const US_POSITION: Readonly<Record<string, string>> = {
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  "=": "Equal",
  "-": "Minus",
  ".": "Period",
  ";": "Semicolon",
  "/": "Slash",
};
const US_SHIFTED: Readonly<Record<string, string>> = {
  "`": "~",
  "[": "{",
  "]": "}",
  ",": "<",
  "=": "+",
  "-": "_",
  ".": ">",
  ";": ":",
  "/": "?",
};

/// The US-QWERTY keydown naming the same symbol as `v`, or null when the
/// vector names no position-bearing symbol (named keys, other characters,
/// refused keys) or already is a US keydown (macOS Option).
function usEquivalent(v: KeyVector): KeyInit | null {
  const id = v.key;
  if (id === null || (v.mac && v.event.altKey)) return null;
  const mods = { shiftKey: v.event.shiftKey, altKey: v.event.altKey, ctrlKey: v.event.ctrlKey };
  if (/^[A-Z]$/.test(id)) {
    return { ...mods, key: v.event.shiftKey ? id : id.toLowerCase(), code: `Key${id}` };
  }
  if (/^[0-9]$/.test(id)) return { ...mods, key: id, code: `Digit${id}` };
  const code = US_POSITION[id];
  if (!code) return null;
  if (v.shifted) return { ...mods, shiftKey: true, key: US_SHIFTED[id], code };
  return { ...mods, key: id, code };
}

describe("KEY_BRIDGE_JS matches a layout's key to the US key naming the same symbol", () => {
  const cases = KEY_VECTORS.flatMap((v) => {
    const us = usEquivalent(v);
    if (!us) return [];
    const platforms = v.mac ? [true] : [false, true];
    return platforms.map((mac) => [`${v.name} (${mac ? "macOS" : "Linux"})`, v, us, mac] as const);
  });

  test("the differential covers keys the bridge claims", () => {
    // A bridge that claimed nothing would pass the comparison below; this
    // keeps it honest by requiring real dispatches among the cases.
    const claimed = cases.filter(([, , us, mac]) => {
      const mod = mac ? CMD : { ctrlKey: true };
      const outcome = pressKeyBridge({ ...us, ...mod }, mac);
      return outcome.commands.length + outcome.ipc.length > 0;
    });
    expect(claimed.length).toBeGreaterThanOrEqual(10);
  });

  test.each(cases)("%s", (_name, v, us, mac) => {
    const mod = mac ? CMD : { ctrlKey: true };
    const typed = pressKeyBridge({ ...v.event, ...mod }, mac);
    const reference = pressKeyBridge({ ...us, ...mod }, mac);
    expect(typed).toEqual(reference);
  });

  test.each(KEY_VECTORS.filter((v) => v.key === null).map((v) => [v.name, v] as const))(
    "a refused keydown claims nothing: %s",
    (_name, v) => {
      const mac = v.mac ?? false;
      const mod = mac ? CMD : { ctrlKey: true };
      expect(pressKeyBridge({ ...v.event, ...mod }, mac)).toEqual({
        commands: [],
        ipc: [],
        prevented: false,
      });
    },
  );
});

/// Run the launcher's reload bridge on a fresh host and press one key.
function pressReloadBridge(init: KeyInit): { reloads: number; prevented: boolean } {
  let reloads = 0;
  const listeners: Array<(e: KeyboardEvent) => void> = [];
  const host = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === "keydown") listeners.push(fn);
    },
    __TAURI__: {
      core: {
        invoke: (cmd: string) => {
          if (cmd === "reload_window") reloads += 1;
          return Promise.resolve();
        },
      },
    },
    location: { reload: () => (reloads += 1) },
  };
  new Function("window", RELOAD_BRIDGE)(host);
  const event = keydown(init);
  for (const fn of listeners) fn(event);
  return { reloads, prevented: event.defaultPrevented };
}

describe("the launcher reload bridge follows the layout's R", () => {
  test.each<[string, KeyInit, number]>([
    ["US Cmd+R", { key: "r", code: "KeyR", metaKey: true }, 1],
    ["Caps Lock Ctrl+R", { key: "R", code: "KeyR", ctrlKey: true }, 1],
    ["Colemak R on KeyS", { key: "r", code: "KeyS", metaKey: true }, 1],
    ["Dvorak R on KeyO", { key: "r", code: "KeyO", ctrlKey: true }, 1],
    ["Colemak P on KeyR", { key: "p", code: "KeyR", metaKey: true }, 0],
    ["Cmd+Shift+R", { key: "R", code: "KeyR", metaKey: true, shiftKey: true }, 0],
    ["Cmd+Option+R", { key: "®", code: "KeyR", metaKey: true, altKey: true }, 0],
    ["R without a modifier", { key: "r", code: "KeyR" }, 0],
  ])("%s", (_name, init, reloads) => {
    const outcome = pressReloadBridge(init);
    expect(outcome.reloads).toBe(reloads);
    expect(outcome.prevented).toBe(reloads > 0);
  });
});

describe("the connecting page's close keys follow the layout", () => {
  let closes: string[];
  let listeners: Array<(e: KeyboardEvent) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    const body = CONNECTING_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)![1];
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
    closes = [];
    listeners = [];
    const host = {
      addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
        if (type === "keydown") listeners.push(fn);
      },
      __TAURI__: {
        core: {
          invoke: (cmd: string) => {
            // The probe never answers, so the retry loop stays parked on its
            // first attempt for the whole test.
            if (cmd === "probe_url") return new Promise(() => {});
            closes.push(cmd);
            return Promise.resolve();
          },
        },
      },
      __CHAN_CONNECTING__: { url: "http://127.0.0.1:4000/", target: "http://127.0.0.1:4000/" },
    };
    new Function("window", "location", CONNECTING_JS)(host, { search: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function press(init: KeyInit): boolean {
    const event = keydown(init);
    for (const fn of listeners) fn(event);
    return event.defaultPrevented;
  }

  test.each<[string, KeyInit, boolean]>([
    ["US Ctrl+W", { key: "w", code: "KeyW", ctrlKey: true }, true],
    ["Dvorak W on Comma", { key: "w", code: "Comma", ctrlKey: true }, true],
    ["Dvorak , on KeyW", { key: ",", code: "KeyW", ctrlKey: true }, false],
    ["US Ctrl+D", { key: "d", code: "KeyD", ctrlKey: true }, true],
    ["Dvorak D on KeyH", { key: "d", code: "KeyH", ctrlKey: true }, true],
    ["Dvorak E on KeyD", { key: "e", code: "KeyD", ctrlKey: true }, false],
    ["Caps Lock Cmd+W", { key: "W", code: "KeyW", metaKey: true }, true],
    ["W without a modifier", { key: "w", code: "KeyW" }, false],
  ])("%s", (_name, init, closesWindow) => {
    expect(press(init)).toBe(closesWindow);
    expect(closes).toEqual(closesWindow ? ["request_close_window"] : []);
  });
});
