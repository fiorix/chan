// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

// Static top-level import avoids per-test dynamic import timeouts under
// the full parallel suite (contended Svelte transform/import across
// workers). The vi.mock calls are hoisted above all imports, so this
// static import still sees the mocked xterm modules.
import TerminalTab from "./TerminalTab.svelte";
import TerminalTabTestHarness from "./TerminalTabTestHarness.svelte";
import terminalSource from "./TerminalTab.svelte?raw";
import { layout, type TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";

const fitMock = vi.hoisted(() => ({
  calls: 0,
  failure: null as Error | null,
  size: null as { cols: number; rows: number } | null,
}));
const mounted: Array<Record<string, any>> = [];
const sockets: TestWebSocket[] = [];
const terminalFocuses: string[] = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

class TestWebSocket {
  static OPEN = 1;

  readyState = TestWebSocket.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};

    loadAddon(addon: {
      testFitAddon?: boolean;
      activate?: (terminal: unknown) => void;
    }) {
      if (addon.testFitAddon) addon.activate?.(this);
    }
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    focus() {
      terminalFocuses.push("focus");
    }
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    testFitAddon = true;
    terminal: { cols: number; rows: number } | null = null;

    activate(terminal: { cols: number; rows: number }) {
      this.terminal = terminal;
    }

    fit() {
      fitMock.calls += 1;
      if (fitMock.failure) throw fitMock.failure;
      if (fitMock.size && this.terminal) {
        this.terminal.cols = fitMock.size.cols;
        this.terminal.rows = fitMock.size.rows;
      }
    }
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {}
    findPrevious() {}
  },
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.WebSocket = TestWebSocket as any;
const immediateAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as any;
globalThis.requestAnimationFrame = immediateAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;
// jsdom does not implement the CSS Font Loading API. Chan's supported browser
// runtimes do, and TerminalTab now waits for the bundled terminal face before
// constructing either canvas renderer. Model that runtime contract here; the
// loader's unavailable/rejected branches are covered directly in font.test.ts.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    load: vi.fn(async () => [{}]),
    ready: Promise.resolve(),
  },
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  sockets.splice(0);
  terminalFocuses.splice(0);
  document.body.innerHTML = "";
  closeTabMenu();
  fitMock.calls = 0;
  fitMock.failure = null;
  fitMock.size = null;
  globalThis.requestAnimationFrame = immediateAnimationFrame;
  setTerminalTabsInLayout([]);
});

function terminalTab(partial: Partial<TerminalTabState> = {}): TerminalTabState {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

function setTerminalTabsInLayout(tabs: TerminalTabState[]): TerminalTabState[] {
  const paneId = "terminal-tab-test-pane";
  layout.rootId = paneId;
  layout.activePaneId = paneId;
  layout.nodes = {
    [paneId]: {
      kind: "leaf",
      id: paneId,
      tabs,
      activeTabId: tabs[0]?.id ?? null,
    },
  };
  return (layout.nodes[paneId] as { tabs: TerminalTabState[] }).tabs;
}

async function renderTerminal(
  tab: TerminalTabState,
  focused: boolean,
  side: "a" | "b" = "a",
) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: "pane-1", side, active: true, focused },
  });
  mounted.push(component);
  await tick();
  await tick();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  return { component, target };
}

function openSocket(): TestWebSocket {
  const socket = sockets.at(-1);
  if (!socket) throw new Error("expected terminal websocket");
  socket.onopen?.();
  return socket;
}

describe("TerminalTab initial fit", () => {
  test("dials with the measured grid before deferred resize callbacks", async () => {
    fitMock.size = { cols: 132, rows: 41 };
    globalThis.requestAnimationFrame = vi.fn(() => 1) as any;

    await renderTerminal(terminalTab(), true);

    expect(fitMock.calls).toBe(1);
    expect(sockets).toHaveLength(1);
    const query = new URL(sockets[0].url, "http://chan.test").searchParams;
    expect(query.get("cols")).toBe("132");
    expect(query.get("rows")).toBe("41");
  });

  test("still dials when the initial fit cannot measure the host", async () => {
    fitMock.failure = new Error("host is not measurable");
    globalThis.requestAnimationFrame = vi.fn(() => 1) as any;

    await renderTerminal(terminalTab(), true);

    expect(fitMock.calls).toBe(1);
    expect(sockets).toHaveLength(1);
    const query = new URL(sockets[0].url, "http://chan.test").searchParams;
    expect(query.get("cols")).toBe("80");
    expect(query.get("rows")).toBe("24");
  });
});

describe("TerminalTab activity frames", () => {
  test("attaches with side and reports placement on the live socket", async () => {
    const tab = terminalTab();
    await renderTerminal(tab, true, "b");

    const socket = openSocket();
    await tick();

    expect(socket.url).toContain("pane_id=pane-1&side=b&tab_id=term-1");
    expect(socket.sent).toContain(
      JSON.stringify({
        type: "placement",
        pane_id: "pane-1",
        side: "b",
        tab_id: "term-1",
      }),
    );
  });

  test("moves pane and side over the existing PTY socket", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TerminalTabTestHarness, {
      target,
      props: { tab: terminalTab() },
    });
    mounted.push(component);
    await tick();
    await tick();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = openSocket();
    await tick();
    const connectionCount = sockets.length;

    component.move("pane-2", "b");
    await tick();
    await tick();

    expect(sockets).toHaveLength(connectionCount);
    expect(socket.sent).toContain(
      JSON.stringify({
        type: "placement",
        pane_id: "pane-2",
        side: "b",
        tab_id: "term-1",
      }),
    );
  });

  test(
    "marks an active tab in an unfocused pane when activity arrives",
    async () => {
      const tab = terminalTab();
      await renderTerminal(tab, false);

      const socket = openSocket();
      await socket.onmessage?.({
        data: JSON.stringify({
          type: "session",
          id: "term-session",
          seq: 0,
          missed_bytes: 0,
          bytes_since_focus: 0,
        }),
      });
      await socket.onmessage?.({
        data: JSON.stringify({ type: "activity", bytes_since_focus: 12 }),
      });

      expect(tab.terminalActivity).toBe(true);
      expect(socket.sent).toContain(JSON.stringify({ type: "focus", focused: false }));
      expect(terminalFocuses).toHaveLength(0);
    },
  );

  test(
    "clears activity and sends focus true when the pane is focused",
    async () => {
      const tab = terminalTab({ terminalActivity: true });
      await renderTerminal(tab, true);

      const socket = openSocket();

      expect(tab.terminalActivity).toBeUndefined();
      expect(socket.sent).toContain(JSON.stringify({ type: "focus", focused: true }));
      expect(terminalFocuses.length).toBeGreaterThan(0);
    },
  );
});

describe("TerminalTab metadata settlement", () => {
  test("blur sends one pair, disables both fields, and adopts the settled ack", async () => {
    const [tab] = setTerminalTabsInLayout([
      terminalTab({ title: "url-name", group: "url-group" }),
    ]);
    await renderTerminal(tab, true);
    const socket = openSocket();

    await socket.onmessage?.({
      data: JSON.stringify({
        type: "session",
        id: "term-session-1",
        seq: 0,
        generation: 1,
        name: "worker",
        group: "ops",
        spawn_name: "spawn-worker",
        spawn_group: "spawn-ops",
      }),
    });
    openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
    await tick();

    const [nameInput, groupInput] = Array.from(
      document.body.querySelectorAll<HTMLInputElement>(".rename-input"),
    );
    expect(nameInput.value).toBe("worker");
    expect(groupInput.value).toBe("ops");

    nameInput.value = "deploy";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    groupInput.value = "release";
    groupInput.dispatchEvent(new Event("input", { bubbles: true }));
    groupInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();

    const renameFrames = socket.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "rename");
    expect(renameFrames).toEqual([{ type: "rename", name: "deploy", group: "release" }]);
    expect(tab.title).toBe("worker");
    expect(tab.group).toBe("ops");
    expect(nameInput.disabled).toBe(true);
    expect(groupInput.disabled).toBe(true);

    await socket.onmessage?.({
      data: JSON.stringify({
        type: "renamed",
        name: "deploy-2",
        group: "release",
      }),
    });
    await tick();

    expect(tab.title).toBe("deploy-2");
    expect(tab.group).toBe("release");
    expect(nameInput.value).toBe("deploy-2");
    expect(groupInput.value).toBe("release");
    expect(nameInput.disabled).toBe(false);
    expect(groupInput.disabled).toBe(false);
    const stalePrompt = document.body.querySelector(".env-stale-row")?.textContent ?? "";
    expect(stalePrompt).toContain("$CHAN_TAB_NAME");
    expect(stalePrompt).toContain("$CHAN_TAB_GROUP");

    nameInput.value = "rejected-name";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    nameInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await socket.onmessage?.({
      data: JSON.stringify({ type: "rename_failed", message: "name rejected" }),
    });
    await tick();

    expect(tab.title).toBe("deploy-2");
    expect(nameInput.value).toBe("rejected-name");
    expect(nameInput.disabled).toBe(false);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "name rejected",
    );
  });

  test("Enter submits once and a socket drop leaves the draft editable", async () => {
    const [tab] = setTerminalTabsInLayout([terminalTab()]);
    await renderTerminal(tab, true);
    const socket = openSocket();

    await socket.onmessage?.({
      data: JSON.stringify({
        type: "session",
        id: "term-session-drop",
        seq: 0,
        generation: 1,
        name: "worker",
        group: "default",
        spawn_name: "worker",
        spawn_group: "default",
      }),
    });
    openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
    await tick();

    const nameInput = document.body.querySelector<HTMLInputElement>(".rename-input")!;
    nameInput.value = "unconfirmed";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    nameInput.focus();
    nameInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await tick();

    expect(
      socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((frame) => frame.type === "rename"),
    ).toEqual([{ type: "rename", name: "unconfirmed", group: "default" }]);
    expect(nameInput.disabled).toBe(true);

    socket.close();
    await tick();

    expect(tab.title).toBe("worker");
    expect(nameInput.value).toBe("unconfirmed");
    expect(nameInput.disabled).toBe(false);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "before the metadata update was confirmed",
    );
  });
});

describe("TerminalTab menu", () => {
  test(
    "kebab menu keeps broadcast controls and Close only at the foot",
    async () => {
      const tab = terminalTab({ terminalSessionId: "term-session-1" });
      const { target } = await renderTerminal(tab, true);

      openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
      await tick();
      await tick();

      const labels = Array.from(document.body.querySelectorAll(".mbtn-label")).map(
        (el) => (el.textContent || "").trim(),
      );
      // Sanity check: the menu actually rendered.
      expect(labels.length).toBeGreaterThan(0);
      expect(labels).toContain("Close");
      for (const label of [
        "New File",
        "New Terminal",
        "New File Browser",
        "New Graph",
        "Restart",
        "Start New Session",
        "Copy path to $CWD",
        "Settings",
        "Reopen Closed Tab",
      ]) {
        expect(labels).not.toContain(label);
      }
    },
  );

  test("the terminal menu has NO Team Work toggle (the bubble is gone)", async () => {
    const tab = terminalTab({ terminalSessionId: "term-session-1" });
    await renderTerminal(tab, true);

    openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
    await tick();
    await tick();

    const labels = Array.from(document.body.querySelectorAll(".mbtn-label")).map(
      (el) => (el.textContent || "").trim(),
    );
    // The Team Work bubble composer was removed entirely; Team Work is the
    // Cmd+P dialog now, so no terminal carries a Show/Hide Team Work toggle.
    expect(labels).not.toContain("Show Team Work");
    expect(labels).not.toContain("Hide Team Work");
  });
});

describe("TerminalTab Team Work revamp (source contract)", () => {
  // The Team Work prompt and bubble overlay were rewritten. These pin
  // the load-bearing structural changes at the source level (the prompt
  // component is not mounted in the runtime tests above).

  test("App chords use the central terminal-escape registry", () => {
    // Code-based families such as Alt+Shift+[/] live in shortcuts.ts beside
    // every other App chord; TerminalTab owns no parallel shortcut list.
    expect(terminalSource).toMatch(
      /if \(shouldEscapeTerminal\(e\)\) return false;/,
    );
    expect(terminalSource).not.toMatch(
      /e\.code === "BracketLeft" \|\| e\.code === "BracketRight"/,
    );
  });

  test("the Team Work bubble composer is fully removed", () => {
    // The Team Work bubble is deleted entirely. No <TeamWork> mount, no
    // submitTeamWork/teamWorkUsesAgentSubmit helpers, no tab.teamWork, no raw
    // AGENT_SUBMIT_CHORD path. Per-terminal text input is the Rich Prompt.
    expect(terminalSource).not.toMatch(/<TeamWork\b/);
    expect(terminalSource).not.toMatch(/submitTeamWork/);
    expect(terminalSource).not.toMatch(/teamWorkUsesAgentSubmit/);
    expect(terminalSource).not.toMatch(/tab\.teamWork/);
    expect(terminalSource).not.toMatch(/AGENT_SUBMIT_CHORD/);
  });

  test("mounts a PER-TERMINAL survey overlay, keyed by tab.id", () => {
    // Surveys are per-terminal, not window-wide. Each visible
    // terminal owns an always-mounted BubbleOverlay, anchored over it. Keeping
    // the component mounted preserves its return-focus target while `shown`
    // makes a hidden survey inert; restoreFocus covers a survey first revealed
    // from a hidden tab. The App-root mount (tabId null) is the window-wide
    // fallback.
    expect(terminalSource).toMatch(
      /import BubbleOverlay from "\.\/BubbleOverlay\.svelte"/,
    );
    expect(terminalSource).toMatch(
      /<BubbleOverlay[\s\S]{1,120}tabId=\{tab\.id\}[\s\S]{1,120}shown=\{active\}[\s\S]{1,120}restoreFocus=\{focusTerminal\}/,
    );
  });

  test("all xterm focus paths share the active-survey guard", () => {
    expect(terminalSource).toMatch(
      /function focusTerminal\(\): void \{[\s\S]*?if \(surveyFor\(tab\.id\)\) return;[\s\S]*?term\?\.focus\(\);/,
    );
    expect(terminalSource.match(/term\?\.focus\(\)/g)).toHaveLength(1);
  });

  test("the deleted watcher + team-work-workspace plumbing is gone", () => {
    expect(terminalSource).not.toMatch(/refreshWatcherEvents/);
    expect(terminalSource).not.toMatch(/ensureTeamWorkWorkspace/);
    expect(terminalSource).not.toMatch(/persistTeamWorkSubmission/);
    expect(terminalSource).not.toMatch(/readWatcherEvents/);
    expect(terminalSource).not.toMatch(/watcherPollTimer/);
  });

  test("terminal links route clicks through openExternalUrl (LINKS)", () => {
    // WebLinksAddon gets a custom handler instead of its default
    // window.open(_blank), which is inert / opens in-app under the
    // chan-desktop Tauri webview. openExternalUrl gives a real browser
    // tab on web and the OS default browser on desktop.
    expect(terminalSource).toMatch(
      /new WebLinksAddon\(\(_event, uri\) => \{[\s\S]*?void openExternalUrl\(uri\);/,
    );
    expect(terminalSource).toMatch(
      /import \{ openExternalUrl \} from "\.\.\/editor\/external_links";/,
    );
  });
});
