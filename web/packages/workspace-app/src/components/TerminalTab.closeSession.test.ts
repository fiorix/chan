// @vitest-environment jsdom
//
// How closing or restarting a terminal ends its live session. The close
// frame rides the terminal's socket; when no open socket can carry it (a
// dial still in flight, or a socket that dropped and waits to redial) the
// route ends the session instead, so the server is told once either way. A
// TerminalTab is mounted on the real widget through the shared fixture, over
// a stand-in socket, then closed as its tab's X closes it or restarted from
// the command, with the running shell's confirm accepted.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { api } from "../api/client";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { closeTab, type TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-live";

afterEach(() => {
  if (confirmState.open) resolveConfirm(false);
  resetTerminals();
  vi.restoreAllMocks();
});

/// A loaded terminal on the live session SESSION, its socket left `open`,
/// still `dialing` (a restored tab whose dial has not answered), or
/// `dropped` after the attach with its redial not yet due.
async function loaded(socketState: "open" | "dialing" | "dropped") {
  const closeTerminal = vi.spyOn(api, "closeTerminal").mockResolvedValue(undefined);
  if (socketState === "dialing") TerminalSocket.connecting = true;
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const { target } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  if (socketState !== "dialing") await attach(socket, { id: SESSION });
  if (socketState === "dropped") socket.finishClose();
  expect(target.querySelectorAll(".terminal-host canvas"), "the terminal loaded").toHaveLength(1);
  expect(tab!.terminalSessionId).toBe(SESSION);
  expect(TerminalSocket.all, "one socket so far").toHaveLength(1);
  return { tab: tab!, closeTerminal };
}

/// Close the tab or restart its terminal, accepting the running shell's
/// confirm, and wait until the tab has let go of its session.
async function end(tab: TerminalTabState, how: "close" | "restart"): Promise<void> {
  let closing: Promise<void> | undefined;
  if (how === "close") closing = closeTab(TERMINAL_PANE, tab.id);
  else window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
  await vi.waitFor(() => expect(confirmState.open, "a running shell asks first").toBe(true));
  resolveConfirm(true);
  await closing;
  await vi.waitFor(() => expect(tab.terminalSessionId, "the tab let go of its session").toBeUndefined());
}

function closeFrames(): number {
  return TerminalSocket.all.flatMap((socket) => sentFrames(socket).filter((frame) => frame.type === "close")).length;
}

describe("ending a terminal's live session", () => {
  test.each(["close", "restart"] as const)("a %s over an open socket sends the close frame and asks no route", async (how) => {
    const { tab, closeTerminal } = await loaded("open");

    await end(tab, how);

    expect(closeFrames(), "the close frame ended the session").toBe(1);
    expect(closeTerminal, "the route was not asked as well").not.toHaveBeenCalled();
  });

  describe.each([
    ["still dialing", "dialing"],
    ["dropped and waiting to redial", "dropped"],
  ] as const)("a loaded terminal whose socket is %s", (_, socketState) => {
    test("closing it ends the session through the route, once", async () => {
      const { tab, closeTerminal } = await loaded(socketState);

      await end(tab, "close");

      expect(closeFrames(), "no socket could carry the close frame").toBe(0);
      expect(closeTerminal.mock.calls, "the route ended the live session, once").toEqual([[SESSION]]);
    });

    test("restarting it ends the session through the route, once, and dials a fresh shell", async () => {
      const { tab, closeTerminal } = await loaded(socketState);

      await end(tab, "restart");
      await vi.waitFor(() => expect(TerminalSocket.all, "the restarted terminal dialed").toHaveLength(2));

      expect(closeFrames(), "no socket could carry the close frame").toBe(0);
      expect(closeTerminal.mock.calls, "the route ended the live session, once").toEqual([[SESSION]]);
      const url = new URL(TerminalSocket.all[1]!.url);
      expect(url.searchParams.get("session"), "a fresh shell, not the ended session").toBeNull();
    });
  });
});
