// @vitest-environment jsdom
//
// A full-window cover blocks the app's own chords, and leaves the window's
// chords to the desktop. On chan-desktop for macOS the Computers screen is
// the menubar's View > Computers on Cmd+P, and WKWebView hands the
// menubar only a key the page did not cancel, so behind a cover the window
// key handler keeps the default of the menubar's window-level chords and
// stops them from reaching anything else in the page. Off macOS the key
// bridge claims Ctrl+Shift+P on the window's capture phase, before any page
// listener, so the launcher opens behind a cover there too, while the page
// still cancels every chord that reaches it.
//
// jsdom has no menubar, so "the menubar gets it" reads as the keydown's
// default not being cancelled; "nothing in the app acts on it" reads as the
// key never reaching a window listener after the app's own.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

const host = vi.hoisted(() => ({ desktop: false }));

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => host.desktop,
}));

import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { MAC_MENUBAR_WINDOW_CHORDS } from "./state/menubarChords";
import { FULL_WINDOW_COVERS, launcherPanel, setCoverBlocking, type FullWindowCover } from "./state/store.svelte";
import { layout, type LeafNode } from "./state/tabs.svelte";

stubAppEnvironment();

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const CMD_P: KeyboardEventInit = { key: "p", code: "KeyP", metaKey: true };

/// Every keydown that reaches the window's bubble phase, after the app's own
/// document listener: a key the cover stopped never arrives here.
let reachedWindow: KeyboardEvent[] = [];
const onWindowKey = (e: Event): void => {
  reachedWindow.push(e as KeyboardEvent);
};

function lowerCovers(): void {
  for (const cover of FULL_WINDOW_COVERS) setCoverBlocking(cover, false);
}

function tabIds(): string[] {
  return (layout.nodes[layout.rootId] as LeafNode).tabs.map((t) => t.id);
}

beforeEach(async () => {
  host.desktop = true;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
  await mountApp();
  resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
  launcherPanel.open = false;
  reachedWindow = [];
  window.addEventListener("keydown", onWindowKey);
});

afterEach(async () => {
  window.removeEventListener("keydown", onWindowKey);
  lowerCovers();
  launcherPanel.open = false;
  await unmountApp();
  vi.restoreAllMocks();
});

async function raise(cover: FullWindowCover): Promise<void> {
  setCoverBlocking(cover, true);
  await settle();
}

describe("chan-desktop on macOS", () => {
  test("baseline: with no cover up, the page leaves Cmd+P to the menubar", async () => {
    const event = press(CMD_P);
    await settle();
    expect(event.defaultPrevented).toBe(false);
  });

  for (const cover of FULL_WINDOW_COVERS) {
    test(`behind the ${cover} cover, Cmd+P keeps its default and stops in the page`, async () => {
      await raise(cover);

      const event = press(CMD_P);
      await settle();

      expect(event.defaultPrevented, "the menubar's Computers item gets the key").toBe(false);
      expect(reachedWindow, "nothing after the cover's guard sees it").toEqual([]);
    });
  }

  test.each(MAC_MENUBAR_WINDOW_CHORDS.map((c) => [c.item, c] as const))(
    "behind the reconnect cover, %s keeps its default",
    async (_item, chord) => {
      await raise("reconnect");

      const event = press({
        key: chord.option ? "\u02d9" : chord.shift ? chord.letter : chord.letter.toLowerCase(),
        code: `Key${chord.letter}`,
        metaKey: true,
        shiftKey: chord.shift,
        altKey: chord.option,
      });
      await settle();

      expect(event.defaultPrevented).toBe(false);
      expect(reachedWindow).toEqual([]);
    },
  );

  test.each<[string, KeyboardEventInit]>([
    ["Cmd+K (the command deck)", { key: "k", code: "KeyK", metaKey: true }],
    ["Cmd+Shift+P (the Rich Prompt)", { key: "P", code: "KeyP", metaKey: true, shiftKey: true }],
    ["Cmd+Ctrl+P", { key: "p", code: "KeyP", metaKey: true, ctrlKey: true }],
    ["Cmd+Option+P", { key: "\u03c0", code: "KeyP", metaKey: true, altKey: true }],
    ["Cmd+T (New Terminal reaches the page as a command)", { key: "t", code: "KeyT", metaKey: true }],
    ["Cmd+W (Close Window reaches the page as a command)", { key: "w", code: "KeyW", metaKey: true }],
    ["Cmd+A (Select All acts on the page)", { key: "a", code: "KeyA", metaKey: true }],
    ["Ctrl+P", { key: "p", code: "KeyP", ctrlKey: true }],
  ])("behind the reconnect cover, %s stays cancelled", async (_name, init) => {
    await raise("reconnect");

    const event = press(init);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(reachedWindow).toEqual([]);
    expect(launcherPanel.open).toBe(false);
  });

  test("behind the reconnect cover, the app's own chord does nothing", async () => {
    await raise("reconnect");

    press({ key: "d", code: "KeyD", ctrlKey: true });
    press({ key: "k", code: "KeyK", metaKey: true });
    await settle();

    expect(tabIds(), "Ctrl+D closed no tab").toEqual(["a-file"]);
    expect(launcherPanel.open, "Cmd+K opened no command deck").toBe(false);
  });

  test("Cmd+P typed on a Dvorak layout names the same menubar item", async () => {
    await raise("reconnect");

    // Dvorak puts P on the QWERTY R key.
    const event = press({ key: "p", code: "KeyR", metaKey: true });
    await settle();

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("a browser tab on macOS", () => {
  test("behind the reconnect cover, Cmd+P stays cancelled so no print dialog opens", async () => {
    host.desktop = false;
    await raise("reconnect");

    const event = press(CMD_P);
    await settle();

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("chan-desktop off macOS", () => {
  // The bridge stays installed on this window for the rest of the file, so
  // this block runs last.
  const invoked: string[] = [];

  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX_UA);
    invoked.splice(0);
  });

  test("the key bridge toggles the launcher behind the reconnect cover; the page cancels the rest", async () => {
    const bridge = readFileSync("../../../desktop/src-tauri/src/key_bridge.js", "utf8");
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      core: {
        invoke: (cmd: string) => {
          invoked.push(cmd);
          return Promise.resolve();
        },
      },
    };
    new Function("window", "location", "CustomEvent", "navigator", bridge)(
      window,
      { pathname: "/" },
      CustomEvent,
      { userAgent: LINUX_UA },
    );
    await raise("reconnect");

    const toggle = press({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
    const plain = press({ key: "p", code: "KeyP", ctrlKey: true });
    await settle();

    expect(invoked).toEqual(["toggle_launcher_panel"]);
    expect(toggle.defaultPrevented, "the bridge claimed the toggle").toBe(true);
    expect(plain.defaultPrevented, "plain Ctrl+P stays blocked behind the cover").toBe(true);
    expect(reachedWindow).toEqual([]);
  });
});
