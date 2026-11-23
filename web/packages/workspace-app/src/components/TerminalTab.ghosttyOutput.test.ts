// @vitest-environment jsdom
//
// The output path's accounting, on the real widget over a stand-in socket. A
// frame counts once toward the acknowledged position and the redial cursor
// whatever the terminal does while it handles the frame.

import type { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { ghosttyLineText } from "../__tests__/ghosttyTab";
import {
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
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";

const SESSION = "sess-output";
const LISTENER_FAILURE = "a change listener failed";

installTerminalDom();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetTerminals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mounted(): Promise<{ tab: TerminalTabState; socket: TerminalSocket; term: Terminal }> {
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const { term } = await mountTerminal<Terminal>(TerminalTab, tab!);
  return { tab: tab!, socket: TerminalSocket.all.at(-1)!, term };
}

/// Open the socket on a session frame that advertises a window of eight
/// bytes, so every frame reports its position at once.
async function attached(socket: TerminalSocket, prelude: { seq: number; replay_bytes: number }): Promise<void> {
  socket.onopen?.();
  await receive(socket, {
    type: "session", id: SESSION, generation: 1, missed_bytes: 0, bytes_since_focus: 0, ack_window: 8, ...prelude,
  });
}

async function ready(socket: TerminalSocket): Promise<void> {
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
}

/// The next write the widget makes throws from a change listener, after the
/// core has parsed it and the app's own listeners have run.
function failNextWrite(term: Terminal): void {
  let armed = true;
  term.onChange(() => {
    if (!armed) return;
    armed = false;
    throw new Error(LISTENER_FAILURE);
  });
}

function lastAck(socket: TerminalSocket): Record<string, unknown> | undefined {
  return sentFrames(socket).filter((frame) => frame.type === "ack").at(-1);
}

/// Drop the socket and return its redial, with the `since` it asked for.
async function redial(socket: TerminalSocket): Promise<{ next: TerminalSocket; since: string | null }> {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  const next = TerminalSocket.all.at(-1)!;
  return { next, since: new URL(next.url, "http://localhost").searchParams.get("since") };
}

function screen(term: Terminal): string[] {
  return Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row) ?? "");
}

describe("a frame the terminal throws on while handling it", () => {
  test("still counts when it is live output", async () => {
    const { socket, term } = await mounted();
    await attached(socket, { seq: 0, replay_bytes: 0 });
    await ready(socket);

    failNextWrite(term);
    await expect(output(socket, "AAAA"), "the failure leaves the socket handler").rejects.toThrow(LISTENER_FAILURE);
    await output(socket, "BBBBBB");

    expect(screen(term)[0], "the core parsed both frames").toBe("AAAABBBBBB");
    expect(lastAck(socket)).toEqual({ type: "ack", generation: 1, seq: 10 });
    expect((await redial(socket)).since).toBe("10");
  });

  test("still counts when it is replay", async () => {
    const { socket, term } = await mounted();
    await attached(socket, { seq: 4, replay_bytes: 4 });

    failNextWrite(term);
    await expect(output(socket, "AAAA"), "the failure leaves the socket handler").rejects.toThrow(LISTENER_FAILURE);
    await ready(socket);
    await output(socket, "BBBBBB");

    expect(screen(term)[0], "the core parsed both frames").toBe("AAAABBBBBB");
    expect(lastAck(socket)).toEqual({ type: "ack", generation: 1, seq: 10 });
    expect((await redial(socket)).since).toBe("10");
  });

  // The throw comes from the reset written before the frame, so the frame
  // never reaches the core. Nothing delivers it again: it still counts, as
  // the server counted it.
  test("still counts when the reset before a cut replay throws", async () => {
    const { socket, term } = await mounted();
    await attached(socket, { seq: 4, replay_bytes: 4 });
    await output(socket, "AAAA");
    const cut = await redial(socket);
    expect(cut.since, "a replay cut before ready asks for the whole ring").toBe("0");
    await attached(cut.next, { seq: 8, replay_bytes: 8 });

    failNextWrite(term);
    await expect(output(cut.next, "AAAABBBB"), "the failure leaves the socket handler").rejects.toThrow(LISTENER_FAILURE);
    await ready(cut.next);
    await output(cut.next, "CC");

    expect(lastAck(cut.next)).toEqual({ type: "ack", generation: 1, seq: 10 });
    expect((await redial(cut.next)).since).toBe("10");
  });
});
