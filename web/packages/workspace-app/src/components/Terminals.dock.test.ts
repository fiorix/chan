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

import Pane from "./Pane.svelte";
import Terminals from "./Terminals.svelte";
import {
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  TERMINAL_PANE,
  terminalTab,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";
import { layout, type LeafNode } from "../state/tabs.svelte";

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
    mounted.push(mount(Terminals, { target: target() }));
    await tick();
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    expect({ renderers: xterm.terminals.length, dials: TerminalSocket.all.length }).toEqual({
      renderers: 0,
      dials: 0,
    });

    mounted.push(mount(Pane, { target: target(), props: { pane: layout.nodes[TERMINAL_PANE] as LeafNode } }));
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));

    expect(xterm.terminals[0]!.element!.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe(
      TERMINAL_PANE,
    );
  });
});
