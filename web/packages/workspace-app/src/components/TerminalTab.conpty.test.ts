// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { VtCells } from "@chan/ghostty-web-ng/vt";
import { tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as GhosttyTerminal[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  ...(await import("../__tests__/ghosttyTab")).ghosttyCompatStubs(),
}));

import TerminalTab from "./TerminalTab.svelte";
import { compileGhosttyCore, installSoftwareCanvas, mountGhostty } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom, output, receive, resetTerminals, seatTerminals, terminalTab,
  TerminalSocket, xterm, type FakeTerminal,
} from "../__tests__/terminalTab";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { __testSetStandalonePreferences } from "../state/store.svelte";

type SessionFrame = Record<string, unknown> & { type: "session"; id: string; generation: number };
type FixtureKind = "absent" | "known" | "unknown";
// The complete frames are copied from the Rust session serializer; only
// lifecycle fields are varied below when driving a replacement session.
const frames = JSON.parse(readFileSync("src/__tests__/fixtures/terminal-conpty-sessions.json", "utf8")) as Record<FixtureKind, SessionFrame>;
const olderFrame = JSON.parse(readFileSync("src/__tests__/fixtures/terminal-conpty-older-session.json", "utf8")) as SessionFrame;
const mounted = new Set<Record<string, unknown>>();
const cases = [
  { kind: "absent", pull: true, windowsPty: {}, clientPlatform: "Win32" },
  { kind: "known", pull: false, windowsPty: { backend: "conpty", buildNumber: 26300 }, clientPlatform: "Linux x86_64" },
  { kind: "unknown", pull: false, windowsPty: { backend: "conpty" }, clientPlatform: "Linux x86_64" },
] as const;

installTerminalDom();

beforeAll(async () => {
  expect(frames.absent).not.toHaveProperty("pty");
  expect(frames.absent).not.toHaveProperty("windows_build_number");
  expect(frames.known).toMatchObject({ pty: "conpty", windows_build_number: 26300 });
  expect(frames.unknown).toMatchObject({ pty: "conpty" });
  expect(frames.unknown).not.toHaveProperty("windows_build_number");
  for (const frame of Object.values(frames)) expect(frame.type).toBe("session");
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  vi.useFakeTimers();
  installSoftwareCanvas();
});

afterEach(async () => {
  for (const component of mounted) await unmount(component);
  mounted.clear();
  resetTerminals();
  ghostty.terminals.splice(0);
  __testSetStandalonePreferences(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(backend: "ghostty" | "xterm") {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: backend === "ghostty" }));
  const [tab] = seatTerminals([terminalTab()]);
  const opened = mountGhostty(TerminalTab, tab!, { active: false, focused: false });
  mounted.add(opened.component);
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(opened.socketCount + 1));
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  return { socket, tab: tab!, ghosttyTerm: ghostty.terminals.at(-1), xtermTerm: xterm.terminals.at(-1) };
}

async function reconnect(socket: TerminalSocket): Promise<TerminalSocket> {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  const next = TerminalSocket.all.at(-1)!;
  next.onopen?.();
  return next;
}

async function grid(socket: TerminalSocket, cols: number, rows: number): Promise<void> {
  await receive(socket, { type: "resize_other", cols, rows });
  await tick();
}

function screen(term: GhosttyTerminal): string[] {
  const core = term.wasmTerm!;
  const cells = new VtCells();
  return Array.from({ length: core.rows }, (_, row) => {
    expect(core.readRow(row, cells), `screen row ${row} is available`).toBe(true);
    let text = "";
    for (let col = 0; col < cells.length; col++) {
      const cell = cells.at(col)!;
      if (cell.width !== 0) text += cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ";
    }
    return text.trimEnd();
  });
}

async function assertGrowth(socket: TerminalSocket, term: GhosttyTerminal, pull: boolean, cols = 20, shortCols = 20) {
  await grid(socket, shortCols, 3);
  // RIS is a real replay reset: metadata must still govern the subsequent
  // resize after a server restarts or a partial replay is discarded.
  await output(socket, "\x1bcrow01\r\nrow02\r\nrow03\r\nrow04\r\nrow05\r\nrow06\r\nrow07\r\nrow08");
  expect(screen(term), "the real core holds three populated rows before growth").toEqual(["row06", "row07", "row08"]);
  expect(term.wasmTerm!.getScrollbackLength()).toBe(5);
  await grid(socket, cols, 5);
  expect([term.cols, term.rows], "the server resize reaches the mounted widget").toEqual([cols, 5]);
  expect(screen(term), "the PTY kind controls whether history enters the grown screen").toEqual(
    pull ? ["row04", "row05", "row06", "row07", "row08"] : ["row06", "row07", "row08", "", ""],
  );
  expect(term.wasmTerm!.getScrollbackLength(), "growth preserves every history row under ConPTY").toBe(pull ? 3 : 5);
  expect(term.wasmTerm!.getCursor().y, "the prompt cursor stays with its text").toBe(pull ? 4 : 2);
}

describe("Ghostty follows the server PTY rather than the client platform", () => {
  for (const shortCols of [20, 24]) {
    test.each(cases)(`$kind metadata controls the first replay resize from ${shortCols} to 20 columns`, async ({ kind, pull, clientPlatform }) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(clientPlatform);
      const { socket, ghosttyTerm } = await open("ghostty");
      await receive(socket, frames[kind]);
      // No ready frame: the first replay and its resize already need the rule.
      await assertGrowth(socket, ghosttyTerm!, pull, 20, shortCols);
    });
  }

  test.each(["same socket", "reconnect", "restart", "replacement"] as const)("replaces PTY metadata on every %s prelude", async (lifecycle) => {
    const opened = await open("ghostty");
    const term = opened.ghosttyTerm!;
    let socket = opened.socket;
    for (const [index, kind] of (["absent", "known", "unknown", "absent"] as const).entries()) {
      if (index > 0 && lifecycle === "reconnect") socket = await reconnect(socket);
      const frame = {
        ...frames[kind],
        ...(lifecycle === "restart" ? { generation: frames[kind].generation + index } : {}),
        ...(lifecycle === "replacement" ? { id: `${frames[kind].id}-${index}` } : {}),
      };
      await receive(socket, frame);
      await assertGrowth(socket, term, kind === "absent");
      await receive(socket, { type: "ready", cols: 20, rows: 5 });
    }
    expect(ghostty.terminals, "metadata updates retain the mounted widget").toEqual([term]);
  });

  test("a widget reset retains the current session's ConPTY resize rule", async () => {
    const { socket, ghosttyTerm } = await open("ghostty");
    const term = ghosttyTerm!;
    await receive(socket, frames.known);
    const core = term.wasmTerm;
    term.reset();
    expect(term.wasmTerm, "the reset creates another real parser").not.toBe(core);
    await assertGrowth(socket, term, false);
  });
});

function windowsPty(term: FakeTerminal): unknown {
  // xterm's default is {}, while the component may leave it unset on first attach.
  return term.options.windowsPty ?? {};
}

describe("xterm receives the server's Windows PTY options", () => {
  test("forwards a changed Windows build on the same socket", async () => {
    const { socket, xtermTerm } = await open("xterm");
    for (const frame of [frames.known, olderFrame, frames.known]) {
      // Keep the same session id while varying the captured server build.
      await receive(socket, { ...frame, id: frames.known.id });
      expect(windowsPty(xtermTerm!), `the session forwards Windows build ${frame.windows_build_number}`)
        .toEqual({ backend: "conpty", buildNumber: frame.windows_build_number });
    }
  });

  test.each(cases)("$kind metadata precedes replay and resize", async ({ kind, windowsPty: expected, clientPlatform }) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(clientPlatform);
    const { socket, xtermTerm } = await open("xterm");
    const term = xtermTerm!;
    expect(windowsPty(term), "no platform inference before a session frame").toEqual({});
    const atWrite: unknown[] = [];
    const originalWrite = term.write.bind(term);
    vi.spyOn(term, "write").mockImplementation((...args) => {
      atWrite.push(structuredClone(windowsPty(term)));
      originalWrite(...args);
    });
    await receive(socket, frames[kind]);
    await output(socket, "replay text");
    expect(atWrite.length, "the parser consumed replay").toBeGreaterThan(0);
    expect(atWrite, "the option is in place even for the session's first parser write").toEqual(atWrite.map(() => expected));
    const atResize: unknown[] = [];
    term.onResize(() => atResize.push(structuredClone(windowsPty(term))));
    await grid(socket, 91, 31);
    expect(atResize, "the option is in place at the first server resize").toEqual([expected]);
    expect(windowsPty(term)).toEqual(expected);
  });

  test.each(["same socket", "reconnect", "restart", "replacement"] as const)("replaces and clears options on every %s prelude", async (lifecycle) => {
    const opened = await open("xterm");
    const term = opened.xtermTerm!;
    let socket = opened.socket;
    for (const [index, kind] of (["absent", "known", "unknown", "absent"] as const).entries()) {
      if (index > 0 && lifecycle === "reconnect") socket = await reconnect(socket);
      const frame = {
        ...frames[kind],
        ...(lifecycle === "restart" ? { generation: frames[kind].generation + index } : {}),
        ...(lifecycle === "replacement" ? { id: `${frames[kind].id}-${index}` } : {}),
      };
      await receive(socket, frame);
      expect(windowsPty(term), `authoritative ${kind} metadata replaces the previous value`).toEqual(cases.find((entry) => entry.kind === kind)!.windowsPty);
      await receive(socket, { type: "ready", cols: 80, rows: 24 });
    }
    expect(xterm.terminals, "metadata updates retain the mounted xterm").toEqual([term]);
  });
});
