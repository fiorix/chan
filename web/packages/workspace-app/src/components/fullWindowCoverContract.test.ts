// @vitest-environment jsdom
//
// Every full-window cover blocks app input for as long as it is mounted, and
// a command is offered only in windows where it can run.
//
// The app is mounted for real against the in-memory demo backend, because the
// two guards under test live in App.svelte's own document listeners
// (`onWindowKey` and the Ctrl+D capture) and nothing smaller installs them.
//
// The reconnect overlay is the one cover wired to the only blocking flag
// there is, so it appears here as a green control: it is what a working
// block looks like, and it is why the four failures below are a gap in the
// mechanism rather than a harness that cannot observe a close.
//
// Not covered here, both deliberately: the host-command bridge (`runCommand`,
// the native menu) waits on the owner ruling about what the screensaver lock
// is, and the desktop close button's fast path is a separate acceptance.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import App from "../App.svelte";
import PreflightOverlay from "./PreflightOverlay.svelte";
import { api } from "../api/client";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import {
  allCommands,
  dispatchAllowsCommand,
  requirementAllows,
  type CommandRequirement,
} from "../state/commands";
import "../state/commands/install";
import { screensaver } from "../state/screensaver.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";
import {
  FULL_WINDOW_COVERS,
  raisedCoverKeys,
  setCoverBlocking,
  ui,
  type FullWindowCover,
} from "../state/store.svelte";
import { capsForMode } from "../state/windowCaps";
import { windowLifecycle } from "../state/windowLifecycle.svelte";

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

const PANE_ID = "cover-contract-pane";
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
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ],
  };
}

function fileTab(): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "cover-file",
    path: "README.md",
    content: "hello",
    saved: "hello",
    savedMtime: 1,
    mode: "source",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
}

/// One pane holding one clean document tab: a Ctrl+D target that needs no
/// confirm, so a surviving tab means the chord was blocked and nothing else.
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

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
  screensaver.locked = false;
  windowLifecycle.ended = null;
  ui.authMissing = false;
  ui.disconnectBlocking = false;
  vi.restoreAllMocks();
});

function pane(): LeafNode {
  return layout.nodes[PANE_ID] as LeafNode;
}

function tabIds(): string[] {
  return pane().tabs.map((t) => t.id);
}

function terminalCount(): number {
  return pane().tabs.filter((t) => t.kind === "terminal").length;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

/// Raise the reconnect overlay's block.
///
/// Its own visibility is driven by the watcher status, and this harness's demo
/// backend re-opens the socket under the test, so the overlay is raised here
/// through the registration it makes for itself. That the overlay makes it is
/// asserted where the overlay is mounted alone and the watcher can be held
/// down: `disconnectOverlayWatcherStatus.test.ts`.
function raiseReconnect(): void {
  setCoverBlocking("reconnect", true);
}

const CTRL_D: KeyboardEventInit = { key: "d", code: "KeyD", ctrlKey: true };
const CTRL_SHIFT_T: KeyboardEventInit = {
  key: "T",
  code: "KeyT",
  ctrlKey: true,
  shiftKey: true,
};

/// The covers that today register nothing, each with the state that raises it
/// and a selector proving it actually painted.
const UNREGISTERED_COVERS: readonly {
  name: string;
  raise: () => void;
  selector: string;
}[] = [
  {
    name: "the screensaver lock",
    raise: () => {
      screensaver.locked = true;
    },
    selector: ".screensaver-backdrop",
  },
  {
    name: "the session-ended cover",
    raise: () => {
      windowLifecycle.ended = "discarded";
    },
    selector: '[aria-label="closed by the session leader"]',
  },
  {
    name: "the missing-token cover",
    raise: () => {
      ui.authMissing = true;
    },
    selector: '[aria-label="access token missing"]',
  },
];

describe("a chord behind a full-window cover", () => {
  test("baseline: with no cover up, Ctrl+D closes the active tab", async () => {
    await mountApp();

    press(CTRL_D);
    await settle();

    expect(tabIds()).toEqual([]);
  });

  test("control: the reconnect overlay blocks it", async () => {
    await mountApp();
    raiseReconnect();
    await tick();

    press(CTRL_D);
    await settle();

    expect(tabIds()).toEqual(["cover-file"]);
  });

  test("control: the reconnect overlay still lets Backquote through", async () => {
    await mountApp();
    raiseReconnect();
    await tick();

    const event = press({ key: "`", code: "Backquote", metaKey: true });
    await settle();

    expect(event.defaultPrevented).toBe(false);
  });

  for (const cover of UNREGISTERED_COVERS) {
    test(`${cover.name} blocks it`, async () => {
      await mountApp();
      cover.raise();
      await settle();
      // A cover that never painted would make the assertion below vacuous.
      expect(document.body.querySelector(cover.selector)).not.toBeNull();

      press(CTRL_D);
      await settle();

      expect(tabIds()).toEqual(["cover-file"]);
    });

    test(`${cover.name} blocks the new-terminal chord`, async () => {
      await mountApp();
      cover.raise();
      await settle();
      expect(document.body.querySelector(cover.selector)).not.toBeNull();

      press(CTRL_SHIFT_T);
      await settle();

      expect(terminalCount()).toBe(0);
    });
  }

  test("the preflight cover blocks it", async () => {
    vi.spyOn(api, "preflight").mockResolvedValue({
      phase: "needs_decision",
      locked: true,
      readiness: { state: "recovering" },
      steps: [{ id: "open", label: "Opening", state: "pending" }],
      error: null,
    });
    await mountApp();
    await settle();
    expect(document.body.querySelector('[aria-label="preparing workspace"]')).not.toBeNull();

    press(CTRL_D);
    await settle();

    expect(tabIds()).toEqual(["cover-file"]);
  });
});

describe("every cover registers and releases the input block", () => {
  // Acceptance 1, and the reason it is a table: a sixth cover has to appear in
  // `FULL_WINDOW_COVERS` to register at all, and this test fails until it also
  // appears here, either with the state that raises it or with a pointer to
  // where raising it is asserted.
  const PROVED: Record<FullWindowCover, { raise: () => void; lower: () => void } | string> = {
    reconnect:
      "disconnectOverlayWatcherStatus.test.ts: its visibility is the watcher's, " +
      "and this harness's demo backend re-opens the socket underneath it",
    preflight:
      "the preflight cover blocks it, and a preflight that gives up drops its " +
      "cover, both in this file: raising it needs the poll mocked",
    screensaver: {
      raise: () => {
        screensaver.locked = true;
      },
      lower: () => {
        screensaver.locked = false;
      },
    },
    "session-ended": {
      raise: () => {
        windowLifecycle.ended = "discarded";
      },
      lower: () => {
        windowLifecycle.ended = null;
      },
    },
    "missing-token": {
      raise: () => {
        ui.authMissing = true;
      },
      lower: () => {
        ui.authMissing = false;
      },
    },
  };

  test("every cover in the list is accounted for here", () => {
    for (const cover of FULL_WINDOW_COVERS) {
      expect(PROVED[cover], `${cover} has no entry`).toBeDefined();
    }
  });

  for (const cover of FULL_WINDOW_COVERS) {
    const entry = PROVED[cover];
    if (typeof entry === "string") continue;
    test(`${cover} registers while up and releases when lowered`, async () => {
      await mountApp();
      expect(raisedCoverKeys()).not.toContain(cover);

      entry.raise();
      await settle();
      expect(raisedCoverKeys(), "raised").toContain(cover);

      entry.lower();
      await settle();
      expect(raisedCoverKeys(), "lowered").not.toContain(cover);
    });
  }
});

describe("a preflight that gives up", () => {
  // Mounted alone: the give-up path is this component's own poll loop, and
  // driving it through a whole App would put fake timers under every other
  // timer the app owns.
  test("drops its cover", async () => {
    vi.useFakeTimers();
    const preflight = vi
      .spyOn(api, "preflight")
      .mockResolvedValueOnce({
        phase: "needs_decision",
        locked: true,
        readiness: { state: "recovering" },
        steps: [{ id: "open", label: "Opening", state: "pending" }],
        error: null,
      })
      .mockRejectedValue(new Error("preflight unreachable"));

    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(PreflightOverlay, { target }));
    await vi.waitFor(() => expect(preflight).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelector('[aria-label="preparing workspace"]')).not.toBeNull();

    // MAX_ERROR_STREAK consecutive failures, after which the component stops
    // rescheduling and keeps its last snapshot.
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(1500);
    }

    expect(target.querySelector('[aria-label="preparing workspace"]')).toBeNull();
    vi.useRealTimers();
  });
});

describe("the lock command is offered only where it can run", () => {
  const LOCK = "app.screensaver.lock";

  function lockRequirement(): CommandRequirement {
    const row = allCommands().find((c) => c.id === LOCK);
    expect(row).toBeDefined();
    return row!.requirement;
  }

  test("a workspace window offers it", () => {
    const caps = capsForMode("workspace", false, false);
    expect(requirementAllows(lockRequirement(), caps)).toBe(true);
    expect(dispatchAllowsCommand(LOCK, caps)).toBe(true);
  });

  test("a standalone terminal window does not", () => {
    // The lock's routes and its loaded state exist only for a workspace
    // window, so the row is offered where running it can do nothing at all.
    const caps = capsForMode("terminal", false, false);
    expect(requirementAllows(lockRequirement(), caps)).toBe(false);
    expect(dispatchAllowsCommand(LOCK, caps)).toBe(false);
  });

  test("a control window does not", () => {
    const caps = capsForMode("control", false, false);
    expect(requirementAllows(lockRequirement(), caps)).toBe(false);
    expect(dispatchAllowsCommand(LOCK, caps)).toBe(false);
  });
});
