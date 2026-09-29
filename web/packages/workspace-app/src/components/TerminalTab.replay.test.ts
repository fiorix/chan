// @vitest-environment jsdom

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, test, vi } from "vitest";

const models = vi.hoisted(() => [] as Terminal[]);
vi.mock("@xterm/xterm", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const { FakeTerminal } = await import("../__tests__/xterm");
  return {
    Terminal: class extends FakeTerminal {
      model: Terminal;
      constructor(options: Record<string, unknown>) {
        super(options);
        // Keep the component's DOM stand-in but parse every write in xterm,
        // including registered keyboard handlers and RIS's buffer reset.
        this.model = new Terminal({ allowProposedApi: true, cols: 80, rows: 3, scrollback: 100 });
        models.push(this.model);
        for (const method of ["registerCsiHandler", "registerEscHandler", "registerOscHandler"] as const) {
          Object.assign(this.parser, { [method]: this.model.parser[method].bind(this.model.parser) });
        }
      }
      write(data: string | Uint8Array, done?: () => void): void {
        this.writtenRaw.push(data);
        this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        this.model.write(data, done);
      }
      writeln(data: string): void {
        this.write(`${data}\r\n`);
      }
      dispose(): void {
        this.model.dispose();
        super.dispose();
      }
    },
  };
});
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MAX_MS } from "../api/transport";
import { attach, installTerminalDom, mountTerminal, output, receive, resetTerminals, seatTerminals, terminalTab, TerminalSocket } from "../__tests__/terminalTab";

installTerminalDom();
const SESSION = "replay-session";
const ALT = "\x1b[?1049h\x1b[2J\x1b[H";
const MODES = "\x1b[?1h\x1b[?2004h";
const READY = { type: "ready", cols: 80, rows: 3 };

async function drain(): Promise<void> {
  let done = false;
  models.at(-1)!.write("", () => { done = true; });
  await vi.advanceTimersByTimeAsync(20);
  expect(done, "xterm parsed every queued write").toBe(true);
}

function lines(): string[] {
  const buffer = models.at(-1)!.buffer.normal;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true));
}

async function cut() {
  vi.useFakeTimers();
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const mounted = await mountTerminal(TerminalTab, tab!);
  const first = TerminalSocket.all.at(-1)!;
  const history = "older 1\r\nolder 2\r\nolder 3\r\nolder 4\r\nprompt";
  await attach(first, { id: SESSION, generation: 3, seq: history.length, replay_bytes: history.length });
  await output(first, history);
  await receive(first, READY);
  await drain();
  first.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
  const second = TerminalSocket.all.at(-1)!;
  await attach(second, { id: SESSION, generation: 3, seq: 80, replay_bytes: 10 });
  await output(second, " partial");
  await drain();
  second.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
  return { ...mounted, tab: tab!, socket: TerminalSocket.all.at(-1)! };
}

afterEach(() => {
  resetTerminals();
  models.splice(0);
  vi.useRealTimers();
  localStorage.clear();
});

describe("a cut replay on the real parser", () => {
  test("an empty replay keeps normal scrollback through the alternate-screen prelude", async () => {
    const { socket } = await cut();
    const before = lines();
    expect(before).toContain("older 1");
    await attach(socket, { id: SESSION, generation: 3, seq: 80, replay_bytes: 0 });
    await output(socket, ALT);
    await output(socket, MODES);
    await receive(socket, READY);
    await drain();
    expect(lines(), "empty replay preserves every normal-buffer line").toEqual(before);
    expect(models.at(-1)!.buffer.active.type).toBe("alternate");
  });

  test("an absent replay count keeps history while an older server repeats its ring", async () => {
    const { socket, term } = await cut();
    const before = lines();
    const start = term.written.length;
    await attach(socket, { id: SESSION, generation: 3, seq: 80 });
    await output(socket, "\r\nretained ring");
    await output(socket, MODES);
    await receive(socket, READY);
    await drain();
    expect(lines().slice(0, before.length - 1), "older server preserves history").toEqual(before.slice(0, -1));
    expect(term.written.slice(start).join(""), "no reset without replay metadata").not.toContain("\x1bc");
  });

  test("a nonempty replay resets only when its first byte arrives", async () => {
    const { socket, term } = await cut();
    const before = lines();
    const start = term.written.length;
    await attach(socket, { id: SESSION, generation: 3, seq: 80, replay_bytes: 13 });
    await drain();
    expect(lines(), "session metadata alone preserves the screen").toEqual(before);
    await output(socket, "retained ring");
    await output(socket, MODES);
    await receive(socket, READY);
    await drain();
    expect(term.written.slice(start).join(""), "one reset before ring bytes, then modes").toBe(`\x1bcretained ring${MODES}`);
    expect(lines().filter(Boolean), "only the retained ring remains").toEqual(["retained ring"]);
  });

  test("a reset keeps the missed-byte notice above the retained ring", async () => {
    const { socket } = await cut();
    await attach(socket, { id: SESSION, generation: 3, seq: 80, replay_bytes: 13, missed_bytes: 4096 });
    await output(socket, "retained ring");
    await output(socket, MODES);
    await receive(socket, READY);
    await drain();
    expect(lines().join("\n"), "missed-byte notice survives the replay reset").toContain("terminal replay missed 4096 bytes");
    expect(lines().at(-1)).toBe("retained ring");
  });

  test("the reset parser restores negotiated keyboard modes before replay bytes", async () => {
    vi.useFakeTimers();
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    await mountTerminal(TerminalTab, tab!);
    // Protocol negotiation predates the ring that a redial can replay.
    models.at(-1)!.write("\x1b[>4;2m\x1b[>5u");
    await drain();
    const protocol = tab!.keyboardProtocol!;
    const before = JSON.parse(JSON.stringify(protocol));
    const first = TerminalSocket.all.at(-1)!;
    await attach(first, { id: SESSION, generation: 3, seq: 80, replay_bytes: 20 });
    await output(first, "\x1b[>1u partial");
    await drain();
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    const second = TerminalSocket.all.at(-1)!;
    await attach(second, { id: SESSION, generation: 3, seq: 80, replay_bytes: 13 });
    await output(second, "retained ring");
    await output(second, MODES);
    await receive(second, READY);
    await drain();
    expect(tab!.keyboardProtocol, "handlers retain their state object").toBe(protocol);
    expect(JSON.parse(JSON.stringify(protocol)), "negotiated modes survive parsing RIS").toEqual(before);
  });
});
