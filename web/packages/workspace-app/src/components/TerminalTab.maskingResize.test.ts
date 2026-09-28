// @vitest-environment jsdom
//
// With secret masking on, a change of the terminal's width reflows every
// wrapped line, so the masks must follow. A drag of a pane's edge changes the
// width on every frame, and a whole-buffer rescan of a long scrollback takes
// a large part of a frame, so the rows on screen are rescanned at each change,
// which keeps a secret covered while the drag goes on, and the whole buffer
// once the width has stopped changing.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import type { Preferences } from "../api/types";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { TerminalSecretMasker } from "../terminal/secretMasking";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const proto = TerminalSecretMasker.prototype as unknown as Record<string, unknown>;
const ownViewportScan = proto.scanViewport;

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.restoreAllMocks();
  proto.scanViewport = ownViewportScan;
});

async function maskedTerminal() {
  __testSetStandalonePreferences({ terminal: { secret_masking: true } } as unknown as Preferences);
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return mounted;
}

describe("a width change with secret masking on", () => {
  test("rescans the whole buffer once the width stops changing, not at each change", async () => {
    const scanAll = vi.spyOn(TerminalSecretMasker.prototype, "scanAll");
    const { term } = await maskedTerminal();
    scanAll.mockClear();

    for (const cols of [81, 82, 83, 84, 85]) term.resize(cols, 24);

    expect(scanAll, "no whole-buffer rescan while the width is changing").not.toHaveBeenCalled();
    await vi.waitFor(() => expect(scanAll).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(scanAll).toHaveBeenCalledTimes(1);
  });

  test("rescans the rows on screen at each change", async () => {
    const onScreen: number[] = [];
    proto.scanViewport = function (this: unknown, ...args: unknown[]) {
      onScreen.push(1);
      return typeof ownViewportScan === "function" ? ownViewportScan.apply(this, args) : undefined;
    };
    const { term } = await maskedTerminal();

    for (const cols of [81, 82, 83]) term.resize(cols, 24);

    expect(onScreen).toHaveLength(3);
  });
});
