// @vitest-environment jsdom
//
// The cursor a reattach resumes from, and the scrollback snapshots a control
// terminal clears: its output carries the devserver token the desktop
// re-scrapes, so no snapshot of it may stay in localStorage. A TerminalTab
// is mounted on the real widget over a stand-in socket; the assertions read
// the snapshot cache, the URL each dial asks for and what the terminal shows.

import type { Terminal } from "@chan/ghostty-web-ng";
import { unmount } from "svelte";
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
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";
import { readTerminalSnapshot, writeTerminalSnapshot } from "../terminal/snapshotCache";
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
const startControl = ui.terminalControl;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  resetTerminals();
  vi.useRealTimers();
  __testSetStandalonePreferences(null);
  ui.terminalControl = startControl;
  localStorage.clear();
});

async function attached() {
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: SESSION, generation: 3, seq: 42 });
  // The server ends every attach's replay with `ready`.
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return mounted;
}

function leftover(): void {
  writeTerminalSnapshot(SESSION, { ansi: "old", generation: 1, lastSeq: 1, cols: 80, rows: 24, updatedAt: 1 });
}

function dialed(socket: TerminalSocket): { since: string | null; generation: string | null } {
  const query = new URL(socket.url, "http://chan.test").searchParams;
  return { since: query.get("since"), generation: query.get("generation") };
}

function screen(term: Terminal): string[] {
  return Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row) ?? "");
}

describe("a control terminal", () => {
  test("clears a snapshot left for its session when it attaches, and again when it goes", async () => {
    ui.terminalControl = true;
    leftover();
    const { component } = await attached();
    expect(readTerminalSnapshot(SESSION), "cleared on attach").toBeNull();

    leftover();
    unmount(component);
    expect(readTerminalSnapshot(SESSION), "cleared on teardown").toBeNull();
  });

  test("an ordinary terminal keeps its snapshot", async () => {
    ui.terminalControl = false;
    leftover();
    await attached();
    expect(readTerminalSnapshot(SESSION)).not.toBeNull();
  });
});

describe("resuming a reattach", () => {
  test("without a snapshot, asks for the whole ring", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    await mountGhosttyTerminal(TerminalTab, tab!);
    expect(dialed(TerminalSocket.all.at(-1)!)).toEqual({ since: "0", generation: null });
  });

  test("a dropped socket redials the same session from the live cursor", async () => {
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
