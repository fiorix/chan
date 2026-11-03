// @vitest-environment jsdom
//
// The window grid a tmux window asks tmux for is the panes' host grids folded
// over tmux's layout, and the ask follows the pane tree's area alone: the
// attach asks once, a change of the area asks once more with the fold the
// hosts settle to, and nothing else asks. A divider drag sends its pane resize
// and no window size, from the press until the layout tmux answers the release
// with, and that layout asks nothing back although it moves every pane's host
// and with them the fold. Hybrid Nav holds the ask too, since its terminals
// measure nothing while the draft shows, and the ask follows when it ends.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { api, sessionWindowId } from "./api/client";
import { setSocketFactory } from "./api/transport";
import { demoSocketFactory } from "./demo/socket";
import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { resetLayout, terminalTab } from "./__tests__/tabs";
import { xterm } from "./__tests__/xterm";
import { onWatchEvent } from "./state/store.svelte";
import { cancelPaneMode, enterPaneMode, layout, splitPane, type LeafNode } from "./state/tabs.svelte";
import type { TmuxLayoutNode, TmuxPaneRef, TmuxRequest } from "./state/tmux";
import { setTmuxLayout, tmuxWindowGrid } from "./state/tmuxWindowSize.svelte";

stubAppEnvironment();

/// Every ResizeObserver the app makes, with what it observes, so a test can
/// report a resize the way the browser does.
type Observer = { callback: ResizeObserverCallback; targets: Element[] };
const observers: Observer[] = [];
globalThis.ResizeObserver = class {
  record: Observer;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }
  observe(target: Element): void {
    this.record.targets.push(target);
  }
  unobserve(target: Element): void {
    this.record.targets = this.record.targets.filter((t) => t !== target);
  }
  disconnect(): void {
    this.record.targets = [];
  }
} as unknown as typeof ResizeObserver;

/// Tell every observer of an element `matches` that it resized.
function resized(matches: (target: Element) => boolean): void {
  for (const observer of observers) {
    if (observer.targets.some(matches)) observer.callback([], observer as unknown as ResizeObserver);
  }
}

const box = (width: number, height: number): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }) as DOMRect;

const PANES: Record<string, TmuxPaneRef> = {
  "pane-0": { connection: 1, pane: "%0" },
  "pane-1": { connection: 1, pane: "%1" },
};

const TREE: TmuxLayoutNode = {
  kind: "row",
  w: 120,
  h: 40,
  children: [
    { kind: "pane", session: "pane-0", w: 60, h: 40 },
    { kind: "pane", session: "pane-1", w: 59, h: 40 },
  ],
};

/// The demo transport's PTY stand-in answers every session as a plain shell.
/// A tmux pane session's frame names its pane, as the server's does, so the
/// tabs keep their tmux mark once their sockets open.
function tmuxPaneSockets(url: string): WebSocket {
  type Handler = ((event: { data: unknown }) => void) | null;
  const socket = demoSocketFactory(url) as unknown as { onmessage: Handler };
  const pane = PANES[new URL(url).searchParams.get("session") ?? ""];
  if (!pane) return socket as unknown as WebSocket;
  let handler: Handler = null;
  Object.defineProperty(socket, "onmessage", {
    configurable: true,
    get: () => handler,
    set: (next: Handler) => {
      handler =
        next &&
        ((event) => {
          if (typeof event.data === "string") {
            const frame = JSON.parse(event.data) as { type?: string };
            if (frame.type === "session") return next({ data: JSON.stringify({ ...frame, tmux_pane: pane }) });
          }
          next(event);
        });
    },
  });
  return socket as unknown as WebSocket;
}

const spyOnRequests = () => vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
const spyOnBox = (element: HTMLElement) => vi.spyOn(element, "getBoundingClientRect");

let target: HTMLElement;
let main: HTMLElement;
let areaBox: ReturnType<typeof spyOnBox>;
let request: ReturnType<typeof spyOnRequests>;

const requests = (): Array<[string, TmuxRequest]> => request.mock.calls as Array<[string, TmuxRequest]>;
const windowSizes = () => requests().filter(([, body]) => body.request === "window-size");

/// The panes' hosts moved and their renderers measured them again, as they
/// do after a divider moves or a layout lands; each host holds `cols` by
/// `rows`.
async function hostsMoved(cols: number, rows = 40): Promise<void> {
  xterm.fit.size = { cols, rows };
  resized((element) => element.classList.contains("terminal-host"));
  await vi.advanceTimersByTimeAsync(300);
}

/// A window resize: the pane tree's box and, in the same breath, the hosts
/// inside it, which settle to grids of their own. The grids are no quotient
/// of the box, so a size read from the box would differ from the fold.
async function resizedTo(width: number, height: number, hostCols: number, hostRows: number): Promise<void> {
  areaBox.mockReturnValue(box(width, height));
  resized((element) => element === main);
  await hostsMoved(hostCols, hostRows);
}

function divider(): HTMLElement {
  const element = target.querySelector<HTMLElement>(".split > .divider")!;
  vi.spyOn(element.parentElement!, "getBoundingClientRect").mockReturnValue(box(1000, 600));
  return element;
}

/// The layout tmux answers a drag's pane resize with: the left pane at `left`
/// of the row's 119 pane cells.
function tmuxAnswered(left: number): void {
  onWatchEvent({
    type: "window_command",
    window_id: sessionWindowId(),
    command: "tmux_layout",
    layout: {
      ...TREE,
      children: [
        { kind: "pane", session: "pane-0", w: left, h: 40 },
        { kind: "pane", session: "pane-1", w: 119 - left, h: 40 },
      ],
    },
  });
}

beforeEach(async () => {
  observers.splice(0);
  // Each host holds 60 by 40 cells, so the row of two panes and a divider
  // folds to 121 by 40; the 1210 by 800 box is the ask's trigger, not its
  // size.
  xterm.fit.size = { cols: 60, rows: 40 };
  target = await mountApp();
  setSocketFactory(tmuxPaneSockets);
  main = target.querySelector("main")!;
  areaBox = spyOnBox(main).mockReturnValue(box(1210, 800));
  request = spyOnRequests();
  vi.useFakeTimers();
  const left = resetLayout([terminalTab({ id: "t0", terminalSessionId: "pane-0", tmuxPane: PANES["pane-0"] })]);
  const rightId = splitPane(left.id, "row", "after")!;
  const right = layout.nodes[rightId] as LeafNode;
  right.tabs.push(terminalTab({ id: "t1", terminalSessionId: "pane-1", tmuxPane: PANES["pane-1"] }));
  right.activeTabId = "t1";
  setTmuxLayout(TREE);
  await settle();
  await vi.advanceTimersByTimeAsync(400);
  expect(windowSizes(), "the attach asks once for the hosts' fold").toEqual([
    ["pane-0", { request: "window-size", pane: "%0", cols: 121, rows: 40 }],
  ]);
  request.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  setTmuxLayout(null);
  xterm.fit.size = null;
  await settle();
  await unmountApp();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("a divider drag over a stable area sends its pane resize and no window size", async () => {
  const handle = divider();
  handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 }));
  await hostsMoved(70);
  window.dispatchEvent(new MouseEvent("mouseup"));
  await hostsMoved(84);
  tmuxAnswered(83);
  await settle();
  await hostsMoved(83);
  expect(requests()).toEqual([["pane-0", { request: "resize-pane", pane: "%0", axis: "width", cells: 83 }]]);
});

test("the layout tmux answers with moves the hosts' fold and asks for no window size", async () => {
  tmuxAnswered(80);
  await settle();
  await hostsMoved(80);
  expect(tmuxWindowGrid(), "the fold moved with the hosts").toEqual({ cols: 161, rows: 40 });
  expect(requests()).toEqual([]);
});

test("a change of the pane tree's area asks once, with the fold the hosts settle to", async () => {
  await resizedTo(1005, 509, 45, 20);
  expect(requests()).toEqual([["pane-0", { request: "window-size", pane: "%0", cols: 91, rows: 20 }]]);
});

test("an area change during a press waits for the release", async () => {
  const handle = divider();
  handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  await resizedTo(1005, 509, 45, 20);
  expect(windowSizes()).toEqual([]);
  window.dispatchEvent(new MouseEvent("mouseup"));
  await vi.advanceTimersByTimeAsync(300);
  expect(requests()).toEqual([["pane-0", { request: "window-size", pane: "%0", cols: 91, rows: 20 }]]);
});

test("an area change after a drag's request waits for the layout that answers it", async () => {
  const handle = divider();
  handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  await resizedTo(1005, 509, 45, 20);
  expect(windowSizes()).toEqual([]);
  tmuxAnswered(83);
  await settle();
  await vi.advanceTimersByTimeAsync(300);
  expect(requests()).toEqual([
    ["pane-0", { request: "resize-pane", pane: "%0", axis: "width", cells: 83 }],
    ["pane-0", { request: "window-size", pane: "%0", cols: 91, rows: 20 }],
  ]);
});

test("an area change during Hybrid Nav waits for it to end, and asks with the hosts measured then", async () => {
  enterPaneMode();
  await settle();
  await resizedTo(1005, 509, 45, 20);
  expect(windowSizes()).toEqual([]);
  cancelPaneMode();
  await settle();
  await vi.advanceTimersByTimeAsync(600);
  expect(windowSizes()).toEqual([["pane-0", { request: "window-size", pane: "%0", cols: 91, rows: 20 }]]);
});
