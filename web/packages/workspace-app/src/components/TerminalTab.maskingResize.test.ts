// @vitest-environment jsdom
//
// With secret masking on, a change of the terminal's width reflows every
// wrapped line, so the masks must follow. A drag of a pane's edge changes the
// width on every frame. The app requests a visible-row scan at each change
// and a final rescan once the width stops changing. Ghostty bounds both
// requests to visible wrapped groups and scans them at the next frame.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { GhosttySecretMasker } from "../terminal/secretMaskingGhostty";
import {
  attach,
  installTerminalDom,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";

installTerminalDom();

const ownViewportScan = GhosttySecretMasker.prototype.scanViewport;

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.restoreAllMocks();
});

async function maskedTerminal() {
  for (const [name, size] of [["clientWidth", 640], ["clientHeight", 456]] as const) {
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)?.get;
    vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("terminal-host") ? size : (own?.call(this) ?? 0);
    });
  }
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: true }));
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return mounted;
}

describe("a width change with secret masking on", () => {
  test("sends the new grid to the PTY before scanning its visible masks", async () => {
    const { term } = await maskedTerminal();
    const socket = TerminalSocket.all.at(-1)!;
    socket.sent = [];
    const gridsAtScan: Array<Array<Record<string, unknown>>> = [];
    vi.spyOn(GhosttySecretMasker.prototype, "scanViewport").mockImplementation(function (this: GhosttySecretMasker) {
      gridsAtScan.push(sentFrames(socket).filter((frame) => frame.type === "resize"));
      return ownViewportScan.call(this);
    });

    term.resize(91, 24);

    expect(gridsAtScan).toEqual([[{ type: "resize", cols: 91, rows: 24 }]]);
    expect(sentFrames(socket).filter((frame) => frame.type === "resize")).toEqual([
      { type: "resize", cols: 91, rows: 24 },
    ]);
  });

  test("requests a final rescan once the width stops changing, not at each change", async () => {
    // scanViewport delegates to scanAll on Ghostty; count the app's final
    // request separately from that delegation.
    let inViewport = false;
    const finalScan = vi.fn();
    const ownAll = GhosttySecretMasker.prototype.scanAll;
    vi.spyOn(GhosttySecretMasker.prototype, "scanAll").mockImplementation(function (this: GhosttySecretMasker) {
      if (!inViewport) finalScan();
      return ownAll.call(this);
    });
    const ownViewport = GhosttySecretMasker.prototype.scanViewport;
    vi.spyOn(GhosttySecretMasker.prototype, "scanViewport").mockImplementation(function (this: GhosttySecretMasker) {
      inViewport = true;
      try {
        return ownViewport.call(this);
      } finally {
        inViewport = false;
      }
    });
    const { term } = await maskedTerminal();
    finalScan.mockClear();

    for (const cols of [81, 82, 83, 84, 85]) term.resize(cols, 24);

    expect(finalScan, "no final rescan while the width is changing").not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finalScan).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(finalScan).toHaveBeenCalledTimes(1);
  });

  test("rescans the rows on screen at each change", async () => {
    const onScreen: number[] = [];
    vi.spyOn(GhosttySecretMasker.prototype, "scanViewport").mockImplementation(function (this: GhosttySecretMasker) {
      onScreen.push(1);
      return ownViewportScan.call(this);
    });
    const { term } = await maskedTerminal();

    for (const cols of [81, 82, 83]) term.resize(cols, 24);

    expect(onScreen).toHaveLength(3);
  });
});
