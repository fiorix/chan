// @vitest-environment jsdom
//
// The desktop's inspector chord as a menu shows it: Cmd+Alt+I on macOS and
// Ctrl+Alt+I on Linux and Windows, and none in a plain browser, whose
// inspector chord is the browser's own. The label must be the chord
// chan-desktop's key bridge opens the inspector on, so the bridge runs here
// from the file that ships it, as desktopBridgeLayout.test.ts runs it, and is
// pressed with the keystroke the label names.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

import { webInspectorChordLabel } from "./shortcuts";

const KEY_BRIDGE = readFileSync("../../../desktop/src-tauri/src/key_bridge.js", "utf8");

const AGENTS = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  linux: "Mozilla/5.0 (X11; Linux x86_64)",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
} as const;
type Os = keyof typeof AGENTS;

const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: () => Promise<unknown> } };

afterEach(() => {
  delete tauri.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

function runAs(os: Os, desktop: boolean): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(AGENTS[os]);
  if (desktop) tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) };
}

/// The keydown a person makes for a chord label. On macOS Option turns a
/// letter into a dead key, so the event names the letter by its key code only.
function keydownFor(label: string, os: Os): KeyboardEvent {
  const parts = label.split("+");
  const letter = parts.at(-1)!;
  return new KeyboardEvent("keydown", {
    cancelable: true,
    metaKey: parts.includes("Cmd"),
    ctrlKey: parts.includes("Ctrl"),
    altKey: parts.includes("Alt"),
    shiftKey: parts.includes("Shift"),
    code: `Key${letter}`,
    key: os === "mac" && parts.includes("Alt") ? "Dead" : letter.toLowerCase(),
  });
}

/// Whether the key bridge, as it ships, asks the desktop for its inspector on
/// this keystroke.
function bridgeOpensInspector(event: KeyboardEvent, os: Os): boolean {
  const ipc: string[] = [];
  const listeners: Array<(e: KeyboardEvent) => void> = [];
  const host = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === "keydown") listeners.push(fn);
    },
    dispatchEvent: () => true,
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
    { userAgent: AGENTS[os] },
  );
  for (const fn of listeners) fn(event);
  return ipc.includes("open_devtools");
}

describe.each([
  ["mac", "Cmd+Alt+I"],
  ["linux", "Ctrl+Alt+I"],
  ["windows", "Ctrl+Alt+I"],
] as const)("on %s", (os, label) => {
  test(`the desktop shows ${label}, the chord its key bridge opens the inspector on`, () => {
    runAs(os, true);
    expect(webInspectorChordLabel()).toBe(label);
    expect(bridgeOpensInspector(keydownFor(label, os), os)).toBe(true);
  });

  test("the bridge opens nothing on the same letter without Alt", () => {
    expect(bridgeOpensInspector(keydownFor(label.replace("Alt+", ""), os), os)).toBe(false);
  });

  test("a plain browser shows no inspector chord", () => {
    runAs(os, false);
    expect(webInspectorChordLabel()).toBeNull();
  });
});
