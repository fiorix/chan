// @vitest-environment jsdom
//
// The in-tree echo extension's keyboard relay, executed as shipped, against
// Chan's side of the v2 contract. The relay's script is read out of the
// example's source and run with an isolated frame host, so what it posts is
// what a browser would post. Each relayed message then goes through Chan's
// own validation, which is the round trip an extension keydown takes before
// Chan acts on it. Every shared layout vector must get the same answer from
// both sides: the relay forwards exactly the keydowns Chan accepts.

import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { KEY_VECTORS, type KeyVector } from "@chan/web-shared/keyboard-vectors";
import { allCommands } from "./commands";
import "./commands/install";
import {
  EXTENSION_KEYMAP_MESSAGE,
  extensionHostKeys,
  hostKeyId,
  isAdvertisedHostKey,
  isExtensionKeydownMessage,
  keyboardEventFromExtension,
  type ExtensionHostKey,
} from "./extensionBridge";
import { resolveEventChord } from "./shortcuts";

const exampleSource = readFileSync(
  "../../../crates/chan-server/examples/echo-extension.rs",
  "utf8",
);
const RELAY = [...exampleSource.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join(
  "\n",
);

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64)";

type KeyInit = KeyboardEventInit & { altGraph?: boolean };

/// Chan and the frame share one browser, so both read the same user agent.
function useUserAgent(mac: boolean): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mac ? MAC_UA : LINUX_UA);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/// One loaded instance of the example frame: deliver host messages, press
/// keys, and read what it posted to its parent.
function loadRelay(mac: boolean) {
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const posted: unknown[] = [];
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const frame = {
    parent,
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const element = { addEventListener() {}, textContent: "", value: "" };
  new Function("window", "document", "navigator", RELAY)(
    frame,
    { querySelector: () => element },
    { userAgent: mac ? MAC_UA : LINUX_UA },
  );
  return {
    posted,
    hostMessage(data: unknown, source: unknown = parent) {
      for (const fn of listeners.message ?? []) fn({ source, data });
    },
    press({ altGraph, ...init }: KeyInit): KeyboardEvent {
      const event = new KeyboardEvent("keydown", {
        cancelable: true,
        ...init,
        modifierAltGraph: altGraph ?? false,
      });
      for (const fn of listeners.keydown ?? []) fn(event);
      return event;
    },
  };
}

function advertise(relay: ReturnType<typeof loadRelay>): Set<string> {
  const keys: ExtensionHostKey[] = extensionHostKeys(allCommands());
  relay.hostMessage({ type: EXTENSION_KEYMAP_MESSAGE, keys });
  return new Set(keys.map(hostKeyId));
}

/// Chan's verdict on one relayed message: validated, advertised, and the
/// chord the recreated keydown resolves to.
function chanAccepts(message: unknown, advertised: ReadonlySet<string>): string | null {
  if (!isExtensionKeydownMessage(message)) return null;
  if (!isAdvertisedHostKey(advertised, message)) return null;
  return resolveEventChord(keyboardEventFromExtension(message));
}

describe("the echo extension relays by the layout's symbol (Linux browser)", () => {
  const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };

  test("Colemak Ctrl+Shift+T on KeyF is relayed once and Chan accepts it", () => {
    const relay = loadRelay(false);
    const advertised = advertise(relay);
    const event = relay.press({ key: "T", code: "KeyF", ...CTRL_SHIFT });
    expect(event.defaultPrevented).toBe(true);
    expect(relay.posted).toHaveLength(1);
    expect(chanAccepts(relay.posted[0], advertised)).toBe("Mod+Shift+T");
  });

  test("the G on KeyT is not relayed and keeps its default", () => {
    const relay = loadRelay(false);
    advertise(relay);
    const event = relay.press({ key: "G", code: "KeyT", ...CTRL_SHIFT });
    expect(event.defaultPrevented).toBe(false);
    expect(relay.posted).toEqual([]);
  });

  test("AZERTY Ctrl+Shift+. is relayed through the consumed chord and reaches Mod+.", () => {
    const relay = loadRelay(false);
    const advertised = advertise(relay);
    relay.press({ key: ".", code: "Comma", ...CTRL_SHIFT });
    expect(relay.posted).toHaveLength(1);
    expect(chanAccepts(relay.posted[0], advertised)).toBe("Mod+.");
  });

  test("the relayed message carries the raw fields and nothing the frame resolved", () => {
    const relay = loadRelay(false);
    advertise(relay);
    relay.press({ key: "t", code: "KeyF", ...CTRL_SHIFT });
    expect(relay.posted[0]).toEqual({
      type: "chan:extension-keydown:v2",
      key: "t",
      code: "KeyF",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
      isComposing: false,
      altGraph: false,
    });
  });

  test("text entry is never relayed", () => {
    const relay = loadRelay(false);
    advertise(relay);
    relay.press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true, isComposing: true });
    relay.press({ key: "[", code: "Digit8", ctrlKey: true, altKey: true, altGraph: true });
    expect(relay.posted).toEqual([]);
  });

  test("a keymap from anywhere but the parent, or on the v1 contract, advertises nothing", () => {
    const relay = loadRelay(false);
    const keys = extensionHostKeys(allCommands());
    relay.hostMessage({ type: EXTENSION_KEYMAP_MESSAGE, keys }, {});
    relay.hostMessage({ type: "chan:extension-host-keymap:v1", keys });
    relay.press({ key: "T", code: "KeyF", ...CTRL_SHIFT });
    expect(relay.posted).toEqual([]);
  });
});

describe("the relay and Chan agree on every shared layout vector", () => {
  const cases = KEY_VECTORS.flatMap((v) =>
    (v.mac ? [true] : [false, true])
      .filter((mac) => !(mac && v.event.altGraph && !v.mac))
      .map((mac) => [`${v.name} (${mac ? "macOS" : "Linux"})`, v, mac] as const),
  );

  test.each(cases)("%s", (_name, v: KeyVector, mac) => {
    useUserAgent(mac);
    const relay = loadRelay(mac);
    const advertised = advertise(relay);
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const { altGraph, ...event } = v.event;
    const pressed = relay.press({ ...event, ...mod, altGraph });
    const raw = {
      type: "chan:extension-keydown:v2",
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey ?? false,
      altKey: event.altKey ?? false,
      metaKey: false,
      shiftKey: event.shiftKey ?? false,
      repeat: false,
      isComposing: event.isComposing ?? false,
      altGraph: altGraph ?? false,
      ...mod,
    };
    const chanWould = isExtensionKeydownMessage(raw) && isAdvertisedHostKey(advertised, raw);
    expect(relay.posted.length === 1).toBe(chanWould);
    expect(pressed.defaultPrevented).toBe(chanWould);
  });

  test("the agreement is not vacuous: some vectors are relayed and some are not", () => {
    const outcomes = cases.map(([, v, mac]) => {
      useUserAgent(mac);
      const relay = loadRelay(mac);
      advertise(relay);
      const mod = mac ? { metaKey: true } : { ctrlKey: true };
      relay.press({ ...v.event, ...mod });
      return relay.posted.length;
    });
    expect(outcomes.filter((n) => n === 1).length).toBeGreaterThanOrEqual(5);
    expect(outcomes.filter((n) => n === 0).length).toBeGreaterThanOrEqual(5);
  });
});
