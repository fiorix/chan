// @vitest-environment jsdom
//
// Hybrid Nav never unmounts a terminal: that would dispose its widget and drop
// the scrollback. While Hybrid Nav is on, the terminal stays mounted and is
// hidden from assistive tech, and when it ends the same terminal is active
// again. A terminal on a pane's hidden side is hidden the same way.
//
// Restructuring the panes keeps it too. A split or a tab move that rebuilt the
// terminal would dial its session for the whole retained history and replay
// bytes written at the old width into the new one, so the terminal keeps its
// renderer and its socket, is fitted to its new host, and sends that size.

import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { Terminal } from "@chan/ghostty-web-ng";
import { ghosttyFixture, openedGhostty } from "../__tests__/ghosttyTab";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { sessionWindowId } from "../api/client";
import { setSocketFactory } from "../api/transport";
import { demoSocketFactory } from "../demo/socket";
import { richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { onWatchEvent } from "../state/store.svelte";
import { resetSurveysForTest, showSurvey } from "../state/survey.svelte";
import { closeTeamDialog, openTeamDialog } from "../state/teamDialog.svelte";
import { terminalRelocations } from "../state/terminalDock.svelte";
import {
  bumpTabFocusPulse,
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
import { LAUNCHER_SHOWN_ATTR } from "../state/keyboardOwner.svelte";

stubAppEnvironment();

let dispose: MockInstance<Terminal["dispose"]>;

beforeEach(async () => {
  dispose = vi.spyOn(Terminal.prototype, "dispose");
  await mountApp();
});

afterEach(async () => {
  cancelPaneMode();
  vi.restoreAllMocks();
  await unmountApp();
  ghosttyFixture.terminals.splice(0);
  richPrompt.byTab = {};
  resetSurveysForTest();
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
    await openedGhostty(mounted);
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
function liveHostRenderer(): Terminal | undefined {
  const root = hostTerminal();
  return ghosttyFixture.terminals.find((t) => t.element?.isConnected && root?.contains(t.element));
}

// Size the host in the live widget's CSS-pixel cells.
function hostSize(root: HTMLElement, cols: number, rows: number): void {
  const host = root.querySelector<HTMLElement>(".terminal-host")!;
  const { width, height } = ghosttyFixture.terminals.find((term) => term.element === host)!.getMetrics()!;
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: cols * width },
    clientHeight: { configurable: true, value: rows * height },
  });
}

function paneHolding(el: HTMLElement): string | null {
  return el.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null;
}

/// The host terminal that ran `cs terminal team new`, live in the seed pane,
/// with an unpositioned team spawned over it and the host selected again.
/// Returns what survives or not: the host's element, its renderer and its
/// dials.
async function hostUnderTeam(): Promise<{ root: HTMLElement; term: Terminal; dials: Dial[] }> {
  const dials = recordDials();
  resetLayout([terminalTab({ id: HOST, title: "host", terminalSessionId: HOST_SESSION })]);
  await settle();
  await vi.waitFor(() => expect(hostTerminal()).not.toBeNull());
  await openedGhostty(hostTerminal()!);
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
      disposed: dispose.mock.instances.includes(term),
      hostDialsSince: hostDials(dials).map((d) => d.url.searchParams.get("since")),
      pane: paneHolding(root),
    }).toEqual({ sameElement: true, sameRenderer: true, disposed: false, hostDialsSince: ["0"], pane: SEED_PANE });
  });

  test("keeps them when it moves to another pane, and sends that pane's size", async () => {
    const { root, term, dials } = await hostUnderTeam();
    const target = splitPane(SEED_PANE, "row")!;
    await settle();

    hostSize(root, 57, 19);
    moveTab(SEED_PANE, HOST, target);
    await settle();
    await vi.waitFor(() => expect(liveHostRenderer()).toBeDefined());

    expect({
      sameElement: hostTerminal() === root,
      sameRenderer: liveHostRenderer() === term,
      disposed: dispose.mock.instances.includes(term),
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

/// The pane the layout lists a terminal tab in, by the tab's title.
function paneListing(title: string): string | null {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const tabs = [...node.tabs, ...(node.bTabs ?? [])];
    if (tabs.some((tab) => tab.kind === "terminal" && tab.title === title)) return node.id;
  }
  return null;
}

describe("a live terminal under a positioned team spawn", () => {
  test("keeps its renderer and its socket when the grid moves it to the free cell", async () => {
    const dials = recordDials();
    resetLayout([terminalTab({ id: HOST, title: "host", terminalSessionId: HOST_SESSION })]);
    await settle();
    await vi.waitFor(() => expect(liveHostRenderer()).toBeDefined());
    const root = hostTerminal()!;
    const term = liveHostRenderer()!;

    // Five members over a three-by-two grid leave one cell free, and the host
    // terminal is swapped into it.
    onWatchEvent({
      type: "window_command",
      window_id: sessionWindowId(),
      command: "team_spawned",
      group: "team-1",
      members: [
        { tab_name: "lead", session_id: "session-lead", position: { row: 0, col: 0 } },
        { tab_name: "w1", session_id: "session-w1", position: { row: 0, col: 1 } },
        { tab_name: "w2", session_id: "session-w2", position: { row: 1, col: 0 } },
        { tab_name: "w3", session_id: "session-w3", position: { row: 1, col: 1 } },
        { tab_name: "w4", session_id: "session-w4", position: { row: 2, col: 0 } },
      ],
    });
    await settle();
    await vi.waitFor(() => expect(paneListing("w4")).not.toBeNull());
    await vi.waitFor(() => expect(liveHostRenderer()).toBeDefined());

    const memberPanes = ["lead", "w1", "w2", "w3", "w4"].map(paneListing);
    expect({
      sameElement: hostTerminal() === root,
      sameRenderer: liveHostRenderer() === term,
      disposed: dispose.mock.instances.includes(term),
      hostDialsSince: hostDials(dials).map((d) => d.url.searchParams.get("since")),
      drawnWhereListed: paneHolding(root) === paneListing("host"),
      inAMemberCell: memberPanes.includes(paneHolding(root)),
    }).toEqual({
      sameElement: true,
      sameRenderer: true,
      disposed: false,
      hostDialsSince: ["0"],
      drawnWhereListed: true,
      inAMemberCell: false,
    });
  });
});

describe("a terminal the pane tree rebuilds", () => {
  test("opens its renderer inside the pane that holds it", async () => {
    const openedIn: Array<string | null> = [];
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: Terminal, element: HTMLElement) {
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
    hostSize(root, 90, 30);
    const focus = vi.spyOn(term, "focus");

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
      refocused: focus.mock.calls.length > 0,
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
    const focus = vi.spyOn(term, "focus");

    (layout.nodes[other] as LeafNode).tabs.push(fileTab({ id: "elsewhere", path: "README.md" }));
    await settle();
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));

    expect({
      sent: dial!.sent.slice(sentBefore).map((frame) => frame.type),
      refocused: focus.mock.calls.length > 0,
    }).toEqual({ sent: [], refocused: false });
  });

  test("is torn down and leaves its pane when its tab closes", async () => {
    const { term } = await hostUnderTeam();

    await closeTab(SEED_PANE, HOST, { force: true });
    await settle();

    expect({ disposed: dispose.mock.instances.includes(term), element: hostTerminal() }).toEqual({ disposed: true, element: null });
  });
});

describe("the keyboard after a relocation", () => {
  // Moving a terminal's element drops the keyboard in a browser, which jsdom
  // does not model, so these pins read which surface inside the terminal is
  // asked to take it back once the pane beside it closes and its own pane is
  // rebuilt, with its focus and its tab unchanged.
  async function focusedHostBesideEmptyPane() {
    const host = await hostUnderTeam();
    const beside = splitPane(SEED_PANE, "row")!;
    await settle();
    setActivePane(SEED_PANE);
    await settle();
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
    return { ...host, beside };
  }

  /// Every element asked to take focus from here on.
  function recordFocusRequests(): HTMLElement[] {
    const asked: HTMLElement[] = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      asked.push(this);
      focus.call(this, options);
    });
    return asked;
  }

  function lastAskedInside(asked: HTMLElement[], root: HTMLElement): HTMLElement | null {
    return asked.filter((el) => root.contains(el)).at(-1) ?? null;
  }

  async function openFind(root: HTMLElement): Promise<HTMLInputElement> {
    hostCommand("app.find.open");
    await settle();
    const find = await vi.waitFor(() => {
      const input = root.querySelector<HTMLInputElement>(".terminal-find input");
      expect(input).not.toBeNull();
      return input!;
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(find));
    return find;
  }

  test("goes back to the find input that held it", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    const find = await openFind(root);
    const asked = recordFocusRequests();

    await closePane(beside);
    await settle();

    await vi.waitFor(() => expect(lastAskedInside(asked, root)).toBe(find));
  });

  test("goes back to the terminal that held it with the find bar open", async () => {
    const { root, term, beside } = await focusedHostBesideEmptyPane();
    await openFind(root);
    term.focus();
    await vi.waitFor(() => expect(document.activeElement).toBe(term.element));
    const asked = recordFocusRequests();

    await closePane(beside);
    await settle();

    await vi.waitFor(() => expect(lastAskedInside(asked, root)).toBe(term.element));
  });

  test("goes back to the Rich Prompt composer that held it", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    const composer = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
      return el!;
    });
    const asked = recordFocusRequests();

    await closePane(beside);
    await settle();

    await vi.waitFor(() => expect(composer.contains(lastAskedInside(asked, root))).toBe(true));
  });

  // A survey over the terminal owns the keyboard, so the move asks nothing of
  // the composer that held it before the survey showed.
  test("leaves the composer alone while a survey over the terminal holds it", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    const composer = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
      return el!;
    });
    showSurvey({ surveyId: "survey-move", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] }, HOST);
    await settle();
    await vi.waitFor(() => {
      const card = root.querySelector<HTMLElement>(".survey-card");
      expect(card).not.toBeNull();
      expect(document.activeElement).toBe(card);
    });
    const moves = terminalRelocations(HOST);
    const asked = recordFocusRequests();

    await closePane(beside);
    await settle();
    await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));

    expect(asked.filter((el) => composer.contains(el)), "the composer is asked for no focus").toEqual([]);
    expect(composer.contains(document.activeElement), "the composer does not hold the keyboard").toBe(false);
  });

  // A survey over the terminal that moves gets the keyboard back after the
  // move, as the find bar, the composer and the terminal do.
  test("hands the keyboard back to the survey card after the move", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    const composer = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
      return el!;
    });
    showSurvey({ surveyId: "survey-move-back", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] }, HOST);
    await settle();
    await vi.waitFor(() => {
      const card = root.querySelector<HTMLElement>(".survey-card");
      expect(card).not.toBeNull();
      expect(document.activeElement).toBe(card);
    });
    const moves = terminalRelocations(HOST);
    await closePane(beside);
    await settle();
    await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
    expect(composer.contains(document.activeElement), "the composer does not take the keyboard").toBe(false);
    await vi.waitFor(() => {
      const el = document.activeElement;
      expect(el instanceof HTMLElement && !!el.closest(".survey-card"), "the card has the keyboard back").toBe(true);
    });
  });

  // A move under another owner yields like every other refocus: the move
  // hands the keyboard to nothing while the Team dialog holds it.
  test("hands the keyboard to nothing when it moves under the Team dialog", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    const composer = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
      return el!;
    });
    openTeamDialog({ leadTabId: HOST, leadPaneId: SEED_PANE });
    await settle();
    const asked: HTMLElement[] = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      asked.push(this);
      focus.call(this, options);
    });
    const moves = terminalRelocations(HOST);
    await closePane(beside);
    await settle();
    await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
    await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
    expect(asked.filter((el) => composer.contains(el)), "the composer is asked for no focus").toEqual([]);
    expect(composer.contains(document.activeElement), "the composer does not hold the keyboard").toBe(false);
    closeTeamDialog();
  });

  // With the keyboard at large under the Team dialog, the move hands it to
  // the dialog, the keyboard's owner, as the dialog's surface takes it.
  test("hands the keyboard to the Team dialog's field when it moves with the keyboard at large", async () => {
    const { beside } = await focusedHostBesideEmptyPane();
    openTeamDialog({ leadTabId: HOST, leadPaneId: SEED_PANE });
    try {
      const field = await vi.waitFor(() => {
        const el = document.querySelector<HTMLElement>('.team-dialog input[placeholder="Neo"]');
        expect(el).not.toBeNull();
        expect(document.activeElement).toBe(el);
        return el!;
      });
      field.blur();
      expect(document.activeElement, "the keyboard at large").toBe(document.body);
      const moves = terminalRelocations(HOST);
      await closePane(beside);
      await settle();
      await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
      await vi.waitFor(() => expect(document.activeElement, "the dialog's field").toBe(field));
    } finally {
      closeTeamDialog();
    }
  });

  // A move while the Team dialog holds the keyboard leaves it there: the
  // survey card over the terminal that moved is not the owner then, and the
  // dialog's field keeps the keyboard.
  test("hands the keyboard to nothing when it moves under the Team dialog with a survey up", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
    });
    showSurvey({ surveyId: "survey-move-dialog", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] }, HOST);
    await settle();
    const card = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".survey-card");
      expect(el).not.toBeNull();
      expect(document.activeElement).toBe(el);
      return el!;
    });
    openTeamDialog({ leadTabId: HOST, leadPaneId: SEED_PANE });
    const field = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.team-dialog input[placeholder="Neo"]');
      expect(el).not.toBeNull();
      expect(document.activeElement).toBe(el);
      return el!;
    });
    const cardFocus = vi.spyOn(card, "focus");
    try {
      const moves = terminalRelocations(HOST);
      await closePane(beside);
      await settle();
      await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
      await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
      expect(cardFocus, "the survey card is asked for no focus").not.toHaveBeenCalled();
      expect(document.activeElement, "the dialog keeps the keyboard").toBe(field);
    } finally {
      cardFocus.mockRestore();
      closeTeamDialog();
    }
  });

  test("hands the keyboard to nothing when it moves under the Computers launcher with a survey up", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
    });
    showSurvey({ surveyId: "survey-move-launcher", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] }, HOST);
    await settle();
    const card = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".survey-card");
      expect(el).not.toBeNull();
      expect(document.activeElement).toBe(el);
      return el!;
    });
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    await settle();
    const cardFocus = vi.spyOn(card, "focus");
    try {
      const moves = terminalRelocations(HOST);
      await closePane(beside);
      await settle();
      await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
      await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
      expect(cardFocus, "the survey card is asked for no focus").not.toHaveBeenCalled();
      expect(document.activeElement, "the move drops the keyboard and nothing restores it").toBe(document.body);
    } finally {
      cardFocus.mockRestore();
      document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    }
  });

  // The return after a move under the launcher: the move hands the keyboard
  // to nothing, and the next pulse after the launcher lets go restores the
  // composer that held it, so the return target survives the pane move. It
  // pins the end state, not either guard alone: the null check and the
  // composer's own guard each keep this case green by itself.
  test("hands the keyboard to nothing when it moves under the launcher, back on the next pulse", async () => {
    const { root, beside } = await focusedHostBesideEmptyPane();
    showRichPromptForTab(HOST);
    await settle();
    const composer = await vi.waitFor(() => {
      const el = root.querySelector<HTMLElement>(".rich-prompt");
      expect(el?.contains(document.activeElement)).toBe(true);
      return el!;
    });
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    await settle();
    const asked = recordFocusRequests();
    try {
      const moves = terminalRelocations(HOST);
      await closePane(beside);
      await settle();
      await vi.waitFor(() => expect(terminalRelocations(HOST), "the terminal moved").toBe(moves + 1));
      await new Promise((r) => setTimeout(r, RECOVERY_SETTLED));
      expect(asked.filter((el) => composer.contains(el)), "the composer is asked for no focus").toEqual([]);
      expect(composer.contains(document.activeElement), "the composer does not hold the keyboard").toBe(false);
    } finally {
      document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    }
    await settle();
    bumpTabFocusPulse();
    await settle();
    await vi.waitFor(() => expect(composer.contains(document.activeElement), "the pulse restores the composer").toBe(true));
  });
});
