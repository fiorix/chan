// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { installTerminalDom, mountTerminal, receive, resetTerminals, seatTerminals, terminalTab, TerminalSocket } from "../__tests__/terminalTab";

installTerminalDom();
afterEach(() => { resetTerminals(); vi.clearAllMocks(); });

test("the session frame marks a tab that shows a tmux pane, and a fresh shell clears it", async () => {
  const [tab] = seatTerminals([terminalTab({ title: "Pane" })]);
  await mountTerminal(TerminalTab, tab!, { focused: true, active: true });
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, { type: "session", id: "shell-1", generation: 2, seq: 0 });
  expect(tab!.tmuxPane).toBeUndefined();
  await receive(socket, { type: "session", id: "pane-1", generation: 3, seq: 0, tmux_pane: { connection: 2, pane: "%7" } });
  expect(tab!.tmuxPane).toEqual({ connection: 2, pane: "%7" });
  await receive(socket, { type: "session", id: "shell-2", generation: 4, seq: 0 });
  expect(tab!.tmuxPane).toBeUndefined();
});
