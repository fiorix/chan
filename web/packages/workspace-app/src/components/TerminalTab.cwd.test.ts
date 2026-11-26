// @vitest-environment jsdom
//
// "Copy path to $CWD" puts the shell's working directory on the clipboard.
// It runs from the command launcher while its overlay is dismissing, so the
// terminal takes focus back before it writes, through the desktop-safe
// clipboard writer. A TerminalTab is mounted on the real widget through the
// shared fixture and the server reports the cwd on its socket; the writer is
// stubbed and records whether the terminal held the keyboard as it ran.

import { afterEach, describe, expect, test, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  writes: [] as Array<{ text: string; terminalFocused: boolean }>,
  terminalFocused: (): boolean => false,
}));

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  writeClipboardText: vi.fn(async (text: string) => {
    clipboard.writes.push({ text, terminalFocused: clipboard.terminalFocused() });
  }),
}));

import TerminalTab from "./TerminalTab.svelte";
import { pathPromptState, resolvePathPrompt, ui, workspace } from "../state/store.svelte";
import { ghosttyHasFocus, mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import {
  attach,
  installTerminalDom,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  if (pathPromptState.open) resolvePathPrompt(null);
  workspace.info = null;
  resetTerminals();
  clipboard.writes = [];
  ui.status = null;
});

async function reportingCwd(cwd: string | null, cwdRel: string | null) {
  const [tab] = seatTerminals([terminalTab()]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "cwd", cwd, cwd_rel: cwdRel });
  clipboard.terminalFocused = () => ghosttyHasFocus(term);
  return { term };
}

async function copyCwd(): Promise<void> {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.copyCwd" } }));
  await Promise.resolve();
  await Promise.resolve();
}

describe("Copy path to $CWD", () => {
  test("copies the absolute cwd the shell reported, after taking focus back", async () => {
    const { term } = await reportingCwd("/home/me/ws/notes", "notes");
    // The launcher's overlay dismissing leaves the keyboard on the body.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(ghosttyHasFocus(term), "the keyboard is off the terminal").toBe(false);
    await copyCwd();

    expect(clipboard.writes.map((w) => w.text)).toEqual(["/home/me/ws/notes"]);
    expect(clipboard.writes[0]!.terminalFocused, "focused before the write").toBe(true);
  });

  test("falls back to the workspace-relative cwd without an absolute one", async () => {
    await reportingCwd(null, "notes");
    await copyCwd();
    expect(clipboard.writes.map((w) => w.text)).toEqual(["notes"]);
  });

  test("with no cwd reported, writes nothing and says so", async () => {
    await reportingCwd(null, null);
    await copyCwd();
    expect(clipboard.writes).toEqual([]);
    expect(ui.status).toBe("PTY did not report CWD");
    expect(ui.statusKind, "dismissable, not auto-cleared").toBe("persistent");
  });
});

describe("New File or Directory here", () => {
  async function newEntryHere(): Promise<void> {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.newFsEntry" } }));
    await Promise.resolve();
    await Promise.resolve();
  }

  test("opens at the cwd the server reported for the workspace, when it reported one", async () => {
    workspace.info = { root: "/home/me/ws" } as typeof workspace.info;
    await reportingCwd("/home/me/ws/notes", "projects/notes");
    await newEntryHere();
    expect(pathPromptState.defaultValue).toBe("projects/notes/");
  });

  test("otherwise opens at the absolute cwd taken relative to the workspace root", async () => {
    workspace.info = { root: "/home/me/ws" } as typeof workspace.info;
    await reportingCwd("/home/me/ws/notes", null);
    await newEntryHere();
    expect(pathPromptState.defaultValue).toBe("notes/");
  });
});
