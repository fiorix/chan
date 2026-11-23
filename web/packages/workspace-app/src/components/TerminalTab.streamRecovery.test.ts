// @vitest-environment jsdom
//
// Same-socket stream recovery on the xterm backend: after the server reports
// a loss on the live socket, the client's cursor equals the frame's seq, a
// redial resumes from it with no repeated byte, a positive missed count
// prints exactly one line and zero stays silent, and an old server's lag
// error frame keeps today's harmless shape. The ghostty arm lives in
// `TerminalTab.ghosttySession.test.ts`; the suppressed-reply case reads the
// frames the component sends on the socket.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/xterm")).xtermStandInBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-stream";
const CPR = "\x1b[12;1R";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetTerminals();
});

async function reconnect(socket: TerminalSocket, id: string) {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  const next = TerminalSocket.all.at(-1)!;
  await attach(next, { id });
  return next;
}

function frames(socket: TerminalSocket, type: string): unknown[] {
  return sentFrames(socket)
    .filter((f) => f.type === type)
    .map((f) => f.data);
}

function dialSince(socket: TerminalSocket): string | null {
  return new URL(socket.url, "http://localhost").searchParams.get("since");
}

/// The missed-count lines the tab printed into the stand-in xterm.
function missedLines(term: { written: string[] }): string[] {
  return term.written.join("").split("\r\n").filter((line) => line.includes("terminal replay missed"));
}

describe("same-socket stream recovery on xterm", () => {
  test("an xterm view neither asks for an acknowledged stream nor reports one", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    expect(new URL(socket.url, "http://localhost").searchParams.has("ack")).toBe(false);
    await attach(socket, { id: SESSION });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, "A".repeat(4096));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames(socket, "ack")).toEqual([]);
  });

  test("cursor equals the frame seq, replay applies once, one missed line", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: SESSION });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    term.written.splice(0);
    await output(socket, "A".repeat(90));

    // The server reports a loss on the live socket: 5 bytes missed, 10
    // retained, the raw endpoint at 100.
    await receive(socket, {
      type: "session", id: SESSION, seq: 100, generation: 1, missed_bytes: 5, replay_bytes: 10,
    });
    await output(socket, "0123456789");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(missedLines(term)).toEqual(["terminal replay missed 5 bytes"]);
    expect(term.written.join("").split("0123456789").length - 1, "the replay bytes land once").toBe(1);

    // A redial resumes from the frame's seq, so the replay repeats no byte.
    const redialed = await reconnect(socket, SESSION);
    expect(dialSince(redialed), "the redial resumes from the server's endpoint").toBe("100");
    await receive(redialed, { type: "ready", cols: 80, rows: 24 });
    await output(redialed, "NEW");
    expect(term.written.join("").split("0123456789").length - 1, "no byte repeats after the redial").toBe(1);
    expect(missedLines(term), "no second missed line without a new loss").toEqual(["terminal replay missed 5 bytes"]);
  });

  test("zero loss stays silent and the cursor still equals the frame seq", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: SESSION });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    term.written.splice(0);

    await receive(socket, {
      type: "session", id: SESSION, seq: 40, generation: 1, missed_bytes: 0, replay_bytes: 0,
    });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(missedLines(term), "zero loss prints nothing").toEqual([]);

    const redialed = await reconnect(socket, SESSION);
    expect(dialSince(redialed), "the redial still resumes from the server's endpoint").toBe("40");
  });

  test("an old server's lag error line prints and leaves the cursor alone", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: SESSION });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    term.written.splice(0);
    await output(socket, "A".repeat(20));

    await receive(socket, { type: "error", message: "terminal output lagged; reconnect to replay retained scrollback" });
    expect(term.written.join(""), "the old lag line keeps today's shape").toContain(
      "terminal error: terminal output lagged; reconnect to replay retained scrollback",
    );

    const redialed = await reconnect(socket, SESSION);
    expect(dialSince(redialed), "the error moves no cursor").toBe("20");
  });

  test("a replayed device query stays local during same-socket recovery", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: SESSION });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    term.written.splice(0);
    term.replyDuringWrite = CPR;
    socket.sent.splice(0);

    await receive(socket, {
      type: "session", id: SESSION, seq: 100, generation: 1, missed_bytes: 5, replay_bytes: 4,
    });
    await output(socket, "\x1b[6n");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(frames(socket, "input"), "a replayed query is answered nowhere").toEqual([]);
  });

  test("a restart on the live socket answers the new shell's query", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: SESSION, generation: 1 });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, "\x1bc");
    term.replyDuringWrite = CPR;
    socket.sent.splice(0);

    await receive(socket, {
      type: "session", id: SESSION, seq: 4, generation: 2, missed_bytes: 0, replay_bytes: 4,
    });
    await output(socket, "\x1b[6n");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(frames(socket, "input"), "the terminal never parsed this shell's output").toEqual([CPR]);
  });
});
