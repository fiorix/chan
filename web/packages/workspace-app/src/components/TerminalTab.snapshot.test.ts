// @vitest-environment jsdom
//
// The cursor a reattach resumes from. A TerminalTab is mounted on the real
// widget over a stand-in socket; the assertions read the URL each dial asks
// for and what the terminal shows.

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
import { WS_RECONNECT_BACKOFF_MAX_MS } from "../api/transport";
import { ghosttyFixture, ghosttyLineText, mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-1";

// Every case runs on the fake clock: uninstalling it after teardown has
// put the file's frames back deletes requestAnimationFrame, which a case
// on the real clock after it would need.
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  resetTerminals();
  vi.useRealTimers();
  __testSetStandalonePreferences(null);
  localStorage.clear();
});

function dialed(socket: TerminalSocket): { since: string | null; generation: string | null } {
  const query = new URL(socket.url, "http://chan.test").searchParams;
  return { since: query.get("since"), generation: query.get("generation") };
}

function screen(term: Terminal): string[] {
  return Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row) ?? "");
}

describe("resuming a reattach", () => {
  test("with no live cursor, asks for the whole ring", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    await mountGhosttyTerminal(TerminalTab, tab!);
    expect(dialed(TerminalSocket.all.at(-1)!)).toEqual({ since: "0", generation: null });
  });

  // The ring's replay restores the screen, so a scrollback snapshot an
  // older build left in localStorage for the session, at the live size, is
  // neither dialed from nor painted.
  test("a snapshot an older build stored does not prime the terminal", async () => {
    localStorage.setItem(
      `chan:term-snapshot:${SESSION}`,
      JSON.stringify({ ansi: "SNAPSHOT SCREEN", generation: 3, lastSeq: 42, cols: 80, rows: 24, updatedAt: Date.now() }),
    );
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect({ cols: term.cols, rows: term.rows }, "the snapshot's size is the terminal's").toEqual({ cols: 80, rows: 24 });
    const socket = TerminalSocket.all.at(-1)!;
    expect.soft(dialed(socket), "the dial asks for the whole ring").toEqual({ since: "0", generation: null });

    // The session frame confirms the snapshot's generation with nothing
    // missed, the one answer a primed dial would paint the snapshot on.
    await attach(socket, { id: SESSION, generation: 3, seq: 42, missed_bytes: 0 });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });

    expect(screen(term).filter(Boolean), "nothing of the snapshot is painted").toEqual([]);
  });

  test("a dropped socket redials the same session from the live cursor", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    await mountGhosttyTerminal(TerminalTab, tab!);
    const first = TerminalSocket.all.at(-1)!;
    await attach(first, { id: SESSION, generation: 2, seq: 10 });
    await receive(first, { type: "ready", cols: 80, rows: 24 });
    await output(first, "hello");

    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    expect(TerminalSocket.all, "one redial after the close").toHaveLength(2);
    const query = new URL(TerminalSocket.all[1]!.url, "http://chan.test").searchParams;
    expect(query.get("session")).toBe(SESSION);
    expect({ since: query.get("since"), generation: query.get("generation") }).toEqual({
      since: "15",
      generation: "2",
    });
  });

  test("a dial that fails before its session frame leaves the next one on the live cursor", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    await mountGhosttyTerminal(TerminalTab, tab!);
    const first = TerminalSocket.all.at(-1)!;
    await attach(first, { id: SESSION, generation: 2, seq: 10 });
    await receive(first, { type: "ready", cols: 80, rows: 24 });
    await output(first, "hello");

    // A crash restart's window: the socket drops, and the redial is
    // refused before any server answers it.
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    TerminalSocket.all.at(-1)!.failDial();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);

    expect(TerminalSocket.all, "one redial after each close").toHaveLength(3);
    expect(ghosttyFixture.terminals, "the terminal that shows the screen").toHaveLength(1);
    expect(dialed(TerminalSocket.all[2]!)).toEqual({ since: "15", generation: "2" });
  });
});

// A socket that drops between a session frame and its `ready` has painted part
// of the replay, and the prelude's cursor already names the end of it.
describe("a replay the socket cuts short", () => {
  async function cutReplay(tail = "") {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const first = TerminalSocket.all.at(-1)!;
    await attach(first, { id: SESSION, generation: 3, seq: 60 });
    await output(first, `part of the replay${tail}`);
    first.close();
    return { tab: tab!, term, first };
  }

  async function redial(): Promise<TerminalSocket> {
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    expect(TerminalSocket.all, "one redial after the cut").toHaveLength(2);
    return TerminalSocket.all[1]!;
  }

  test("redials for the whole ring, not from its prelude's cursor", async () => {
    await cutReplay();

    const second = await redial();

    expect(dialed(second), "the redial asks for the ring from its oldest byte").toEqual({
      since: "0",
      generation: null,
    });
  });

  for (const [capture, tail] of [
    ["on", "\x1b[38;5"],
    ["off", "\x1b[?100"],
  ] as const) {
    test(`paints the redial's replay over a reset screen, from a cut inside a sequence, mouse capture ${capture}`, async () => {
      if (capture === "off") {
        __testSetStandalonePreferences(terminalPreferences({ mouse_capture: false }));
      }
      const { term } = await cutReplay(tail);
      expect(screen(term)[0], "the cut replay painted its part").toBe("part of the replay");
      const second = await redial();

      await attach(second, { id: SESSION, generation: 3, seq: 60, replay_bytes: 14 });
      await output(second, "the whole ring");

      expect(screen(term).filter(Boolean), "a reset screen, then the replay alone").toEqual(["the whole ring"]);
    });
  }
});
