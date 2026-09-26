// @vitest-environment jsdom
//
// Hybrid Nav never unmounts a terminal: that would dispose its xterm and drop
// the scrollback. While Hybrid Nav is on, the terminal stays mounted and is
// hidden from assistive tech, and when it ends the same terminal is active
// again. A terminal on a pane's hidden side is hidden the same way.
//
// Restructuring the panes keeps it too. A split or a tab move that rebuilt the
// terminal would dial its session for the whole retained history and replay
// bytes written at the old width into the new one, so the terminal keeps its
// renderer and its socket, is fitted to its new host, and sends that size.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { FakeTerminal, xterm } from "../__tests__/xterm";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { sessionWindowId } from "../api/client";
import { setSocketFactory } from "../api/transport";
import { demoSocketFactory } from "../demo/socket";
import { onWatchEvent } from "../state/store.svelte";
import {
  cancelPaneMode,
  closePane,
  closeTab,
  flipHybrid,
  layout,
  moveTab,
  selectTabInPane,
  setActivePane,
  splitPane,
  type LeafNode,
} from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  cancelPaneMode();
  vi.restoreAllMocks();
  await unmountApp();
  xterm.terminals.splice(0);
  xterm.fit.size = null;
});

function terminal(): HTMLElement {
  return document.querySelector<HTMLElement>(".terminal-tab")!;
}

describe("a terminal tab", () => {
  test("stays mounted through Hybrid Nav, hidden while it is on", async () => {
    resetLayout([terminalTab({ id: "term" })]);
    await settle();
    await vi.waitFor(() => expect(terminal()).not.toBeNull());
    const mounted = terminal();
    const dispose = vi.spyOn(FakeTerminal.prototype, "dispose");
    expect(mounted.getAttribute("aria-hidden")).toBe("false");

    press({ key: ".", code: "Period", ctrlKey: true });
    await settle();
    expect(terminal()).toBe(mounted);
    expect(mounted.getAttribute("aria-hidden")).toBe("true");
    expect(mounted.classList.contains("active")).toBe(false);

    press({ key: "Escape", code: "Escape" });
    await settle();
    expect(terminal()).toBe(mounted);
    expect(mounted.getAttribute("aria-hidden")).toBe("false");
    expect(dispose).not.toHaveBeenCalled();
  });

  test("is hidden on the pane's hidden side", async () => {
    resetLayout([terminalTab({ id: "term" })]);
    await settle();
    await vi.waitFor(() => expect(terminal()).not.toBeNull());

    flipHybrid("pane-test");
    await settle();

    expect(terminal().getAttribute("aria-hidden")).toBe("true");
  });
});

/// A terminal socket the app dialed: the URL it dialed and the frames it sent.
type Dial = { url: URL; sent: Array<Record<string, unknown>> };

/// Record every terminal dial from here on, over the demo's fake PTY.
function recordDials(): Dial[] {
  const dials: Dial[] = [];
  setSocketFactory((url) => {
    const socket = demoSocketFactory(url);
    if (!url.includes("/api/terminal/ws")) return socket;
    const dial: Dial = { url: new URL(url), sent: [] };
    dials.push(dial);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (typeof data === "string") dial.sent.push(JSON.parse(data) as Record<string, unknown>);
      send(data);
    };
    return socket;
  });
  return dials;
}

const HOST = "term-host";
const HOST_SESSION = "session-host";
const SEED_PANE = "pane-test";

function hostTerminal(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-terminal-tab-id="${HOST}"]`);
}

/// The live renderer drawing into the host terminal's element. A rebuilt
/// terminal dials as soon as its renderer exists, so waiting for this one
/// also waits out a dial a rebuild would make.
function liveHostRenderer(): FakeTerminal | undefined {
  const root = hostTerminal();
  return xterm.terminals.find((t) => !t.disposed && t.element !== null && root?.contains(t.element));
}

function paneHolding(el: HTMLElement): string | null {
  return el.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null;
}

/// The host terminal that ran `cs terminal team new`, live in the seed pane,
/// with an unpositioned team spawned over it and the host selected again, as
/// the owner's screen had it. Returns what survives or not: the host's
/// element, its renderer and its dials.
async function hostUnderTeam(): Promise<{ root: HTMLElement; term: FakeTerminal; dials: Dial[] }> {
  const dials = recordDials();
  resetLayout([terminalTab({ id: HOST, title: "host", terminalSessionId: HOST_SESSION })]);
  await settle();
  await vi.waitFor(() => expect(hostTerminal()).not.toBeNull());
  onWatchEvent({
    type: "window_command",
    window_id: sessionWindowId(),
    command: "team_spawned",
    group: "team-1",
    members: [
      { tab_name: "lead", session_id: "session-lead" },
      { tab_name: "worker", session_id: "session-worker" },
    ],
  });
  await settle();
  await vi.waitFor(() => expect(hostTerminal()!.getAttribute("aria-hidden")).toBe("true"));
  selectTabInPane(SEED_PANE, HOST);
  await settle();
  const root = hostTerminal()!;
  expect(root.getAttribute("aria-hidden")).toBe("false");
  const term = liveHostRenderer()!;
  expect(term).toBeDefined();
  return { root, term, dials };
}

function hostDials(dials: Dial[]): Dial[] {
  return dials.filter((d) => d.url.searchParams.get("session") === HOST_SESSION);
}

describe("a live terminal under a pane restructure", () => {
  test("keeps its renderer and its socket when its pane splits", async () => {
    const { root, term, dials } = await hostUnderTeam();
    expect(hostDials(dials).map((d) => d.url.searchParams.get("since"))).toEqual(["0"]);

    splitPane(SEED_PANE, "row");
    await settle();
    await vi.waitFor(() => expect(liveHostRenderer()).toBeDefined());

    expect({
      sameElement: hostTerminal() === root,
      sameRenderer: liveHostRenderer() === term,
      disposed: term.disposed,
      hostDialsSince: hostDials(dials).map((d) => d.url.searchParams.get("since")),
      pane: paneHolding(root),
    }).toEqual({ sameElement: true, sameRenderer: true, disposed: false, hostDialsSince: ["0"], pane: SEED_PANE });
  });

  test("keeps them when it moves to another pane, and sends that pane's size", async () => {
    const { root, term, dials } = await hostUnderTeam();
    const target = splitPane(SEED_PANE, "row")!;
    await settle();

    xterm.fit.size = { cols: 57, rows: 19 };
    moveTab(SEED_PANE, HOST, target);
    await settle();
    await vi.waitFor(() => expect(liveHostRenderer()).toBeDefined());

    expect({
      sameElement: hostTerminal() === root,
      sameRenderer: liveHostRenderer() === term,
      disposed: term.disposed,
      hostDialsSince: hostDials(dials).map((d) => d.url.searchParams.get("since")),
      pane: paneHolding(root),
    }).toEqual({ sameElement: true, sameRenderer: true, disposed: false, hostDialsSince: ["0"], pane: target });
    const [dial] = hostDials(dials);
    await vi.waitFor(() =>
      expect(dial!.sent).toContainEqual({ type: "resize", cols: 57, rows: 19 }),
    );
  });
});

/// Past the host-resume recovery's last delayed fit (250ms) and the trailing
/// fit (120ms), so a fit a focus change queued has run before a test moves on.
const RECOVERY_SETTLED = 400;

describe("a terminal the pane tree rebuilds", () => {
  test("opens its renderer inside the pane that holds it", async () => {
    const openedIn: Array<string | null> = [];
    const open = FakeTerminal.prototype.open;
    vi.spyOn(FakeTerminal.prototype, "open").mockImplementation(function (this: FakeTerminal, element: HTMLElement) {
      openedIn.push(element.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null);
      open.call(this, element);
    });
    resetLayout([terminalTab({ id: HOST })]);
    await settle();
    await vi.waitFor(() => expect(openedIn).toHaveLength(1));

    expect(openedIn).toEqual([SEED_PANE]);
  });

  test("keeps its renderer when the pane beside it closes, fits it and takes the keyboard back", async () => {
    const { root, term, dials } = await hostUnderTeam();
    const beside = splitPane(SEED_PANE, "row")!;
    await settle();
    // The host's pane is the focused one again, so closing the other pane
    // changes neither its focus nor its tab: only the rebuild can move it.
    setActivePane(SEED_PANE);
    await settle();
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
    xterm.fit.size = { cols: 90, rows: 30 };
    const focusesBefore = term.focusCount;

    await closePane(beside);
    await settle();

    const [dial] = hostDials(dials);
    await vi.waitFor(() =>
      expect(dial!.sent).toContainEqual({ type: "resize", cols: 90, rows: 30 }),
    );
    expect({
      sameElement: hostTerminal() === root,
      sameRenderer: liveHostRenderer() === term,
      hostDialsSince: hostDials(dials).map((d) => d.url.searchParams.get("since")),
      pane: paneHolding(root),
      refocused: term.focusCount > focusesBefore,
    }).toEqual({ sameElement: true, sameRenderer: true, hostDialsSince: ["0"], pane: SEED_PANE, refocused: true });
  });

  test("sends nothing and keeps the keyboard when another pane's tabs change", async () => {
    const { term, dials } = await hostUnderTeam();
    const other = splitPane(SEED_PANE, "row")!;
    await settle();
    setActivePane(SEED_PANE);
    await settle();
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
    const [dial] = hostDials(dials);
    const sentBefore = dial!.sent.length;
    const focusesBefore = term.focusCount;

    (layout.nodes[other] as LeafNode).tabs.push(fileTab({ id: "elsewhere", path: "README.md" }));
    await settle();
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));

    expect({
      sent: dial!.sent.slice(sentBefore).map((frame) => frame.type),
      refocused: term.focusCount > focusesBefore,
    }).toEqual({ sent: [], refocused: false });
  });

  test("is torn down and leaves its pane when its tab closes", async () => {
    const { term } = await hostUnderTeam();

    await closeTab(SEED_PANE, HOST, { force: true });
    await settle();

    expect({ disposed: term.disposed, element: hostTerminal() }).toEqual({ disposed: true, element: null });
  });
});
