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
import { installTerminalDom, mountTerminal, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TerminalSocket } from "../__tests__/terminalTab";
import type { TmuxConsent } from "../state/tmuxConsent";

installTerminalDom();
afterEach(() => { resetTerminals(); vi.restoreAllMocks(); });

const QUESTION: TmuxConsent = { revision: 3, question: { program: "ssh", command: "ssh host tmux -CC", timeout_secs: 60 } };
const CLOSED: TmuxConsent = { revision: 4 };

async function mounted(consent: TmuxConsent = { revision: 0 }) {
  const [tab] = seatTerminals([terminalTab({ title: "Worker" })]);
  const view = await mountTerminal(TerminalTab, tab!, { focused: true, active: true });
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, { type: "session", id: "tmux-session", generation: 2, seq: 0, tmux_consent: consent });
  return { ...view, socket, tab: tab! };
}

function banner(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".tmux-consent");
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>(".tmux-consent button")].find((b) => b.textContent?.trim() === label)!;
}

function answers(socket: TerminalSocket): string[] {
  return sentFrames(socket).filter((f) => f.type === "tmux-answer").map((f) => f.answer as string);
}

test("a session frame with an open question shows the banner naming the program", async () => {
  const { tab } = await mounted(QUESTION);
  expect(tab.tmuxConsent).toEqual(QUESTION);
  const shown = banner();
  expect(shown).not.toBeNull();
  expect(shown!.textContent).toContain("ssh");
  expect(shown!.textContent).toContain("ssh host tmux -CC");
  expect(shown!.getAttribute("role")).toBe("dialog");
});

test("each button sends its answer once and the banner stays until the server closes the question", async () => {
  const { socket } = await mounted(QUESTION);
  button("Allow for this tab").click();
  await tick();
  expect(answers(socket)).toEqual(["allow-for-tab"]);
  expect(banner()).not.toBeNull();
  await receive(socket, { type: "tmux-consent", id: "tmux-session", generation: 2, tmux_consent: CLOSED });
  expect(banner()).toBeNull();
});

test("Escape denies", async () => {
  const { socket } = await mounted(QUESTION);
  banner()!.querySelector<HTMLElement>(".tc-card")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  expect(answers(socket)).toEqual(["deny"]);
});

test("a later frame opens the question, and a stale or foreign one is ignored", async () => {
  const { socket, tab } = await mounted();
  expect(banner()).toBeNull();
  await receive(socket, { type: "tmux-consent", id: "other", generation: 2, tmux_consent: QUESTION });
  await receive(socket, { type: "tmux-consent", id: "tmux-session", generation: 1, tmux_consent: QUESTION });
  expect(banner()).toBeNull();
  await receive(socket, { type: "tmux-consent", id: "tmux-session", generation: 2, tmux_consent: QUESTION });
  expect(banner()).not.toBeNull();
  await receive(socket, { type: "tmux-consent", id: "tmux-session", generation: 2, tmux_consent: { revision: 2, question: { program: "stale", timeout_secs: 60 } } });
  expect(tab.tmuxConsent?.question?.program).toBe("ssh");
  // A new attachment's session frame is authoritative even at a lower revision.
  await receive(socket, { type: "session", id: "tmux-session", generation: 2, seq: 0, tmux_consent: { revision: 1 } });
  expect(banner()).toBeNull();
});
