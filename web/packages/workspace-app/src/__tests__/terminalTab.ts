// Mounting TerminalTab in jsdom over a stand-in xterm and WebSocket. The
// xterm modules are replaced with recorders, so a test reads what the
// component configured and wrote, and drives the key handler it registered
// the way xterm would. This module imports no component: a test file mocks
// the xterm modules with the factories below, imports TerminalTab itself
// and hands it to mountTerminal.

import { mount, tick, unmount, type Component } from "svelte";
import { expect, vi } from "vitest";

import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { resetLayout } from "./tabs";

export { terminalTab } from "./tabs";

/// What the stand-in xterm recorded.
export const xterm = {
  terminals: [] as FakeTerminal[],
  /// The options each SerializeAddon.serialize call was given.
  serializeCalls: [] as unknown[],
  /// What SerializeAddon.serialize returns.
  serialized: "",
  fit: { calls: 0, failure: null as Error | null, size: null as { cols: number; rows: number } | null },
  /// Every WebglAddon made, with the context-loss handler it was given.
  webgl: [] as Array<{ loadedInto: FakeTerminal | null; onContextLoss: (() => void) | null; disposed: boolean }>,
  /// When set, constructing a WebglAddon throws, as it does without WebGL.
  webglThrows: false,
  /// The link handler each WebLinksAddon was given.
  linkHandlers: [] as Array<(event: MouseEvent, uri: string) => void>,
  /// When set, each terminal opens a textarea in its host and focus() and
  /// blur() move DOM focus to and from it, as xterm's own textarea does.
  textareaFocus: false,
};

type CsiId = { prefix?: string; intermediates?: string; final: string };

export class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  element: HTMLElement | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  dataHandlers: Array<(data: string) => void> = [];
  resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
  written: string[] = [];
  /// What each write was handed, before decoding.
  writtenRaw: unknown[] = [];
  refreshCalls: Array<[number, number]> = [];
  pasted: string[] = [];
  selection = "";
  focusCount = 0;
  blurCount = 0;
  disposed = false;
  /// The textarea open() made when `xterm.textareaFocus` is set.
  textarea: HTMLTextAreaElement | null = null;
  /// When set, the next writes answer with this reply the way xterm answers
  /// a query in the output it parses: during the write.
  replyDuringWrite: string | null = null;
  /// The escape-sequence handlers the component registered with xterm's parser.
  parser = {
    osc: new Map<number, (data: string) => boolean>(),
    csi: [] as Array<{ id: CsiId; handler: (params: Array<number | number[]>) => boolean }>,
    registerOscHandler: (ident: number, handler: (data: string) => boolean) => {
      this.parser.osc.set(ident, handler);
      return { dispose() {} };
    },
    registerCsiHandler: (id: CsiId, handler: (params: Array<number | number[]>) => boolean) => {
      this.parser.csi.push({ id, handler });
      return { dispose() {} };
    },
    registerEscHandler: () => ({ dispose() {} }),
  };

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    xterm.terminals.push(this);
  }

  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }): void {
    addon.activate?.(this);
  }
  open(element: HTMLElement): void {
    this.element = element;
    if (xterm.textareaFocus) {
      this.textarea = document.createElement("textarea");
      element.append(this.textarea);
    }
  }
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  attachCustomWheelEventHandler(): void {}
  onData(handler: (data: string) => void): { dispose(): void } {
    this.dataHandlers.push(handler);
    return { dispose() {} };
  }
  onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    this.resizeHandlers.push(handler);
    return { dispose() {} };
  }
  write(data: string | Uint8Array, done?: () => void): void {
    this.writtenRaw.push(data);
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    if (this.replyDuringWrite !== null) this.type(this.replyDuringWrite);
    done?.();
  }
  /// Emit data from xterm, as typing or a generated reply does.
  type(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }
  /// Run the CSI handler registered for this prefix and final, as xterm's
  /// parser does when the program writes the sequence.
  csi(prefix: string, final: string, params: Array<number | number[]>): boolean {
    const entry = this.parser.csi.find((c) => c.id.prefix === prefix && c.id.final === final);
    if (!entry) throw new Error(`no CSI handler for ${prefix}${final}`);
    return entry.handler(params);
  }
  writeln(data: string): void {
    this.written.push(`${data}\r\n`);
  }
  paste(data: string): void {
    this.pasted.push(data);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  refresh(start: number, end: number): void {
    this.refreshCalls.push([start, end]);
  }
  getSelection(): string {
    return this.selection;
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
  focus(): void {
    this.focusCount += 1;
    this.textarea?.focus();
  }
  blur(): void {
    this.blurCount += 1;
    this.textarea?.blur();
  }
  dispose(): void {
    this.disposed = true;
    this.textarea?.remove();
    this.textarea = null;
  }
}

export function xtermModule() {
  return { Terminal: FakeTerminal };
}

export function fitAddonModule() {
  return {
    FitAddon: class {
      terminal: FakeTerminal | null = null;
      activate(terminal: FakeTerminal) {
        this.terminal = terminal;
      }
      fit() {
        xterm.fit.calls += 1;
        if (xterm.fit.failure) throw xterm.fit.failure;
        if (xterm.fit.size && this.terminal) {
          this.terminal.cols = xterm.fit.size.cols;
          this.terminal.rows = xterm.fit.size.rows;
        }
      }
    },
  };
}

export function searchAddonModule() {
  return {
    SearchAddon: class {
      findNext() {}
      findPrevious() {}
    },
  };
}

export function serializeAddonModule() {
  return {
    SerializeAddon: class {
      serialize(options?: unknown) {
        xterm.serializeCalls.push(options);
        return xterm.serialized;
      }
    },
  };
}

export function webLinksAddonModule() {
  return {
    WebLinksAddon: class {
      constructor(handler: (event: MouseEvent, uri: string) => void) {
        xterm.linkHandlers.push(handler);
      }
    },
  };
}

export function webglAddonModule() {
  return {
    WebglAddon: class {
      record = { loadedInto: null as FakeTerminal | null, onContextLoss: null as (() => void) | null, disposed: false };
      constructor() {
        if (xterm.webglThrows) throw new Error("WebGL2 not supported");
        xterm.webgl.push(this.record);
      }
      activate(terminal: FakeTerminal) {
        this.record.loadedInto = terminal;
      }
      onContextLoss(handler: () => void) {
        this.record.onContextLoss = handler;
        return { dispose() {} };
      }
      dispose() {
        this.record.disposed = true;
      }
    },
  };
}

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
