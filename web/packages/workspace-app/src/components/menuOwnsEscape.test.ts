// @vitest-environment jsdom
//
// An open menu owns Escape: the first Escape closes the menu and nothing
// else, and focus returns to the control that opened it.
//
// The shared menu primitive consumes no keys at all, so Escape raised over an
// open menu reaches the window handler at the App root and pops the overlay
// underneath instead. The app is mounted for real against the in-memory demo
// backend because that window handler is where the competing claim lives.
//
// The pane menu is here as a green control: it behaves correctly today only
// because Pane.svelte carries its own Escape branch, which is the duplicate a
// fix deletes once the primitive owns the key. It has to keep passing.

import { mount, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { searchPanel } from "../state/store.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";
import { fileTab as harnessFileTab } from "../__tests__/tabs";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as any;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
});
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const PANE_ID = "menu-escape-pane";
const QUERY = "alpha";
const mounted: Array<Record<string, any>> = [];

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "alpha" },
    ],
  };
}

function fileTab(): FileTab {
  return harnessFileTab({
    id: "menu-escape-file",
    path: "README.md",
    content: "alpha",
    saved: "alpha",
    mode: "source",
  });
}

function seedLayout(): void {
  const tabs = [fileTab()];
  layout.nodes = {
    [PANE_ID]: {
      kind: "leaf",
      id: PANE_ID,
      tabs,
      activeTabId: tabs[0]!.id,
    } satisfies LeafNode,
  };
  layout.rootId = PANE_ID;
  layout.activePaneId = PANE_ID;
}

async function mountApp() {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }));
  await tick();
  await tick();
  seedLayout();
  await tick();
}

let timers: TimerTrack | null = null;

beforeEach(() => {
  timers = trackTimers();
});

afterEach(async () => {
  try {
    await teardownDemoApp({ mounted, timers });
  } finally {
    timers = null;
    document.body.innerHTML = "";
    searchPanel.open = false;
    searchPanel.query = "";
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

function escapeFrom(el: HTMLElement): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function openMenus(): NodeListOf<HTMLElement> {
  return document.body.querySelectorAll<HTMLElement>(".hamburger-menu");
}

/// Open the Search overlay with a query in it and open its header menu the
/// way a user does, by focusing the trigger and clicking it.
async function openSearchWithItsMenu(): Promise<HTMLButtonElement> {
  searchPanel.query = QUERY;
  searchPanel.open = true;
  await settle();
  const trigger = document.body.querySelector<HTMLButtonElement>(
    ".search header .hamburger-trigger",
  );
  expect(trigger).not.toBeNull();
  trigger!.focus();
  trigger!.click();
  await settle();
  expect(openMenus()).toHaveLength(1);
  return trigger!;
}

describe("Escape over an open menu", () => {
  test("control: with no menu open it closes the Search panel", async () => {
    await mountApp();
    searchPanel.query = QUERY;
    searchPanel.open = true;
    await settle();

    escapeFrom(document.body);
    await settle();

    expect(searchPanel.open).toBe(false);
  });

  test("closes the menu, keeps the panel, and a second Escape closes the panel", async () => {
    await mountApp();
    const trigger = await openSearchWithItsMenu();

    escapeFrom(trigger);
    await settle();

    // Soft: the panel surviving is the defect, and the two lines under it say
    // what the user keeps when it does.
    expect.soft(openMenus()).toHaveLength(0);
    expect.soft(searchPanel.open).toBe(true);
    expect.soft(searchPanel.query).toBe(QUERY);
    expect.soft(document.activeElement).toBe(trigger);

    escapeFrom(document.body);
    await settle();

    expect.soft(searchPanel.open).toBe(false);
  });

  test("control: the pane menu closes on Escape and takes nothing with it", async () => {
    await mountApp();
    const trigger = document.body.querySelector<HTMLButtonElement>(
      ".app .hamburger-trigger",
    );
    expect(trigger).not.toBeNull();
    trigger!.focus();
    trigger!.click();
    await settle();
    expect(openMenus()).toHaveLength(1);

    escapeFrom(trigger!);
    await settle();

    expect(openMenus()).toHaveLength(0);
    expect(layout.nodes[PANE_ID]).toBeDefined();
  });
});
