// Mounting TerminalTab in jsdom over a stand-in WebSocket. A file that
// declares the shared fixture in `./ghosttyTab` mounts it on the real widget
// over the vendored core. A terminal opened without the fixture fails its
// test (the guard in vitest.setup.ts).
// This module imports no component: a test file declares its mocks, imports
// TerminalTab itself and hands it to mountTerminal.

import type { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { mount, tick, unmount, type Component } from "svelte";
import { expect, vi } from "vitest";

import { __testResetSessionWrites } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { resetLayout } from "./tabs";

export { terminalTab } from "./tabs";

/// The terminal WebSocket, recording what the component sends. A socket is
/// open when made, unless `TerminalSocket.connecting` is set: then it stays
/// CONNECTING until open() or failDial().
export class TerminalSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static all: TerminalSocket[] = [];
  static connecting = false;

  readyState = TerminalSocket.connecting ? 0 : TerminalSocket.OPEN;
  holdClose = false;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    TerminalSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.holdClose) {
      this.readyState = 2;
      return;
    }
    this.finishClose();
  }
  /// Complete a close whose onclose callback the test held back.
  finishClose() {
    this.readyState = 3;
    this.onclose?.();
  }
  /// The dial succeeds.
  open() {
    this.readyState = TerminalSocket.OPEN;
    this.onopen?.();
  }
  /// The dial fails before the socket ever opens (connection refused).
  failDial() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/// The widget side of the shared fixture, registered by its backend factory
/// when a test file declares it. Kept behind this slot because `./ghosttyTab`
/// imports this module.
export type GhosttyFixture = {
  opened(within: Node): Promise<GhosttyTerminal>;
  reset(): void;
};

let ghostty: GhosttyFixture | null = null;

export function useGhosttyFixture(fixture: GhosttyFixture): void {
  ghostty = fixture;
}

/// Frames and their cancel; an immediate frame has run by the time it could
/// be cancelled, so it leaves the environment's cancel in place.
type Frames = { request: typeof requestAnimationFrame; cancel?: typeof cancelAnimationFrame };

const immediateFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;

const immediateFrames: Frames = { request: immediateFrame };

/// Frames that each run one task after they are requested, as in a browser,
/// never inside the call that asked: the widget's render loop requests its
/// next frame from inside each one, which an immediate frame would run
/// without end. The task comes from the setTimeout in place when the frames
/// are made. A default `vi.useFakeTimers()` installed after that fakes
/// `requestAnimationFrame` itself, so until `vi.useRealTimers()` frames run
/// on the fake clock, as its timers do.
export function taskFrames(): Required<Frames> {
  const nextTask = globalThis.setTimeout;
  const cancelTask = globalThis.clearTimeout;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  let last = 0;
  return {
    request: ((callback: FrameRequestCallback) => {
      const id = ++last;
      pending.set(
        id,
        nextTask(() => {
          pending.delete(id);
          callback(performance.now());
        }, 0),
      );
      return id;
    }) as typeof requestAnimationFrame,
    cancel: ((id: number) => {
      const task = pending.get(id);
      pending.delete(id);
      if (task !== undefined) cancelTask(task);
    }) as typeof cancelAnimationFrame,
  };
}

/// The frames `installTerminalDom` chose for this file.
let frames: Frames = immediateFrames;

function installFrames(): void {
  globalThis.requestAnimationFrame = frames.request;
  if (frames.cancel) globalThis.cancelAnimationFrame = frames.cancel;
}

/// Every ResizeObserver the component made, with its callback and targets.
export const resizeObservers: Array<{ callback: () => void; targets: Element[] }> = [];

/// The DOM a mounted TerminalTab reads: observers, sockets, frames, canvas,
/// font loading and media queries. Frames run at once, or one task later in
/// a file that declared the shared fixture; the fixture serves the widget's
/// canvases itself.
export function installTerminalDom(): void {
  globalThis.ResizeObserver = class {
    record: { callback: () => void; targets: Element[] };
    constructor(callback: () => void) {
      this.record = { callback, targets: [] };
      resizeObservers.push(this.record);
    }
    observe(target: Element) {
      this.record.targets.push(target);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.WebSocket = TerminalSocket as unknown as typeof WebSocket;
  frames = ghostty ? taskFrames() : immediateFrames;
  installFrames();
  HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];
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
}

export const TERMINAL_PANE = "terminal-test-pane";

/// Seat the tabs in a one-pane layout, the pane `mountTerminal` names, and
/// return the live (proxied) copies.
export function seatTerminals(tabs: TerminalTabState[]): TerminalTabState[] {
  return resetLayout(tabs, { id: TERMINAL_PANE }).tabs as TerminalTabState[];
}

const mounted: Array<Record<string, unknown>> = [];

/// Whether the file declared the shared widget fixture.
export function ghosttyFixtureDeclared(): boolean {
  return ghostty !== null;
}

/// Mount `TerminalTab` for a seated tab and wait for its widget and its
/// socket. Throws before mounting unless the file declared the shared
/// fixture; a test that reads the widget mounts it with
/// `mountGhosttyTerminal` in `./ghosttyTab`, which returns it.
export async function mountTerminal(
  TerminalTab: Component<any>,
  tab: TerminalTabState,
  props: { focused?: boolean; active?: boolean; side?: "a" | "b" } = {},
): Promise<{ target: HTMLElement; component: Record<string, unknown> }> {
  const fixture = ghostty;
  if (!fixture) {
    throw new Error('mountTerminal needs the shared fixture: vi.mock "../terminal/backend" with ghosttyBackendModule');
  }
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: {
      tab,
      paneId: TERMINAL_PANE,
      side: props.side ?? "a",
      active: props.active ?? true,
      focused: props.focused ?? true,
    },
  }) as Record<string, unknown>;
  mounted.push(component);
  await tick();
  await tick();
  // The widget dials only once it has loaded and opened, so its own wait
  // bounds the load, and the socket follows.
  await fixture.opened(target);
  await vi.waitFor(() => expect(TerminalSocket.all.length).toBeGreaterThan(0));
  return { target, component };
}

export function openSocket(): TerminalSocket {
  const socket = TerminalSocket.all.at(-1);
  if (!socket) throw new Error("expected a terminal websocket");
  socket.onopen?.();
  return socket;
}

/// Deliver a server control frame on the socket.
export async function receive(socket: TerminalSocket, frame: Record<string, unknown>): Promise<void> {
  await socket.onmessage?.({ data: JSON.stringify(frame) });
}

/// Open the socket and deliver the session prelude a fresh attach gets.
export async function attach(
  socket: TerminalSocket,
  prelude: Partial<{ id: string; seq: number; generation: number; missed_bytes: number; replay_bytes: number }> = {},
): Promise<void> {
  socket.onopen?.();
  await receive(socket, {
    type: "session",
    id: "sess-1",
    seq: 0,
    generation: 1,
    missed_bytes: 0,
    bytes_since_focus: 0,
    ...prelude,
  });
}

/// Whether the bytes written to a terminal clear this DEC private mode: some
/// `CSI ? ... l` sequence names it exactly. A set sequence (`h`) never
/// counts. Shared by the fresh-shell reset cases.
export function resetClearsMode(written: string, mode: number): boolean {
  return written.split("\x1b[?").slice(1).some((rest) => {
    const end = rest.search(/[^0-9;]/);
    if (end === -1 || rest[end] !== "l") return false;
    return rest.slice(0, end).split(";").includes(String(mode));
  });
}

/// Deliver PTY output on the socket, as an ArrayBuffer of this realm.
export async function output(socket: TerminalSocket, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set([...bytes]);
  await socket.onmessage?.({ data: buffer });
}

/// Frames the component sent on the socket, parsed.
export function sentFrames(socket: TerminalSocket): Array<Record<string, unknown>> {
  return socket.sent.flatMap((raw) => {
    try {
      return [JSON.parse(raw) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/// Open the tab's menu the way the tab strip does; returns its rows' labels.
export async function openTerminalMenu(tab: TerminalTabState): Promise<string[]> {
  openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
  await tick();
  await tick();
  return [...document.body.querySelectorAll(".mbtn-label")].map((el) => (el.textContent ?? "").trim());
}

/// Right-click in the terminal body, which opens the body menu; returns its
/// rows' labels.
export async function openBodyMenu(target: HTMLElement): Promise<string[]> {
  target
    .querySelector(".terminal-tab")!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await tick();
  await tick();
  return [...document.body.querySelectorAll(".mbtn-label")].map((el) => (el.textContent ?? "").trim());
}

/// The open menu's row with this label.
export function menuRow(label: string): HTMLButtonElement {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
    (b) => b.querySelector(".mbtn-label")?.textContent?.trim() === label,
  );
  if (!row) throw new Error(`no menu row ${label}`);
  return row;
}

export function resetTerminals(): void {
  closeTabMenu();
  for (const component of mounted.splice(0)) unmount(component);
  TerminalSocket.all.splice(0);
  TerminalSocket.connecting = false;
  ghostty?.reset();
  resizeObservers.splice(0);
  installFrames();
  document.body.innerHTML = "";
  seatTerminals([]);
  // Every attach schedules a session save. With no server standing in, the
  // save fails and backs off into retries, the second failure setting a
  // status. The store outlives the test, so end what it left armed before
  // the next test runs.
  __testResetSessionWrites();
}
