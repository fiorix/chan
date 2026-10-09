// @vitest-environment jsdom

import { tick } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { installTerminalDom, mountTerminal, openTerminalMenu, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TerminalSocket } from "../__tests__/terminalTab";
import type { ProgramStatus, ProgramStatusRecord } from "../state/programStatus";

installTerminalDom();
afterEach(() => { resetTerminals(); vi.restoreAllMocks(); });

function snapshot(revision: number, partial: Partial<ProgramStatusRecord> = {}): ProgramStatus {
  return { revision, records: [{ source: "program", id: null, state: "done", kind: null, progress: null, app: "runner", title: "Finished", msg: null, seen: false, update_order: revision, ...partial }] };
}

async function mounted(focused = false) {
  const [tab] = seatTerminals([terminalTab({ title: "Worker" })]);
  const view = await mountTerminal(TerminalTab, tab!, { focused, active: focused });
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, { type: "session", id: "status-session", generation: 2, seq: 0, program_status: snapshot(4) });
  return { ...view, socket, tab: tab! };
}

test("attach replaces a higher stale revision with its authoritative snapshot", async () => {
  const { socket, tab } = await mounted();
  await receive(socket, { type: "program-status", id: "status-session", generation: 2, program_status: snapshot(9) });
  await receive(socket, { type: "session", id: "status-session", generation: 2, seq: 0, program_status: snapshot(1, { state: "idle" }) });
  expect(tab.programStatus?.revision).toBe(1);
});

test("incremental frames require the current id, generation and newer revision", async () => {
  const { socket, tab } = await mounted();
  await receive(socket, { type: "program-status", id: "other", generation: 2, program_status: snapshot(5) });
  await receive(socket, { type: "program-status", id: "status-session", generation: 1, program_status: snapshot(6) });
  await receive(socket, { type: "program-status", id: "status-session", generation: 2, program_status: snapshot(4, { state: "error" }) });
  expect(tab.programStatus?.revision).toBe(4);
});

test("newer incremental status replaces the tab value", async () => {
  const { socket, tab } = await mounted();
  await receive(socket, { type: "program-status", id: "status-session", generation: 2, program_status: snapshot(5, { state: "error" }) });
  expect(tab.programStatus?.records[0]?.state).toBe("error");
});

test("a completion received in front is hidden locally", async () => {
  const { tab } = await mounted(true);
  expect(tab.programStatus?.records[0]?.seen).toBe(true);
});

test("a background page keeps an unseen completion after another page says yes", async () => {
  const { tab } = await mounted(false);
  expect(tab.programStatus?.records[0]?.seen).toBe(false);
});

test("a background reconnect replaces its stale local value", async () => {
  const { socket, tab } = await mounted(false);
  await receive(socket, { type: "program-status", id: "status-session", generation: 2, program_status: snapshot(8, { state: "error" }) });
  await receive(socket, { type: "session", id: "status-session", generation: 2, seq: 0, program_status: snapshot(1, { state: "idle" }) });
  expect(tab.programStatus).toMatchObject({ revision: 1, records: [{ state: "idle", seen: false }] });
});

test("a no word from a second page leaves its mark unseen while the yes page hides locally", async () => {
  const [front, back] = seatTerminals([terminalTab({ id: "front-page" }), terminalTab({ id: "back-page" })]);
  await mountTerminal(TerminalTab, front!, { active: true, focused: true });
  const yesSocket = TerminalSocket.all.at(-1)!;
  yesSocket.onopen?.();
  await receive(yesSocket, { type: "session", id: "shared", generation: 1, seq: 0, program_status: snapshot(2) });
  await mountTerminal(TerminalTab, back!, { active: false, focused: false });
  const noSocket = TerminalSocket.all.at(-1)!;
  noSocket.onopen?.();
  await receive(noSocket, { type: "session", id: "shared", generation: 1, seq: 0, program_status: snapshot(2) });
  expect([front?.programStatus?.records[0]?.seen, back?.programStatus?.records[0]?.seen, sentFrames(noSocket).filter((frame) => frame.type === "focus").at(-1)?.focused]).toEqual([true, false, false]);
  yesSocket.close();
  expect(back?.programStatus?.records[0]?.seen).toBe(false);
});

test("the final value remains on the attached page after process exit and becomes seen", async () => {
  const { socket, tab } = await mounted(false);
  await receive(socket, { type: "program-status", id: "status-session", generation: 2, program_status: snapshot(5, { state: "error" }) });
  await receive(socket, { type: "exit", code: 1 });
  expect(tab.programStatus?.records[0]).toMatchObject({ state: "error", seen: true });
});

test("closed clears the status", async () => {
  const { socket, tab } = await mounted();
  expect(tab.programStatus?.records).toHaveLength(1);
  await receive(socket, { type: "closed", reason: "shutdown" });
  expect(tab.programStatus).toBeUndefined();
});

test("Program status opens a keyboard reachable inspector with safe text after exit", async () => {
  const warned = vi.spyOn(console, "warn");
  const errored = vi.spyOn(console, "error");
  const { socket, tab } = await mounted();
  await receive(socket, { type: "program-status", id: "status-session", generation: 2, program_status: snapshot(5, { title: "name\u202Eback", msg: "a\u200Bb<script>bad</script>" }) });
  await receive(socket, { type: "exit", code: 0 });
  await openTerminalMenu(tab);
  const row = [...document.body.querySelectorAll<HTMLButtonElement>("button.mbtn")].find((button) => button.querySelector(".mbtn-label")?.textContent?.trim() === "Program status");
  expect(row).toBeDefined();
  if (!row) return;
  expect(row.disabled).toBe(false);
  row.focus();
  expect(document.activeElement).toBe(row);
  row.click();
  await tick();
  const inspector = document.body.querySelector(".program-inspector");
  expect(inspector?.textContent).toContain("name□back");
  expect(inspector?.textContent).toContain("a□b<script>bad</script>");
  expect(inspector?.querySelector("script")).toBeNull();
  expect([...warned.mock.calls, ...errored.mock.calls].flat().join(" ")).not.toContain("bad");
  expect(tab.terminalMetadataError).toBeUndefined();
  expect(document.querySelector("td")?.textContent ?? "").not.toContain("bad");
});
