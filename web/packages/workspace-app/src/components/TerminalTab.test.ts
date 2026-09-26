// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

// Static top-level import avoids per-test dynamic import timeouts under
// the full parallel suite (contended Svelte transform/import across
// workers). The vi.mock calls are hoisted above all imports, so this
// static import still sees the mocked xterm modules.
import TerminalTab from "./TerminalTab.svelte";
import TerminalTabTestHarness from "./TerminalTabTestHarness.svelte";
import Pane from "./Pane.svelte";
import { api } from "../api/client";
import type { SurveySpec } from "../api/client";
import { openExternalUrl } from "../editor/external_links";
import { showSurvey, surveyState } from "../state/survey.svelte";
import {
  bumpTabFocusPulse,
  layout,
  type LeafNode,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { ownershipWarnings } from "../__tests__/svelteWarnings";
import {
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  TERMINAL_PANE,
  TerminalSocket,
  terminalTab,
  xterm,
} from "../__tests__/terminalTab";

vi.mock("../editor/external_links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editor/external_links")>()),
  openExternalUrl: vi.fn(async () => {}),
}));
vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

const mounted: Array<Record<string, any>> = [];

// jsdom does not implement the CSS Font Loading API. Chan's supported browser
// runtimes do, and TerminalTab waits for the bundled terminal face before
// constructing either canvas renderer; the harness models that runtime
// contract. The loader's unavailable/rejected branches are covered directly
// in font.test.ts.
installTerminalDom();

/// Focus calls on every terminal the tests made.
function terminalFocuses(): number {
  return xterm.terminals.reduce((n, term) => n + term.focusCount, 0);
}

function clearTerminalFocuses(): void {
  for (const term of xterm.terminals) term.focusCount = 0;
}

/// The key handler the last terminal registered with xterm.
function keyHandler(): (e: KeyboardEvent) => boolean {
  const handler = xterm.terminals.at(-1)?.keyHandler;
  if (!handler) throw new Error("no key handler registered");
  return handler;
}

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  resetTerminals();
  seatTerminals([]);
  surveyState.byTab = {};
  surveyState.windowWide = null;
  vi.clearAllMocks();
});

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
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  return { component, target };
}

function openSocket(): TerminalSocket {
  const socket = TerminalSocket.all.at(-1);
  if (!socket) throw new Error("expected terminal websocket");
  socket.onopen?.();
  return socket;
}

describe("TerminalTab initial fit", () => {
  test("dials with the measured grid before deferred resize callbacks", async () => {
    xterm.fit.size = { cols: 132, rows: 41 };
    globalThis.requestAnimationFrame = vi.fn(() => 1) as any;

    await renderTerminal(terminalTab(), true);

    expect(xterm.fit.calls).toBe(1);
    expect(TerminalSocket.all).toHaveLength(1);
    const query = new URL(TerminalSocket.all[0].url, "http://chan.test").searchParams;
    expect(query.get("cols")).toBe("132");
    expect(query.get("rows")).toBe("41");
  });

  test("still dials when the initial fit cannot measure the host", async () => {
    xterm.fit.failure = new Error("host is not measurable");
    globalThis.requestAnimationFrame = vi.fn(() => 1) as any;

    await renderTerminal(terminalTab(), true);

    expect(xterm.fit.calls).toBe(1);
    expect(TerminalSocket.all).toHaveLength(1);
    const query = new URL(TerminalSocket.all[0].url, "http://chan.test").searchParams;
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
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
    const socket = openSocket();
    await tick();
    const connectionCount = TerminalSocket.all.length;

    component.move("pane-2", "b");
    await tick();
    await tick();

    expect(TerminalSocket.all).toHaveLength(connectionCount);
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
      expect(terminalFocuses()).toBe(0);
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
      expect(terminalFocuses()).toBeGreaterThan(0);
    },
  );
});

describe("TerminalTab metadata settlement", () => {
  test("a fresh unnamed terminal in a pane takes the server's next name before it dials", async () => {
    const warnings = ownershipWarnings();
    const next = vi.spyOn(api, "terminalNextName").mockResolvedValue("t7");
    try {
      const [tab] = seatTerminals([terminalTab({ pendingGlobalName: true })]);
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(Pane, { target, props: { pane: layout.nodes[TERMINAL_PANE] as LeafNode } }));
      await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));

      expect(next).toHaveBeenCalledTimes(1);
      expect(tab!.title).toBe("t7");
      expect(tab!.pendingGlobalName).toBe(false);
      expect(warnings()).toEqual([]);
    } finally {
      next.mockRestore();
    }
  });

  test("blur sends one pair, disables both fields, and adopts the settled ack", async () => {
    const [tab] = seatTerminals([
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
    const [tab] = seatTerminals([terminalTab()]);
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
      await renderTerminal(tab, true);

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
        "New Graph",
        "Restart",
        "Start New Session",
        "Copy path to $CWD",
        "Settings",
      ]) {
        expect(labels).not.toContain(label);
      }
    },
  );

  test("neither the tab menu nor the body menu offers Reload or Open Inspector", async () => {
    const tab = terminalTab({ terminalSessionId: "term-session-1" });
    const { target } = await renderTerminal(tab, true);
    const labels = () =>
      Array.from(document.body.querySelectorAll(".mbtn-label")).map((el) => (el.textContent || "").trim());

    openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
    await tick();
    await tick();
    const tabMenu = labels();
    closeTabMenu();
    await tick();
    target
      .querySelector(".terminal-tab")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    await tick();
    const bodyMenu = labels();

    expect(tabMenu.length).toBeGreaterThan(0);
    expect(bodyMenu).toContain("Copy Scrollback");
    for (const label of ["Reload", "Open Inspector"]) {
      expect(tabMenu).not.toContain(label);
      expect(bodyMenu).not.toContain(label);
    }
  });
});

describe("TerminalTab and the app around it", () => {
  const SURVEY: SurveySpec = { surveyId: "survey-1", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };

  test("an app chord is left to the app: xterm skips it and the PTY gets nothing", async () => {
    await renderTerminal(terminalTab(), true);
    const socket = openSocket();
    socket.sent.splice(0);

    // The command launcher's chord off the Mac, flagged to escape terminals.
    const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(keyHandler()(event)).toBe(false);
    expect(socket.sent.filter((f) => JSON.parse(f).type === "input")).toEqual([]);
  });

  test("a survey raised for this terminal shows over it, and one for another terminal does not", async () => {
    const tab = terminalTab();
    const { target } = await renderTerminal(tab, true);

    showSurvey(SURVEY, "another-terminal");
    await tick();
    expect(target.querySelector(".survey-overlay")).toBeNull();

    showSurvey(SURVEY, tab.id);
    await tick();
    expect(target.querySelector(".survey-overlay .survey-title")?.textContent).toBe("Pick one");
  });

  test("while its survey is up, the terminal does not take focus back", async () => {
    const tab = terminalTab();
    await renderTerminal(tab, true);
    await tick();
    clearTerminalFocuses();

    showSurvey(SURVEY, tab.id);
    bumpTabFocusPulse();
    await tick();
    await Promise.resolve();
    expect(terminalFocuses(), "the survey keeps the keyboard").toBe(0);

    surveyState.byTab = {};
    await tick();
    await Promise.resolve();
    expect(terminalFocuses(), "closing the survey hands focus back").toBeGreaterThan(0);
    clearTerminalFocuses();
    bumpTabFocusPulse();
    await tick();
    await Promise.resolve();
    expect(terminalFocuses()).toBe(1);
  });

  test("a clicked link opens through the external-link path", async () => {
    await renderTerminal(terminalTab(), true);
    xterm.linkHandlers.at(-1)!(new MouseEvent("click"), "https://example.com/docs");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs");
  });
});
