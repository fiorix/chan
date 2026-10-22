// @vitest-environment jsdom
//
// Closing a terminal asks only while its session runs. The confirm guards the
// closes that kill a session; a mounted terminal registers its sinks whether
// or not it has one, and a terminal whose shell exited, or whose socket never
// connected, runs nothing. A TerminalTab is mounted over the stand-in xterm
// and socket and closed as its tab's X closes it.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { closeTab, layout, type LeafNode } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  if (confirmState.open) resolveConfirm(false);
  resetTerminals();
});

const paneTabs = () => (layout.nodes[TERMINAL_PANE] as LeafNode).tabs;

/// Mount a terminal tab and return it with its socket.
async function mounted() {
  const [tab] = seatTerminals([terminalTab()]);
  await mountTerminal(TerminalTab, tab!);
  return { tab: tab!, socket: TerminalSocket.all.at(-1)! };
}

/// Close the tab as its X does: what the close asked, if it asked, declining.
async function closeAsks(tabId: string): Promise<string | null> {
  const closing = closeTab(TERMINAL_PANE, tabId);
  await vi.waitFor(() => expect(confirmState.open || paneTabs().length === 0).toBe(true));
  const asked = confirmState.open ? confirmState.message : null;
  if (confirmState.open) resolveConfirm(false);
  await closing;
  return asked;
}

describe("closing a terminal", () => {
  test("asks while its session runs", async () => {
    const { tab, socket } = await mounted();
    await attach(socket, { id: "sess-1" });
    expect(tab.terminalSessionId).toBe("sess-1");

    expect(await closeAsks(tab.id)).toContain("is still running");
    expect(paneTabs()).toHaveLength(1);
  });

  test("does not ask once its shell exited", async () => {
    const { tab, socket } = await mounted();
    await attach(socket, { id: "sess-1" });
    await receive(socket, { type: "exit", code: 0 });
    expect(tab.terminalSessionId, "the exit cleared the session").toBeUndefined();

    expect(await closeAsks(tab.id)).toBeNull();
    expect(paneTabs()).toHaveLength(0);
  });

  test("does not ask before its session started", async () => {
    TerminalSocket.connecting = true;
    const { tab } = await mounted();
    expect(tab.terminalSessionId, "no session frame has arrived").toBeUndefined();

    expect(await closeAsks(tab.id)).toBeNull();
    expect(paneTabs()).toHaveLength(0);
  });
});
