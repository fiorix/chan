// @vitest-environment jsdom
//
// The output path's accounting and its stream cuts, on the real widget over
// a stand-in socket. A frame counts once toward the acknowledged position and
// the redial cursor whatever the terminal does while it handles the frame,
// and a session frame that reports lost bytes ends whatever sequence they
// left open before its notice and replay are written.

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

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { ghosttyLineText, mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";

const SESSION = "sess-output";
const LISTENER_FAILURE = "a change listener failed";
const NOTICE = "terminal replay missed 5 bytes";
// The head of the server's recovery suffix on the normal screen, sent after
// the replay: CAN, a cursor save and the alternate-screen exits. The mode
// resets the server sends after them are left out; no case here reads a
// mode.
const RECOVERY_SUFFIX = "\x18\x1b7\x1b[?1049;1047;47l";

installTerminalDom();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetTerminals();
  vi.useRealTimers();
  __testSetStandalonePreferences(null);
  vi.restoreAllMocks();
});

async function mounted(): Promise<{ tab: TerminalTabState; socket: TerminalSocket; term: Terminal }> {
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
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

/// A recovery on the live socket after the server dropped 5 bytes: its
/// session frame, the replay, the server's suffix and `ready`.
async function lossyRecovery(socket: TerminalSocket, replay: string): Promise<void> {
  await receive(socket, {
    type: "session", id: SESSION, generation: 1, seq: 100, missed_bytes: 5, replay_bytes: replay.length, ack_window: 8,
  });
  await output(socket, replay);
  await output(socket, RECOVERY_SUFFIX);
  await ready(socket);
}

describe("a loss inside an unfinished sequence", () => {
  test.each([
    ["an OSC string", "\x1b]0;a title the loss cut"],
    ["a DCS string", "\x1bP1$qa request the loss cut"],
    ["a control sequence", "\x1b[1;"],
    ["an APC string", "\x1b_Ga=q;cut"],
    ["an SOS string", "\x1bXcut"],
    ["a charset designation", "\x1b("],
  ])("ends %s before the notice and the replay", async (_name, open) => {
    const { socket, term } = await mounted();
    await attached(socket, { seq: 0, replay_bytes: 0 });
    await ready(socket);
    await output(socket, `old${open}`);

    await lossyRecovery(socket, "TAIL");

    expect(screen(term).slice(0, 3)).toEqual(["old", NOTICE, "TAIL"]);
  });

  test("ends it for the mouse filter too", async () => {
    __testSetStandalonePreferences(terminalPreferences({ mouse_capture: false }));
    const { socket, term } = await mounted();
    await attached(socket, { seq: 0, replay_bytes: 0 });
    await ready(socket);
    await output(socket, "old\x1b[?100");

    await lossyRecovery(socket, "0hNEW");

    expect(screen(term).slice(0, 3), "the replay's head is text, not the rest of the held enable").toEqual([
      "old", NOTICE, "0hNEW",
    ]);
  });

  test("ends it for the OSC 52 observer too", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      const { socket } = await mounted();
      await attached(socket, { seq: 0, replay_bytes: 0 });
      await ready(socket);
      // "aGVs" + "bG8=" is base64 for "hello".
      await output(socket, "\x1b]52;c;aGVs");

      await lossyRecovery(socket, "bG8=\x07TAIL");
      await output(socket, "\x1b]52;c;b2s=\x07");

      expect(writeText.mock.calls.map(([text]) => text), "only the copy made after the loss").toEqual(["ok"]);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("ends it for the status guard too", async () => {
    const { socket, term } = await mounted();
    await attached(socket, { seq: 0, replay_bytes: 0 });
    await ready(socket);
    await output(socket, "old\x1b]7501;a status body the loss cut");

    await lossyRecovery(socket, "TAIL");

    expect(screen(term).slice(0, 3), "the guard discards no replay").toEqual(["old", NOTICE, "TAIL"]);
  });

  test("ends it for the keyboard protocol observer too", async () => {
    const { tab, socket, term } = await mounted();
    await attached(socket, { seq: 0, replay_bytes: 0 });
    await ready(socket);
    // The head of a kitty keyboard push, whose final byte the loss took.
    await output(socket, "old\x1b[>1");

    await lossyRecovery(socket, "uTAIL");

    // The flags chan's key encoder reads: no program asked for the push.
    expect(tab.keyboardProtocol?.kitty.mainFlags ?? 0).toBe(0);
    expect(screen(term).slice(0, 3)).toEqual(["old", NOTICE, "uTAIL"]);
  });
});
