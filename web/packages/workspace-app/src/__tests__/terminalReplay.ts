import { mount, tick, unmount, type Component } from "svelte";
import type { Terminal } from "@xterm/xterm";
import { vi } from "vitest";
import { FakeTerminal, installTerminalDom, seatTerminals, terminalTab, xterm } from "./terminalTab";

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
  async ready() {
    return until(`ready ${this.connection}`, () => {
      if (this.error) throw this.error;
      return this.deliveries.find((entry) => entry.type === "ready" && entry.processed);
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

type ParserTerminal = FakeTerminal & { model: Terminal; queued: number; completed: number };
export const parsers: ParserTerminal[] = [];

export async function parserTerminalModule() {
  HTMLCanvasElement.prototype.getContext = (() => ({ createLinearGradient: () => ({ addColorStop() {} }) })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  return {
    Terminal: class extends FakeTerminal {
      model: Terminal;
      queued = 0;
      completed = 0;
      constructor(options: Record<string, unknown>) {
        super(options);
        this.model = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, scrollback: 10_000 });
        parsers.push(this);
        Object.defineProperty(this, "buffer", { get: () => this.model.buffer });
        for (const method of ["registerCsiHandler", "registerEscHandler", "registerOscHandler"] as const) {
          Object.assign(this.parser, { [method]: this.model.parser[method].bind(this.model.parser) });
        }
        this.model.onData((data) => this.type(data));
      }
      write(data: string | Uint8Array, done?: () => void) {
        const write = ++this.queued;
        observations.push({ event: "write", write, bytes: bytes.from(data).toString("base64") });
        this.model.write(data, () => {
          done?.();
          this.completed++;
          observations.push({ event: "parsed", write });
          changed();
        });
      }
      writeln(data: string) { this.write(`${data}\r\n`); }
      resize(cols: number, rows: number) { super.resize(cols, rows); this.model.resize(cols, rows); }
      dispose() { this.model.dispose(); super.dispose(); }
    },
  };
}

export async function drainParser(label: string) {
  const terminal = parsers.at(-1);
  if (!terminal) throw new Error("no terminal parser");
  let drained = false;
  terminal.model.write("", () => { drained = true; changed(); });
  await until(`parser drain ${label}`, () => drained ? true : undefined);
  if (terminal.queued !== terminal.completed) throw new Error("buffer read before writes completed");
  return terminal;
}

export async function snapshot(label: string) {
  for (const socket of ReplaySocket.all) await socket.handled();
  const terminal = await drainParser(label);
  const read = (buffer: Terminal["buffer"]["normal"]) => ({
    rows: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true)),
    cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY,
  });
  const value = { event: "snapshot", label, queued: terminal.queued, completed: terminal.completed,
    active: terminal.model.buffer.active.type, normal: read(terminal.model.buffer.normal), alternate: read(terminal.model.buffer.alternate) };
  observations.push(value);
  return value;
}

export async function mountRealTerminal(component: Component<any>) {
  installTerminalDom();
  globalThis.WebSocket = ReplaySocket as unknown as typeof WebSocket;
  globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 16);
  globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => networkFetch(
    typeof input === "string" ? new URL(input, window.location.href).href : input, init,
  ));
  xterm.fit.size = { cols: 80, rows: 24 };
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: env.CHAN_REPLAY_SESSION! })]);
  const target = document.createElement("div");
  document.body.append(target);
  const instance = mount(component, { target, props: { tab, paneId: "terminal-test-pane", side: "a", active: true, focused: true } });
  await tick();
  let socket: ReplaySocket;
  try { socket = await ReplaySocket.dial(1); }
  catch (error) { await unmount(instance); target.remove(); throw error; }
  return { tab, socket, async close() {
    ReplaySocket.acknowledge = null;
    await unmount(instance);
    for (const peer of ReplaySocket.all) if (!peer.closed) peer.disconnect();
    await Promise.all(ReplaySocket.all.map((peer) => until(`closed ${peer.connection}`, () => peer.closed ? true : undefined)));
    target.remove();
    globalThis.fetch = networkFetch;
  } };
}

export function save(name: string, value: unknown) {
  writeFileSync(`${env.CHAN_REPLAY_OUT!}/${name}`, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
