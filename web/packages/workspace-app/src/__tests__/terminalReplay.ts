// The replay check's page: TerminalTab on the real widget and vendored core
// (the shared fixture in ./ghosttyTab, which the case file declares), over
// real WebSockets to a throwaway server behind the cutting proxy.

import type { Terminal } from "@chan/ghostty-web-ng";
import { mount, tick, unmount, type Component } from "svelte";
import { vi } from "vitest";
import { ghosttyAlternateScreen, ghosttyFixture, seatedGhostty } from "./ghosttyTab";
import { installTerminalDom, seatTerminals, terminalTab } from "./terminalTab";

type ByteBuffer = Uint8Array & { toString(encoding?: string): string };
type Network = { readyState: number; on(event: string, handler: (...args: any[]) => void): void; send(data: string): void; close(): void; terminate(): void };
// Keep the Node-only surface local; the web workspace has no Node type dependency.
const { env } = await vi.importActual<{ env: Record<string, string | undefined> }>("node:process");
export const caseName = env.CHAN_REPLAY_CASE;
export const requiredSubcases: string[] = JSON.parse(env.CHAN_REPLAY_REQUIRED_SUBCASES ?? "[]");
const { createRequire } = await vi.importActual<{ createRequire(path: string): (name: string) => new (url: string) => Network }>("node:module");
const { writeFileSync } = await vi.importActual<{ writeFileSync(path: string, data: string, options: { flag: string }): void }>("node:fs");
export const { Buffer: bytes } = await vi.importActual<{ Buffer: {
  from(data: string | Uint8Array, encoding?: string): ByteBuffer;
  concat(data: Uint8Array[]): ByteBuffer;
} }>("node:buffer");
const NetworkSocket = createRequire(env.CHAN_REPLAY_WS_PACKAGE!)("ws");
const networkFetch = globalThis.fetch;
const deadline = 20_000;
export const observations: Array<Record<string, unknown>> = [];
const listeners = new Set<() => void>();
function changed() { for (const listener of listeners) listener(); }

export function until<T>(label: string, read: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`event deadline: ${label}`)); }, deadline);
    function check() {
      try {
        const value = read();
        if (value === undefined) return;
        clearTimeout(timeout);
        listeners.delete(check);
        resolve(value);
      } catch (error) {
        clearTimeout(timeout);
        listeners.delete(check);
        reject(error);
      }
    }
    listeners.add(check);
    check();
  });
}

export async function rpc(op: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await networkFetch(env.CHAN_REPLAY_CONTROL!, {
    method: "POST", headers: { authorization: `Bearer ${env.CHAN_REPLAY_CONTROL_TOKEN}`, connection: "close" },
    body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(deadline + 1000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`controller ${op}: ${result.error}`);
  return result;
}

export const emit = (op: string, args: Record<string, unknown> = {}) => rpc("fixture", { op, args });

export type Delivery = { connection: number; frame: number; binary: boolean; bytes: string; type: string | null; processed: boolean };
export class ReplaySocket {
  static OPEN = 1;
  static all: ReplaySocket[] = [];
  static acknowledge: ((message: Delivery) => Promise<void>) | null = null;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly connection: number;
  readonly network: Network;
  deliveries: Delivery[] = [];
  pending = new Set<Promise<void>>();
  error: unknown;
  closed = false;

  constructor(url: string) {
    this.connection = ReplaySocket.all.length + 1;
    ReplaySocket.all.push(this);
    const parsed = new URL(url);
    observations.push({ event: "dial", connection: this.connection,
      query: Object.fromEntries(["session", "since", "generation", "cols", "rows"].flatMap((key) => parsed.searchParams.has(key) ? [[key, parsed.searchParams.get(key)]] : [])) });
    this.network = new NetworkSocket(url);
    this.network.on("open", () => { this.onopen?.(); changed(); });
    this.network.on("message", (raw: Uint8Array, binary: boolean) => {
      const payload = bytes.from(raw);
      const delivery = { connection: this.connection, frame: this.deliveries.length + 1,
        binary, bytes: payload.toString("base64"), type: binary ? null : JSON.parse(payload.toString()).type, processed: false };
      this.deliveries.push(delivery);
      observations.push({ event: "received", ...delivery });
      // Copy into jsdom's realm: the page distinguishes ArrayBuffer from text.
      const buffer = new ArrayBuffer(payload.length);
      new Uint8Array(buffer).set(payload);
      const handler = this.onmessage;
      if (!handler) {
        observations.push({ event: "unhandled", connection: this.connection, frame: delivery.frame });
        changed();
        return;
      }
      const handled = Promise.resolve(handler({ data: binary ? buffer : payload.toString() })).then(async () => {
        delivery.processed = true;
        observations.push({ event: "processed", ...delivery });
        changed();
        await ReplaySocket.acknowledge?.(delivery);
      }).catch((error) => { this.error = error; changed(); });
      this.pending.add(handled);
      void handled.finally(() => this.pending.delete(handled));
      changed();
    });
    this.network.on("close", (code: number, reason: ByteBuffer) => {
      this.closed = true;
      this.onclose?.({ code, reason: reason.toString() });
      observations.push({ event: "closed", connection: this.connection, code });
      changed();
    });
    this.network.on("error", () => { this.onerror?.(); changed(); });
    changed();
  }
  get readyState() { return this.network.readyState; }
  send(data: string) { this.network.send(data); }
  close() { this.network.close(); }
  disconnect() { this.network.terminate(); }
  static dial(number: number): Promise<ReplaySocket> { return until(`dial ${number}`, () => ReplaySocket.all[number - 1]); }
  async ready(ordinal = 1) {
    return until(`ready ${this.connection}/${ordinal}`, () => {
      if (this.error) throw this.error;
      return this.deliveries.filter((entry) => entry.type === "ready" && entry.processed)[ordinal - 1];
    });
  }
  async bytesInclude(text: string) {
    await until(`processed marker ${text}`, () => {
      if (this.error) throw this.error;
      const stream = bytes.concat(this.deliveries.filter((entry) => entry.binary && entry.processed).map((entry) => bytes.from(entry.bytes, "base64")));
      return stream.toString().includes(text) ? true : undefined;
    });
  }
  async handled() {
    await Promise.all([...this.pending]);
    if (this.error) throw this.error;
  }
}

/// The showing screen as the core reads it: every row, history first on the
/// normal screen, and the cursor. `baseY` is the history length.
export type Screen = { rows: string[]; cursorX: number; cursorY: number; baseY: number };

/// A snapshot holds the screen that showed when it was taken. The core reads
/// only that screen, so reading the other one throws rather than comparing
/// two absent screens as equal.
export type Reading = { readonly active: "normal" | "alternate"; readonly normal: Screen; readonly alternate: Screen };

function readScreen(term: Terminal, label: string): Screen {
  const buffer = term.buffer.active;
  const rows = Array.from({ length: buffer.length }, (_, index) => {
    const line = buffer.getLine(index);
    if (!line) throw new Error(`${label}: row ${index} of ${buffer.length} did not read`);
    return line.translateToString(true);
  });
  const cursor = term.getCursor();
  if (!cursor) throw new Error(`${label}: the terminal is not open`);
  return { rows, cursorX: cursor.x, cursorY: cursor.y, baseY: term.getScrollbackLength() };
}

/// Read the terminal once every delivery the page received is processed.
/// The widget parses a write before the write returns, so a processed
/// delivery is a parsed one and nothing is left to drain.
export async function snapshot(label: string): Promise<Reading> {
  for (const socket of ReplaySocket.all) await socket.handled();
  const term = ghosttyFixture.terminals.at(-1);
  if (!term) throw new Error(`${label}: no terminal opened`);
  const active = ghosttyAlternateScreen(term) ? "alternate" : "normal";
  const screen = readScreen(term, label);
  observations.push({ event: "snapshot", label, active, [active]: screen });
  const shown = (name: "normal" | "alternate"): Screen => {
    if (name !== active) throw new Error(`${label}: the ${name} screen is not showing, and the core reads only the screen that shows`);
    return screen;
  };
  return {
    active,
    get normal() { return shown("normal"); },
    get alternate() { return shown("alternate"); },
  };
}

export async function mountRealTerminal(component: Component<any>) {
  installTerminalDom();
  globalThis.WebSocket = ReplaySocket as unknown as typeof WebSocket;
  globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 16);
  globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => networkFetch(
    typeof input === "string" ? new URL(input, window.location.href).href : input, init,
  ));
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: env.CHAN_REPLAY_SESSION! })]);
  const target = document.createElement("div");
  document.body.append(target);
  let instance: Record<string, unknown>;
  /// Mount the tab and wait for its widget and the dial it makes.
  async function opened() {
    const ordinal = ReplaySocket.all.length + 1;
    instance = mount(component, { target, props: { tab, paneId: "terminal-test-pane", side: "a", active: true, focused: true } });
    await tick();
    try {
      // The widget dials once it has opened. jsdom lays out no host for the
      // tab to fit, so the widget keeps its 80 by 24 grid, the fixture PTY's.
      const term = await seatedGhostty(target);
      if (term.cols !== 80 || term.rows !== 24) throw new Error(`the terminal opened at ${term.cols} by ${term.rows}, not 80 by 24`);
      return { term, socket: await ReplaySocket.dial(ordinal) };
    } catch (error) { await unmount(instance); target.remove(); throw error; }
  }
  const mounted = { tab, ...(await opened()),
    /// The page reloads: the tab's component goes and a new one opens on the
    /// same tab, which keeps its session and negotiated keyboard protocol, so
    /// its widget is new and its first dial asks for the whole ring. Returns
    /// once that dial is made; `term` and `socket` are the new widget's.
    async remount() {
      await unmount(instance);
      Object.assign(mounted, await opened());
    },
    async close() {
      ReplaySocket.acknowledge = null;
      await unmount(instance);
      for (const peer of ReplaySocket.all) if (!peer.closed) peer.disconnect();
      await Promise.all(ReplaySocket.all.map((peer) => until(`closed ${peer.connection}`, () => peer.closed ? true : undefined)));
      target.remove();
      globalThis.fetch = networkFetch;
    } };
  return mounted;
}

export function save(name: string, value: unknown) {
  writeFileSync(`${env.CHAN_REPLAY_OUT!}/${name}`, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
