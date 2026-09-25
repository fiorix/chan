// @vitest-environment jsdom
//
// A terminal's two menus. The tab menu (from the tab strip) names and groups
// the terminal, shows its status and broadcast controls, and ends with Close.
// The body menu (a right-click in the terminal) shows the live engine and the
// secret-masking toggle, then Find, Copy, Paste and Copy Scrollback. Command
// discovery lives in the launcher, not here. A TerminalTab is mounted over
// the stand-in xterm and socket.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import type { Preferences } from "../api/types";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { closeTabMenu } from "../state/tabMenu.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  openTerminalMenu,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.restoreAllMocks();
});

async function attached(prefs: Record<string, unknown> | null = null) {
  if (prefs) __testSetStandalonePreferences({ terminal: prefs } as unknown as Preferences);
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return { ...mounted, tab: tab!, socket };
}

/// The open menu's rows in order: a separator as "---", a label row by its
/// label, a named field by its caption, the status row by its text.
function menuShape(): string[] {
  const menu = document.body.querySelector(".terminal-tab-menu-bubble")!;
  return [...menu.querySelectorAll(".msep, .mbtn, .rename-row, .terminal-status-row, .terminal-backend-label")].map(
    (el) => {
      if (el.classList.contains("msep")) return "---";
      if (el.classList.contains("rename-row")) return `field ${el.querySelector("span")?.textContent?.trim()}`;
      if (el.classList.contains("terminal-status-row")) return `status ${el.querySelector(".terminal-status")?.textContent?.trim()}`;
      if (el.classList.contains("terminal-backend-label")) return `engine ${el.querySelector(".terminal-backend-value")?.textContent?.trim()}`;
      return el.querySelector(".mbtn-label")?.textContent?.trim() ?? "";
    },
  );
}

function maskingLabel(): string {
  return menuShape().find((row) => row.startsWith("Secret masking")) ?? "";
}

describe("the tab menu", () => {
  test("names and groups the terminal, then its status, and ends with Close after a separator", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    const shape = menuShape();

    expect(shape.slice(0, 3)).toEqual(["field Name", "field Group", "status connected: 80x24"]);
    expect(shape.slice(-2)).toEqual(["---", "Close"]);
    expect(document.body.querySelector(".from-cwd-label")).toBeNull();
    expect(document.body.textContent).not.toContain("Set MCP env vars");
  });

  test("Close asks about the live terminal, then closes this tab in its pane", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    menuRow("Close").click();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await vi.waitFor(() => expect((layout.nodes[TERMINAL_PANE] as LeafNode).tabs).toEqual([]));
  });
});

describe("the body menu", () => {
  test("starts with the engine and masking, then Find, Copy, Paste and Copy Scrollback", async () => {
    const { target } = await attached();
    await openBodyMenu(target);
    expect(menuShape()).toEqual([
      "engine xterm",
      "Secret masking: off",
      "---",
      "Find",
      "Copy",
      "Paste",
      "Copy Scrollback",
      ...menuShape().slice(7),
    ]);
  });

  test("masking starts from the setting, and each new terminal reads it again", async () => {
    const first = await attached({ secret_masking: true });
    await openBodyMenu(first.target);
    expect(maskingLabel()).toBe("Secret masking: on");
    closeTabMenu();
    resetTerminals();

    const second = await attached({ secret_masking: false });
    await openBodyMenu(second.target);
    expect(maskingLabel()).toBe("Secret masking: off");
  });

  test("the toggle flips masking for this terminal only and saves nothing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { target } = await attached();
    await openBodyMenu(target);
    menuRow("Secret masking: off").click();
    await tick();
    await openBodyMenu(target);
    expect(maskingLabel()).toBe("Secret masking: on");

    closeTabMenu();
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.secretMasking.toggle" } }));
    await tick();
    await openBodyMenu(target);
    expect(maskingLabel()).toBe("Secret masking: off");
    expect(setItem.mock.calls.filter(([key]) => /mask/i.test(String(key)))).toEqual([]);
  });
});
