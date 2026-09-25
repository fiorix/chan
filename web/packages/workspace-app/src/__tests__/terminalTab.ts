// Mounting TerminalTab in jsdom over a stand-in xterm and WebSocket. The
// xterm modules are replaced with the recorders in `./xterm`, re-exported
// here, so a test reads what the component configured and wrote, and drives
// the key handler it registered the way xterm would. This module imports no
// component: a test file mocks the xterm modules with those factories,
// imports TerminalTab itself and hands it to mountTerminal.

import { mount, tick, unmount, type Component } from "svelte";
import { expect, vi } from "vitest";

import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { xterm, type FakeTerminal } from "./xterm";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { resetLayout } from "./tabs";

export { terminalTab } from "./tabs";
export {
  FakeTerminal,
  fitAddonModule,
  searchAddonModule,
  serializeAddonModule,
  webglAddonModule,
  webLinksAddonModule,
  xterm,
  xtermModule,
} from "./xterm";

/// The terminal WebSocket, recording what the component sends. A socket is
/// open when made, unless `TerminalSocket.connecting` is set: then it stays
/// CONNECTING until open() or failDial().
export class TerminalSocket {
  static OPEN = 1;
  static all: TerminalSocket[] = [];
  static connecting = false;

  readyState = TerminalSocket.connecting ? 0 : TerminalSocket.OPEN;
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

const immediateFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;

/// Every ResizeObserver the component made, with its callback and targets.
export const resizeObservers: Array<{ callback: () => void; targets: Element[] }> = [];

/// The DOM a mounted TerminalTab reads: observers, sockets, frames, canvas,
/// font loading and media queries.
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
  globalThis.requestAnimationFrame = immediateFrame;
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

/// Mount `TerminalTab` for a seated tab and wait for its socket.
export async function mountTerminal(
  TerminalTab: Component<any>,
  tab: TerminalTabState,
  props: { focused?: boolean; active?: boolean; side?: "a" | "b" } = {},
): Promise<{ target: HTMLElement; component: Record<string, unknown>; term: FakeTerminal }> {
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
  await vi.waitFor(() => expect(TerminalSocket.all.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(xterm.terminals.length).toBeGreaterThan(0));
  return { target, component, term: xterm.terminals.at(-1)! };
}

export function openSocket(): TerminalSocket {
  const socket = TerminalSocket.all.at(-1);
  if (!socket) throw new Error("expected a terminal websocket");
  socket.onopen?.();
  return socket;
}

/// Hand `init` to the key handler the component registered with xterm, as
/// xterm does before it processes a key; returns the handler's answer (false
/// tells xterm to skip the key).
export function pressInTerminal(term: FakeTerminal, init: KeyboardEventInit): { event: KeyboardEvent; handled: boolean } {
  if (!term.keyHandler) throw new Error("no key handler registered");
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  return { event, handled: term.keyHandler(event) };
}

/// Deliver a server control frame on the socket.
export async function receive(socket: TerminalSocket, frame: Record<string, unknown>): Promise<void> {
  await socket.onmessage?.({ data: JSON.stringify(frame) });
}

/// Open the socket and deliver the session prelude a fresh attach gets.
export async function attach(
  socket: TerminalSocket,
  prelude: Partial<{ id: string; seq: number; generation: number; missed_bytes: number }> = {},
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
  xterm.terminals.splice(0);
  xterm.serializeCalls.splice(0);
  xterm.serialized = "";
  xterm.fit.calls = 0;
  xterm.fit.failure = null;
  xterm.fit.size = null;
  xterm.webgl.splice(0);
  xterm.webglThrows = false;
  xterm.linkHandlers.splice(0);
  xterm.textareaFocus = false;
  resizeObservers.splice(0);
  globalThis.requestAnimationFrame = immediateFrame;
  document.body.innerHTML = "";
  seatTerminals([]);
}
