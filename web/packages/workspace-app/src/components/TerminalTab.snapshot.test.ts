// @vitest-environment jsdom
//
// The scrollback snapshot a terminal writes to localStorage when the page is
// hidden, so a reload resumes from it, and the cursor a reattach resumes
// from. A control terminal never writes a snapshot: its output carries the
// devserver token the desktop re-scrapes. A TerminalTab is mounted over the
// stand-in xterm and attached on its socket; the assertions read the
// snapshot cache, the URL each dial asks for and what reaches xterm.

import { unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { ui } from "../state/store.svelte";
import { readTerminalSnapshot, writeTerminalSnapshot } from "../terminal/snapshotCache";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-1";
const startControl = ui.terminalControl;

beforeEach(() => {
  localStorage.clear();
  xterm.serialized = "$ ls\r\nnotes\r\n";
});

afterEach(() => {
  resetTerminals();
  ui.terminalControl = startControl;
  localStorage.clear();
});

async function attached() {
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountTerminal(TerminalTab, tab!);
  await attach(TerminalSocket.all.at(-1)!, { id: SESSION, generation: 3, seq: 42 });
  return mounted;
}

function leftover(): void {
  writeTerminalSnapshot(SESSION, { ansi: "old", generation: 1, lastSeq: 1, cols: 80, rows: 24, updatedAt: 1 });
}

describe("hiding the page", () => {
  test("snapshots an ordinary terminal's screen at its cursor", async () => {
    ui.terminalControl = false;
    await attached();
    window.dispatchEvent(new Event("pagehide"));

    expect(readTerminalSnapshot(SESSION)).toMatchObject({
      ansi: "$ ls\r\nnotes\r\n",
      generation: 3,
      lastSeq: 42,
      cols: 80,
      rows: 24,
    });
  });

  test("writes no snapshot for a control terminal", async () => {
    ui.terminalControl = true;
    await attached();
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));

    expect(readTerminalSnapshot(SESSION)).toBeNull();
  });
});

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
  const SNAPSHOT = { ansi: "SNAPSHOT SCREEN", generation: 3, lastSeq: 42, cols: 80, rows: 24, updatedAt: 1 };

  function dialed(socket: TerminalSocket): { since: string | null; generation: string | null } {
    const query = new URL(socket.url, "http://chan.test").searchParams;
    return { since: query.get("since"), generation: query.get("generation") };
  }

  async function reattach() {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    return { term, socket: TerminalSocket.all.at(-1)! };
  }

  test("without a snapshot, asks for the whole ring", async () => {
    const { socket } = await reattach();
    expect(dialed(socket)).toEqual({ since: "0", generation: null });
  });

  test("with a snapshot at the live size, resumes from its cursor and generation", async () => {
    writeTerminalSnapshot(SESSION, SNAPSHOT);
    const { socket } = await reattach();
    expect(dialed(socket)).toEqual({ since: "42", generation: "3" });
  });

  test("a snapshot taken at another size is not used", async () => {
    writeTerminalSnapshot(SESSION, { ...SNAPSHOT, cols: 120 });
    const { socket } = await reattach();
    expect(dialed(socket)).toEqual({ since: "0", generation: null });
  });

  test("paints the snapshot when the server confirms its generation with nothing missed", async () => {
    writeTerminalSnapshot(SESSION, SNAPSHOT);
    const { term, socket } = await reattach();
    await attach(socket, { id: SESSION, generation: 3, seq: 42, missed_bytes: 0 });
    expect(term.written.join("")).toContain("SNAPSHOT SCREEN");
  });

  for (const [name, prelude] of [
    ["another generation", { generation: 4 }],
    ["missed bytes", { generation: 3, missed_bytes: 7 }],
  ] as const) {
    test(`drops the snapshot for a full replay on ${name}`, async () => {
      writeTerminalSnapshot(SESSION, SNAPSHOT);
      const { term, socket } = await reattach();
      await attach(socket, { id: SESSION, seq: 0, ...prelude });
      expect(term.written.join("")).not.toContain("SNAPSHOT SCREEN");
    });
  }

  test("a dropped socket redials the same session from the live cursor", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    await mountTerminal(TerminalTab, tab!);
    const first = TerminalSocket.all.at(-1)!;
    await attach(first, { id: SESSION, generation: 2, seq: 10 });
    await receive(first, { type: "ready", cols: 80, rows: 24 });
    // PTY output arrives as an ArrayBuffer of this realm.
    const output = new ArrayBuffer(5);
    new Uint8Array(output).set([...new TextEncoder().encode("hello")]);
    await first.onmessage?.({ data: output });

    first.close();
    await vi.waitFor(() => expect(TerminalSocket.all.length).toBe(2), { timeout: 3000 });
    const query = new URL(TerminalSocket.all[1]!.url, "http://chan.test").searchParams;
    expect(query.get("session")).toBe(SESSION);
    expect({ since: query.get("since"), generation: query.get("generation") }).toEqual({
      since: "15",
      generation: "2",
    });
  });
});
