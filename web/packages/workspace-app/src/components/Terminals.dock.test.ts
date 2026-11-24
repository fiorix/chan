// @vitest-environment jsdom
//
// A terminal mounts only once it is docked in the pane that holds it. Until a
// pane draws the layer it docks into, Terminals builds no renderer and dials
// nothing for it, so no session is spawned or attached for a terminal no pane
// shows, and a terminal's mount-time work runs where the terminal is drawn.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import Pane from "./Pane.svelte";
import Terminals from "./Terminals.svelte";
import {
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  TERMINAL_PANE,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { layout, type LeafNode } from "../state/tabs.svelte";

import { ghosttyFixture, openedGhostty } from "../__tests__/ghosttyTab";

installTerminalDom();

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  resetTerminals();
});

function target(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

describe("a terminal", () => {
  test("mounts only once the pane that holds it draws its layer", async () => {
    seatTerminals([terminalTab({ id: "term" })]);
    vi.mocked(document.fonts.load).mockClear();
    mounted.push(mount(Terminals, { target: target() }));
    await tick();
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    // A renderer and a dial come only once the widget has loaded, so their
    // absence within this wait depends on how long that load takes. The
    // terminal's body and the font it asks for first are there within a turn
    // of a mount, whatever the load.
    expect(document.querySelector(".terminal-tab"), "no terminal is mounted").toBeNull();
    expect(document.fonts.load, "none of a terminal's mount-time work has begun").not.toHaveBeenCalled();
    expect({ renderers: ghosttyFixture.terminals.length, dials: TerminalSocket.all.length }).toEqual({
      renderers: 0,
      dials: 0,
    });

    mounted.push(mount(Pane, { target: target(), props: { pane: layout.nodes[TERMINAL_PANE] as LeafNode } }));
    await vi.waitFor(() => expect(document.querySelector(".terminal-tab"), "docked, the terminal mounts").not.toBeNull());
    expect(document.fonts.load).toHaveBeenCalled();
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));

    const term = await openedGhostty();
    expect(term.element!.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe(
      TERMINAL_PANE,
    );
  });
});
