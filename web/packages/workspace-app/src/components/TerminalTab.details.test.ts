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
import { attach, installTerminalDom, menuRow, mountTerminal, openTerminalMenu, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TerminalSocket } from "../__tests__/terminalTab";
import { settingsPreferences } from "../__tests__/settings";
import { __testSetStandalonePreferences } from "../state/store.svelte";

installTerminalDom();
afterEach(() => { resetTerminals(); __testSetStandalonePreferences(null); vi.restoreAllMocks(); });

async function mounted(open = false) {
  const preferences = settingsPreferences();
  __testSetStandalonePreferences({ ...preferences, terminal: { ...preferences.terminal, program_status: false } });
  const [tab] = seatTerminals([terminalTab({ inspectorOpen: open })]);
  const view = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await tick();
  return { ...view, tab: tab!, socket };
}

const message = (text: string) => ({ text, source: "cs_write", prompt_id: null, awaiting_submit: false });

test("Details opens without program status, subscribes to queued messages and unsubscribes on close", async () => {
  const { tab, socket, target } = await mounted();
  await openTerminalMenu(tab);
  expect(menuRow("Details").disabled).toBe(false);
  menuRow("Details").click();
  await tick();
  expect(tab.inspectorOpen).toBe(true);
  expect(sentFrames(socket).filter(f => f.type === "queue-details").at(-1)).toEqual({ type: "queue-details", enabled: true });
  expect(target.querySelector('aside.inspector.right.floating[aria-label="Details"]')).not.toBeNull();
  expect(target.querySelector(".program-inspector")).toBeNull();
  await receive(socket, { type: "queue-details", messages: [message("first"), message("<script>plain text</script>")] });
  await tick();
  expect([...target.querySelectorAll(".queue-inspector pre")].map(el => el.textContent)).toEqual(["first", "<script>plain text</script>"]);
  expect(target.querySelector(".queue-inspector script")).toBeNull();
  await receive(socket, { type: "queue-details", messages: [message("second")] });
  await tick();
  expect(target.querySelectorAll(".queue-inspector li")).toHaveLength(1);
  target.querySelector<HTMLButtonElement>('[aria-label="Close Details"]')!.click();
  await tick();
  expect(tab.inspectorOpen).toBe(false);
  expect(sentFrames(socket).filter(f => f.type === "queue-details").at(-1)).toEqual({ type: "queue-details", enabled: false });
});

test("restored Details remains open with no status records and replaces queue content on reattach", async () => {
  const { tab, socket, target } = await mounted(true);
  expect(tab.inspectorOpen).toBe(true);
  expect(target.querySelector(".queue-inspector")).not.toBeNull();
  await receive(socket, { type: "queue-details", messages: [message("old")] });
  await tick();
  await attach(socket, { generation: 2 });
  await tick();
  expect(target.querySelector(".queue-inspector")?.textContent).not.toContain("old");
  expect(sentFrames(socket).filter(f => f.type === "queue-details").at(-1)).toEqual({ type: "queue-details", enabled: true });
  await receive(socket, { type: "queue-details", messages: [{ ...message(""), awaiting_submit: true }] });
  await tick();
  expect(target.querySelector(".queue-inspector")?.textContent).toContain("waiting to submit");
});
