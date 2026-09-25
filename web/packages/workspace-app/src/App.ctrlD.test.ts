// @vitest-environment jsdom
//
// Ctrl+D closes the active tab. App listens on the document in the capture
// phase, so it acts before an editor's own keymap and stops the key there:
// CodeMirror never adds a cursor on the same press. It takes only the literal
// Ctrl modifier, and steps aside when the user rebinds the command, when a
// modal or pane mode owns the keyboard, in a terminal (the shell reads it as
// EOF) and on a canvas board (its duplicate chord). Behind a full-window cover
// it swallows the key. On an empty pane it closes the pane, or flips a
// Hybrid pane to its other side.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { boardLoaded } from "./__tests__/excalidraw";
import { fileTab, resetLayout, terminalTab } from "./__tests__/tabs";
import { confirmState } from "./state/confirm.svelte";
import { assignOverride, hydrateOverrides } from "./state/keymapOverrides.svelte";
import { pathPromptState, promptState, setCoverBlocking } from "./state/store.svelte";
import {
  activePane,
  cancelPaneMode,
  clearRecentlyClosedTabsForTest,
  draftCloseState,
  enterPaneMode,
  layout,
  openBrowserInActivePane,
  openGraphInActivePane,
  splitPane,
  type Tab,
} from "./state/tabs.svelte";

stubAppEnvironment();

const CTRL_D = { key: "d", code: "KeyD", ctrlKey: true } as const;

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  promptState.open = false;
  pathPromptState.open = false;
  confirmState.open = false;
  draftCloseState.open = false;
  cancelPaneMode();
  setCoverBlocking("screensaver", false);
  hydrateOverrides(null);
  clearRecentlyClosedTabsForTest();
  await settle();
  await unmountApp();
});

async function seed(...tabs: Tab[]): Promise<void> {
  resetLayout(tabs);
  await settle();
}

// The tabs of the active pane in the live layout. Pane mode shows a draft
// copy through `activePane()`; a close lands on the live one.
function tabIds(): string[] {
  const pane = layout.nodes[layout.activePaneId];
  return pane?.kind === "leaf" ? pane.tabs.map((tab) => tab.id) : [];
}

describe("Ctrl+D on a tab", () => {
  test("closes a clean document and takes the key from the editor", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(tabIds()).toEqual([]);
  });

  test("closes a Files tab and a Graph tab", async () => {
    await seed();
    openBrowserInActivePane();
    await settle();
    press(CTRL_D);
    await settle();
    expect(tabIds()).toEqual([]);

    openGraphInActivePane({ mode: "semantic", scopeId: "workspace" });
    await settle();
    press(CTRL_D);
    await settle();
    expect(tabIds()).toEqual([]);
  });

  test("runs before a listener inside the page, which never sees the key", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));
    const inner = document.createElement("div");
    document.body.append(inner);
    const innerKeydown = vi.fn((event: KeyboardEvent) => event.stopPropagation());
    inner.addEventListener("keydown", innerKeydown);

    inner.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...CTRL_D }));
    await settle();

    expect(tabIds()).toEqual([]);
    expect(innerKeydown).not.toHaveBeenCalled();
  });
});

describe("Ctrl+D is left alone", () => {
  test.each([
    ["Cmd", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
  ])("with %s held as well", async (_name, extra) => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));

    press({ ...CTRL_D, ...extra });
    await settle();

    expect(tabIds()).toEqual(["doc"]);
  });

  test("once the user rebinds Close tab, which then answers to its new chord", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));
    assignOverride("app.tab.close", "Ctrl+Alt+J", "web");

    press(CTRL_D);
    await settle();
    expect(tabIds()).toEqual(["doc"]);

    press({ key: "j", code: "KeyJ", ctrlKey: true, altKey: true });
    await settle();
    expect(tabIds()).toEqual([]);
  });

  test.each([
    ["a prompt", () => (promptState.open = true)],
    ["a path prompt", () => (pathPromptState.open = true)],
    ["a confirm", () => (confirmState.open = true)],
    ["the draft close dialog", () => (draftCloseState.open = true)],
  ])("while %s is open", async (_name, open) => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));
    open();
    await settle();

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(tabIds()).toEqual(["doc"]);
  });

  test("in pane mode", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));
    enterPaneMode();
    await settle();

    press(CTRL_D);
    await settle();

    expect(tabIds()).toEqual(["doc"]);
  });

  test("in a terminal, where the shell reads it as EOF", async () => {
    await seed(terminalTab({ id: "term" }));

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(tabIds()).toEqual(["term"]);
  });

  test("on a canvas board, which duplicates with it", async () => {
    await seed(fileTab({ id: "board", path: "board.excalidraw", mode: "canvas", content: "{}", saved: "{}" }));
    await boardLoaded();

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(tabIds()).toEqual(["board"]);
  });
});

describe("Ctrl+D behind a full-window cover", () => {
  test("is swallowed, closing nothing", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));
    setCoverBlocking("screensaver", true);

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(tabIds()).toEqual(["doc"]);
  });
});

describe("Ctrl+D on an empty pane", () => {
  test("closes the pane when another is left", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }));
    const emptyPane = splitPane("pane-test", "row");
    await settle();
    expect(layout.activePaneId).toBe(emptyPane);

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(layout.nodes[emptyPane!]).toBeUndefined();
    expect(tabIds()).toEqual(["doc"]);
  });

  test("flips a Hybrid pane whose other side holds tabs", async () => {
    resetLayout([], {
      bTabs: [fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" })],
      bActiveTabId: "doc",
    });
    await settle();

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(activePane().side).toBe("b");
  });

  test("keeps the last pane of a browser window, passing the key on", async () => {
    await seed();

    const event = press(CTRL_D);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(layout.nodes["pane-test"]).toBeDefined();
  });
});
