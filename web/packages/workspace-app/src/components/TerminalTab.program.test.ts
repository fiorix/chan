// @vitest-environment jsdom
//
// What runs in a terminal, as the page holds it: the `session` prelude sets
// the reading for each attachment, a `program` frame of the same session and
// generation replaces it whole, and an ended session leaves none.

import { tick } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { installTerminalDom, mountTerminal, receive, resetTerminals, seatTerminals, terminalTab, TerminalSocket } from "../__tests__/terminalTab";
import type { TerminalProgram } from "../state/terminalProgram";

installTerminalDom();
afterEach(() => { resetTerminals(); vi.restoreAllMocks(); });

const SESSION = "program-session";

function session(generation: number, program?: TerminalProgram, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "session", id: SESSION, generation, seq: 0, ...(program === undefined ? {} : { program }), ...extra };
}

function delta(generation: number, program: TerminalProgram, id = SESSION): Record<string, unknown> {
  return { type: "program", id, generation, program };
}

async function attached(program?: TerminalProgram, props: { focused?: boolean; active?: boolean } = {}) {
  const [tab] = seatTerminals([terminalTab({ title: "Shell" })]);
  await mountTerminal(TerminalTab, tab!, props);
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, session(2, program));
  return { socket, tab: tab! };
}

test("the prelude's reading is the tab's", async () => {
  const { tab } = await attached({ title: null, command: "bash" });
  expect(tab.terminalProgram).toEqual({ title: null, command: "bash" });
});

test("a server that sends no reading leaves the tab without one, and replaces one an earlier attach held", async () => {
  const { socket, tab } = await attached();
  expect(tab.terminalProgram).toBeUndefined();
  await receive(socket, session(2, { title: "build", command: "bash" }));
  expect(tab.terminalProgram?.title).toBe("build");
  await receive(socket, session(2));
  expect(tab.terminalProgram).toBeUndefined();
});

test("a delta of this session and generation replaces the whole pair", async () => {
  const { socket, tab } = await attached({ title: "build", command: "bash" });
  await receive(socket, delta(2, { title: null, command: "vim" }));
  expect(tab.terminalProgram).toEqual({ title: null, command: "vim" });
  await receive(socket, delta(2, { title: null, command: null }));
  expect(tab.terminalProgram).toEqual({ title: null, command: null });
});

test("a delta of another session or another generation is ignored", async () => {
  const { socket, tab } = await attached({ title: null, command: "bash" });
  await receive(socket, delta(2, { title: "other", command: "zsh" }, "another-session"));
  await receive(socket, delta(1, { title: "earlier", command: "vim" }));
  await receive(socket, delta(3, { title: "later", command: "vim" }));
  expect(tab.terminalProgram).toEqual({ title: null, command: "bash" });
});

test("a restart's new generation takes its own prelude's reading, and the old generation's late delta does not land", async () => {
  const { socket, tab } = await attached({ title: "build", command: "make" });
  await receive(socket, session(3, { title: null, command: "bash" }));
  expect(tab.terminalProgram).toEqual({ title: null, command: "bash" });
  await receive(socket, delta(2, { title: "build", command: "make" }));
  expect(tab.terminalProgram).toEqual({ title: null, command: "bash" });
  await receive(socket, session(4));
  expect(tab.terminalProgram, "a prelude without the field clears a restart's reading too").toBeUndefined();
});

test("an exit leaves no reading, though the final program status stays", async () => {
  const { socket, tab } = await attached({ title: "build", command: "bash" });
  await receive(socket, { type: "program-status", id: SESSION, generation: 2, program_status: { revision: 1, records: [{ source: "program", id: null, state: "done", kind: null, progress: null, app: "runner", title: "Finished", msg: null, seen: false, update_order: 1 }] } });
  await receive(socket, { type: "exit", code: 0 });
  expect(tab.terminalProgram).toBeUndefined();
  expect(tab.programStatus?.records).toHaveLength(1);
});

test("a closed session leaves no reading", async () => {
  const { socket, tab } = await attached({ title: null, command: "bash" });
  await receive(socket, { type: "closed", reason: "idle" });
  expect(tab.terminalProgram).toBeUndefined();
});

test("a transient disconnect keeps the reading until the reattach prelude replaces it", async () => {
  const { socket, tab } = await attached({ title: null, command: "vim" });
  socket.close();
  await tick();
  expect(tab.terminalProgram).toEqual({ title: null, command: "vim" });
});

test("a terminal behind another tab applies its own deltas", async () => {
  const { socket, tab } = await attached({ title: null, command: "bash" }, { focused: false, active: false });
  await receive(socket, delta(2, { title: "build", command: "bash" }));
  expect(tab.terminalProgram).toEqual({ title: "build", command: "bash" });
});

test("two tabs of one session each take the reading from their own socket", async () => {
  const [one, two] = seatTerminals([
    terminalTab({ id: "one", title: "Shell" }),
    terminalTab({ id: "two", title: "Shell" }),
  ]);
  await mountTerminal(TerminalTab, one!, { focused: true, active: true });
  const first = TerminalSocket.all.at(-1)!;
  await mountTerminal(TerminalTab, two!, { focused: false, active: false });
  const second = TerminalSocket.all.at(-1)!;
  expect(second).not.toBe(first);
  for (const socket of [first, second]) {
    socket.onopen?.();
    await receive(socket, session(2, { title: null, command: "bash" }));
  }
  for (const socket of [first, second]) await receive(socket, delta(2, { title: null, command: "vim" }));
  expect(one!.terminalProgram).toEqual({ title: null, command: "vim" });
  expect(two!.terminalProgram).toEqual({ title: null, command: "vim" });
});

test("a tmux pane's prelude holds the empty pair the server sends it", async () => {
  const [tab] = seatTerminals([terminalTab({ title: "editor" })]);
  await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, session(1, { title: null, command: null }, { tmux_pane: { connection: 1, pane: "%1" } }));
  expect(tab!.tmuxPane).toEqual({ connection: 1, pane: "%1" });
  expect(tab!.terminalProgram).toEqual({ title: null, command: null });
});
