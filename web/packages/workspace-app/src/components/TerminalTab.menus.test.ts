// @vitest-environment jsdom
//
// A terminal's two menus. The tab menu (from the tab strip) names and groups
// the terminal, shows its status and broadcast controls, and ends with Close.
// The body menu (a right-click in the terminal) shows the live engine and the
// secret-masking toggle, then Find, Copy, Paste and Copy Scrollback, and ends
// with Commands, which opens the command launcher from this terminal as its
// chord does. A TerminalTab is mounted over the stand-in xterm and socket.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import { privacy } from "@chan/web-shared/privacy";
import TerminalTab from "./TerminalTab.svelte";
import type { TerminalPreferences, TerminalRosterEntry } from "../api/types";
import { terminalPreferences } from "../__tests__/standalone";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { applyTerminalRoster, layout, type LeafNode } from "../state/tabs.svelte";
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
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

const startControl = ui.terminalControl;

const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: () => Promise<unknown> } };

afterEach(() => {
  resetTerminals();
  privacy.enabled = false;
  privacy.mask_terminal_secrets = false;
  __testSetStandalonePreferences(null);
  ui.terminalControl = startControl;
  xterm.textareaFocus = false;
  delete tauri.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

async function attached(prefs: Partial<TerminalPreferences> | null = null) {
  if (prefs) __testSetStandalonePreferences(terminalPreferences(prefs));
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
  });

  test("is portaled to the page body and kept on screen", async () => {
    const { tab } = await attached();
    openTabMenu(tab.id, { left: 5000, top: 10, right: 5000, bottom: 20 });
    await tick();
    await tick();
    const bubble = document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
    expect(bubble.parentElement).toBe(document.body);
    expect(bubble.style.position).toBe("fixed");
    expect(parseFloat(bubble.style.left)).toBeLessThanOrEqual(window.innerWidth - 8);
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

// Select All describes the group across windows. A member whose window no
// page holds cannot act on a toggle routed to it, so the label leaves it out.
describe("the tab menu's Select All", () => {
  afterEach(() => applyTerminalRoster([]));

  function member(name: string, live: boolean, broadcast: boolean): TerminalRosterEntry {
    return { id: `sess-${name}`, tab_name: name, tab_group: "default", window_id: `${name}-win`, window_live: live, broadcast };
  }

  /// This window's one terminal with broadcast on, the roster's members of
  /// its group in other windows, and what its tab menu then shows: the
  /// Select All row's label and the members it lists under other windows.
  async function selectAll(members: TerminalRosterEntry[]): Promise<{ label: string; others: string[] }> {
    const [tab] = seatTerminals([terminalTab({ broadcastEnabled: true })]);
    await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    applyTerminalRoster(members);
    await openTerminalMenu(tab!);
    const label = menuShape().find((row) => row === "Select All" || row === "Deselect All") ?? "";
    const others = [
      ...document.body.querySelectorAll(".terminal-tab-menu-bubble .broadcast-other-windows-label ~ .target-row .target-name"),
    ].map((el) => el.textContent?.trim() ?? "");
    return { label, others };
  }

  test("reads Deselect All once every member in a window a page holds is on", async () => {
    expect(await selectAll([member("Live", true, true), member("Hidden", false, false)])).toEqual({
      label: "Deselect All",
      others: ["Live"],
    });
  });

  test("reads Select All while a member in a window a page holds is off", async () => {
    expect(await selectAll([member("Live", true, false), member("Hidden", false, true)])).toEqual({
      label: "Select All",
      others: ["Live"],
    });
  });
});

describe("the body menu", () => {
  test.each([
    [true, null, "Secret masking: on"],
    [true, { secret_masking: false }, "Secret masking: off"],
    [false, null, "Secret masking: off"],
  ] as const)("seeds masking in control mode %s with preference %s", async (terminalControl, prefs, label) => {
    ui.terminalControl = terminalControl;
    const { target } = await attached(prefs);
    await openBodyMenu(target);
    expect(maskingLabel()).toBe(label);
  });

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

describe("the body menu's Commands", () => {
  const agents = {
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    linux: "Mozilla/5.0 (X11; Linux x86_64)",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  } as const;
  test.each([
    ["mac", true, "Cmd+K"],
    ["linux", true, "Ctrl+Alt+K"],
    ["windows", true, "Ctrl+Alt+K"],
    ["mac", false, "Ctrl+Alt+K"],
    ["linux", false, "Ctrl+Alt+K"],
  ] as const)("on %s, desktop %s, ends the menu after a separator with the launcher's chord %s", async (os, desktop, chord) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agents[os]);
    if (desktop) tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) };
    const { target } = await attached();
    await openBodyMenu(target);
    expect(menuShape().slice(-2)).toEqual(["---", "Commands"]);
    expect(menuRow("Commands").querySelector(".mbtn-chord")?.textContent?.trim()).toBe(chord);
  });

  test("opens the launcher from this terminal, which holds focus as it opens, and closes the menu", async () => {
    xterm.textareaFocus = true;
    const { target } = await attached();
    const seen: Array<{ name: string; focus: Element | null }> = [];
    const listener = (e: Event) =>
      seen.push({ name: (e as CustomEvent<{ name: string }>).detail.name, focus: document.activeElement });
    window.addEventListener("chan:command", listener);
    try {
      await openBodyMenu(target);
      // A pointer press on the row moves focus there before its click.
      const row = menuRow("Commands");
      row.focus();
      row.click();
      await tick();
    } finally {
      window.removeEventListener("chan:command", listener);
    }
    const screen = target.querySelector(".terminal-tab textarea");
    expect(screen, "the stand-in terminal opened its textarea").not.toBeNull();
    expect(seen.map((s) => s.name)).toEqual(["app.launcher.toggle"]);
    expect(seen[0]!.focus, "the launcher opens with the terminal focused").toBe(screen);
    expect(document.body.querySelector(".terminal-tab-menu-bubble")).toBeNull();
  });
});

describe("both menus", () => {
  test("leave Search and Settings to the global commands", async () => {
    const { tab, target } = await attached();
    await openTerminalMenu(tab);
    const tabMenu = menuShape();
    closeTabMenu();
    await openBodyMenu(target);
    const bodyMenu = menuShape();
    for (const label of ["Search", "Settings"]) {
      expect(tabMenu).not.toContain(label);
      expect(bodyMenu).not.toContain(label);
    }
    expect(bodyMenu).toContain("Find");
  });
});

// The tab menu holds fields and toggles, so it is a dialog; the body menu
// holds only actions, so it is a menu whose buttons are its items.
describe("the menus' roles", () => {
  test("the tab menu is a named dialog", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    const bubble = document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
    expect([bubble.getAttribute("role"), bubble.getAttribute("aria-label")]).toEqual([
      "dialog",
      "terminal tab settings",
    ]);
  });

  test("the body menu is a menu of menu items", async () => {
    const { target } = await attached();
    await openBodyMenu(target);
    const bubble = document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
    expect(bubble.getAttribute("role")).toBe("menu");
    const buttons = [...bubble.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter((b) => b.getAttribute("role") !== "menuitem").map((b) => b.textContent?.trim())).toEqual([]);
  });
});

test("the optional privacy override changes a running terminal and restores its choice", async () => {
  const { target } = await attached({ secret_masking: false });
  await openBodyMenu(target);
  expect(maskingLabel()).toBe("Secret masking: off");
  privacy.enabled = true;
  await tick();
  expect(maskingLabel()).toBe("Secret masking: off");
  privacy.mask_terminal_secrets = true;
  await tick();
  expect(maskingLabel()).toBe("Secret masking: on");
  privacy.enabled = false;
  await tick();
  expect(maskingLabel()).toBe("Secret masking: off");
});
