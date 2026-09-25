// @vitest-environment jsdom
//
// The scrollback snapshot a terminal writes to localStorage when the page is
// hidden, so a reload resumes from it. A control terminal never writes one:
// its output carries the devserver token the desktop re-scrapes. A
// TerminalTab is mounted over the stand-in xterm and attached on its socket;
// the assertions read the snapshot cache.

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
