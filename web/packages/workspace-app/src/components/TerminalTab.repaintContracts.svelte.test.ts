// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

const mounted: Array<Record<string, unknown>> = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  resetTerminals();
  document.body.replaceChildren();
});

const pastRecovery = () => new Promise((resolve) => setTimeout(resolve, 300));

async function openTerminal(active: boolean) {
  const [tab] = seatTerminals([terminalTab()]);
  const props = $state({ tab: tab!, paneId: TERMINAL_PANE, side: "a" as const, active, focused: false });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TerminalTab, { target, props }));
  await vi.waitFor(() => expect(xterm.terminals).toHaveLength(1));
  const term = xterm.terminals[0]!;
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await pastRecovery();
  return { props, term, socket };
}

test("revealing an unfocused tab repaints every row without a resize or focus change", async () => {
  const { props, term } = await openTerminal(false);
  const grid = { cols: term.cols, rows: term.rows };
  term.refreshCalls.splice(0);

  props.active = true;
  flushSync();
  await tick();

  expect(props.focused, "the pane still has no keyboard focus").toBe(false);
  expect({ cols: term.cols, rows: term.rows }, "the grid did not change").toEqual(grid);
  expect(term.refreshCalls, "showing the existing grid repaints it").toContainEqual([0, grid.rows - 1]);
});

test("output, focus, blur, reveal and host resume preserve the shared texture atlas", async () => {
  const { props, term, socket } = await openTerminal(true);
  // The atlas belongs to all panes. A refresh may repaint this pane's rows,
  // but must never use xterm's destructive clearTextureAtlas API.
  const clearTextureAtlas = vi.fn();
  Object.assign(term, { clearTextureAtlas });

  const sgrOutput = "\x1b[31mvisible output\x1b[0m";
  await output(socket, sgrOutput);
  expect(term.written.at(-1)).toBe(sgrOutput);
  expect(clearTextureAtlas, "output leaves the atlas intact").not.toHaveBeenCalled();

  for (const focused of [true, false]) {
    term.refreshCalls.splice(0);
    props.focused = focused;
    flushSync();
    await tick();
    expect(term.refreshCalls, focused ? "focus repaints" : "blur repaints").toContainEqual([0, term.rows - 1]);
    expect(clearTextureAtlas, focused ? "focus preserves the atlas" : "blur preserves the atlas").not.toHaveBeenCalled();
  }

  props.active = false;
  flushSync();
  await tick();
  props.active = true;
  flushSync();
  await tick();
  expect(clearTextureAtlas, "reveal preserves the atlas").not.toHaveBeenCalled();

  term.refreshCalls.splice(0);
  window.dispatchEvent(new Event("pageshow"));
  await tick();
  expect(term.refreshCalls, "host resume repaints").toContainEqual([0, term.rows - 1]);
  await pastRecovery();
  expect(clearTextureAtlas, "including the delayed resume repaints").not.toHaveBeenCalled();
});
