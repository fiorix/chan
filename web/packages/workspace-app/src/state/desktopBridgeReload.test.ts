// The desktop's key bridge tells chan-desktop, with every Reload chord,
// whether the page still holds its access token where its own reload looks
// for it. The bridge is read out of the file that ships it and run against the
// page's own session storage, after the page's transport has taken its token
// from the URL, so the key the bridge reads is the key the transport writes.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

const KEY_BRIDGE = readFileSync("../../../desktop/src-tauri/src/key_bridge.js", "utf8");

const CHORDS = [
  [
    "macOS Cmd+R",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    { key: "r", code: "KeyR", metaKey: true },
  ],
  [
    "Linux Ctrl+Shift+R",
    "Mozilla/5.0 (X11; Linux x86_64)",
    { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true },
  ],
  [
    "Windows Ctrl+Shift+R",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true },
  ],
] as const;

type Invoked = { cmd: string; args: unknown };

/// Run the key bridge on a host whose session storage is what `storage`
/// answers, press one chord and return the IPC invokes it made.
function press(userAgent: string, init: KeyboardEventInit, storage: () => Storage): Invoked[] {
  const invoked: Invoked[] = [];
  const listeners: Array<(e: KeyboardEvent) => void> = [];
  const host = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === "keydown") listeners.push(fn);
    },
    dispatchEvent: () => true,
    get sessionStorage(): Storage {
      return storage();
    },
    __TAURI__: {
      core: {
        invoke: (cmd: string, args?: unknown) => {
          invoked.push({ cmd, args });
          return Promise.resolve();
        },
      },
    },
  };
  new Function("window", "location", "CustomEvent", "navigator", KEY_BRIDGE)(
    host,
    { pathname: "/" },
    CustomEvent,
    { userAgent },
  );
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  for (const fn of listeners) fn(event);
  expect(event.defaultPrevented, "the bridge claims the Reload chord").toBe(true);
  return invoked;
}

describe.each(CHORDS)("%s", (_name, userAgent, init) => {
  beforeEach(async () => {
    window.history.replaceState({}, "", "/?t=tok-1");
    vi.resetModules();
    await import("../api/transport");
    expect(window.location.search, "fixture: the page took its token out of the URL").toBe("");
  });

  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  test("reports the token the page's transport stored", () => {
    expect(press(userAgent, init, () => window.sessionStorage)).toEqual([
      { cmd: "reload_window", args: { tokenStored: true } },
    ]);
  });

  test("reports it gone once session storage has lost it", () => {
    window.sessionStorage.clear();
    expect(press(userAgent, init, () => window.sessionStorage)).toEqual([
      { cmd: "reload_window", args: { tokenStored: false } },
    ]);
  });

  test("reports it gone when session storage cannot be read", () => {
    const denied = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    expect(press(userAgent, init, denied)).toEqual([
      { cmd: "reload_window", args: { tokenStored: false } },
    ]);
  });
});
