// @vitest-environment jsdom
//
// A terminal's two menus. The tab menu (from the tab strip) names and groups
// the terminal, shows its status and its broadcast list, and ends with the
// pane's flip and the tab's close. The body menu (a right-click in the
// terminal) shows the live engine and the secret-masking toggle, then Find,
// Copy, Paste and Copy scrollback, and ends with the command launcher, which
// opens from this terminal as its chord does. Every row that offers a catalog
// action takes its words from the catalog, and a toggle's row its check. A
// TerminalTab is mounted over the stand-in xterm and socket.

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
import { allCommands, commandContext, commandState } from "../state/commands";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { SHORTCUTS } from "../state/shortcuts";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { applyTerminalRoster, layout, selectTabInPane, type LeafNode } from "../state/tabs.svelte";
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
  applyTerminalRoster([]);
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

/// The catalog's title for `id`. An id nothing registers fails here, where
/// the component's own lookup would show the id in the title's place.
function title(id: string): string {
  const command = allCommands().find((candidate) => candidate.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command.title;
}

/// The shortcut table's name for an id the catalog does not hold.
function shortcutLabel(id: string): string {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id);
  if (!shortcut) throw new Error(`no shortcut ${id}`);
  return shortcut.label;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
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

/// Every piece of the open menu that shows words, top to bottom: the rows,
/// the field labels, the captions, the broadcast list and a prompt's
/// buttons. The status text and a prompt's sentence are left out: they
/// report the terminal, in words made for the moment.
function menuWords(): string[] {
  const menu = document.body.querySelector(".terminal-tab-menu-bubble")!;
  return [
    ...menu.querySelectorAll(
      [
        ".terminal-backend-label > span:first-child",
        ".mbtn-label",
        ".rename-label",
        ".env-stale-row button",
        ".broadcast-section-label",
        ".target-name",
        ".broadcast-other-windows-label",
      ].join(", "),
    ),
  ].map(text);
}

/// Whether the open menu's row for the toggle `id` is checked, read from
/// both the state it announces and the check it draws; null when the menu
/// has no such row.
function checked(id: string): boolean | null {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
    (button) => text(button.querySelector(".mbtn-label")) === title(id),
  );
  if (!row) return null;
  expect(row.getAttribute("role"), id).toBe("menuitemcheckbox");
  const announced = row.getAttribute("aria-checked") === "true";
  expect(row.querySelector(".mbtn-icon svg") !== null, `${id} draws its check`).toBe(announced);
  return announced;
}

const MASKING = "app.terminal.secretMasking.toggle";

function masking(): boolean | null {
  return checked(MASKING);
}

describe("the tab menu", () => {
  test("names and groups the terminal, then its status, and ends with the pane's flip and the tab's close", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    const shape = menuShape();

    expect(shape.slice(0, 3)).toEqual(["field Name", "field Group", "status connected: 80x24"]);
    expect(shape.slice(-3)).toEqual(["---", "Flip pane", "Close tab"]);
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

  test("Close tab asks about the live terminal, then closes this tab in its pane", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    menuRow(title("app.tab.close")).click();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await vi.waitFor(() => expect((layout.nodes[TERMINAL_PANE] as LeafNode).tabs).toEqual([]));
  });

  test("Flip pane turns this terminal's pane to its other side and closes the menu", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    menuRow(title("app.pane.flip")).click();
    await tick();
    expect((layout.nodes[TERMINAL_PANE] as LeafNode).side).toBe("b");
    expect(document.body.querySelector(".terminal-tab-menu-bubble")).toBeNull();
  });

  test("a tmux window's panes have no sides, so its tab menu ends with the close alone", async () => {
    const { tab, socket } = await attached();
    await receive(socket, { type: "session", id: "pane-1", generation: 2, seq: 0, tmux_pane: { connection: 2, pane: "%7" } });
    expect(tab.tmuxPane).toEqual({ connection: 2, pane: "%7" });
    await openTerminalMenu(tab);
    expect(menuShape().slice(-3)).toEqual([title("app.terminal.details"), "---", "Close tab"]);
  });
});

// Group broadcast describes the group across windows. A member whose window
// no page holds cannot act on a toggle routed to it, so the check leaves it
// out.
describe("the tab menu's Group broadcast", () => {
  const GROUP = "app.terminal.broadcastToggle";

  function member(name: string, live: boolean, broadcast: boolean): TerminalRosterEntry {
    return { id: `sess-${name}`, tab_name: name, tab_group: "default", window_id: `${name}-win`, window_live: live, broadcast };
  }

  /// This window's one terminal with broadcast on, the roster's members of
  /// its group in other windows, and what its tab menu then shows: whether
  /// the Group broadcast row is checked and the members it lists under other
  /// windows.
  async function groupBroadcast(members: TerminalRosterEntry[]): Promise<{ on: boolean | null; others: string[] }> {
    const [tab] = seatTerminals([terminalTab({ broadcastEnabled: true })]);
    await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    applyTerminalRoster(members);
    await openTerminalMenu(tab!);
    const others = [
      ...document.body.querySelectorAll(".terminal-tab-menu-bubble .broadcast-other-windows-label ~ .target-row .target-name"),
    ].map((el) => el.textContent?.trim() ?? "");
    return { on: checked(GROUP), others };
  }

  test("is checked once every member in a window a page holds is on", async () => {
    expect(await groupBroadcast([member("Live", true, true), member("Hidden", false, false)])).toEqual({
      on: true,
      others: ["Live"],
    });
  });

  test("is unchecked while a member in a window a page holds is off", async () => {
    expect(await groupBroadcast([member("Live", true, false), member("Hidden", false, true)])).toEqual({
      on: false,
      others: ["Live"],
    });
  });

  test("turns the whole group off when it is on, and its check follows", async () => {
    const [tab] = seatTerminals([terminalTab({ broadcastEnabled: true })]);
    await mountTerminal(TerminalTab, tab!);
    await attach(TerminalSocket.all.at(-1)!);
    await openTerminalMenu(tab!);
    const row = menuRow(title(GROUP));
    expect(checked(GROUP)).toBe(true);
    row.click();
    await tick();
    expect(tab!.broadcastEnabled).toBe(false);
    expect(checked(GROUP)).toBe(false);
  });
});

describe("the body menu", () => {
  test.each([
    [true, null, true],
    [true, { secret_masking: false }, false],
    [false, null, false],
  ] as const)("seeds masking in control mode %s with preference %s", async (terminalControl, prefs, on) => {
    ui.terminalControl = terminalControl;
    const { target } = await attached(prefs);
    await openBodyMenu(target);
    expect(masking()).toBe(on);
  });

  test("starts with the engine and masking, then Find, Copy, Paste and Copy scrollback", async () => {
    const { target } = await attached();
    await openBodyMenu(target);
    expect(menuShape()).toEqual([
      "engine xterm",
      "Secret masking (this terminal)",
      "---",
      "Find",
      "Copy",
      "Paste",
      "Copy scrollback",
      ...menuShape().slice(7),
    ]);
  });

  test("masking starts from the setting, and each new terminal reads it again", async () => {
    const first = await attached({ secret_masking: true });
    await openBodyMenu(first.target);
    expect(masking()).toBe(true);
    closeTabMenu();
    resetTerminals();

    const second = await attached({ secret_masking: false });
    await openBodyMenu(second.target);
    expect(masking()).toBe(false);
  });

  test("the toggle flips masking for this terminal only and saves nothing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { target } = await attached();
    await openBodyMenu(target);
    menuRow(title(MASKING)).click();
    await tick();
    await openBodyMenu(target);
    expect(masking()).toBe(true);

    closeTabMenu();
    allCommands().find((command) => command.id === MASKING)!.run();
    await tick();
    await openBodyMenu(target);
    expect(masking()).toBe(false);
    expect(setItem.mock.calls.filter(([key]) => /mask/i.test(String(key)))).toEqual([]);
  });

  test("the row leaves the keyboard on the terminal and the launcher's command leaves it alone", async () => {
    const { target, term } = await attached();
    await openBodyMenu(target);
    const focused = term.focusCount;
    menuRow(title(MASKING)).click();
    await tick();
    expect(term.focusCount, "the row hands the keyboard back").toBe(focused + 1);

    allCommands().find((command) => command.id === MASKING)!.run();
    await tick();
    expect(term.focusCount, "the command moves no focus").toBe(focused + 1);
  });
});

// The catalog reports what the row shows, so the launcher's row and the
// menu's cannot disagree.
describe("secret masking as the catalog reports it", () => {
  test("follows the row's toggle, the command's own and a second terminal's", async () => {
    const [first, second] = seatTerminals([terminalTab({ id: "term-1" }), terminalTab({ id: "term-2" })]);
    const { target } = await mountTerminal(TerminalTab, first!);
    await attach(TerminalSocket.all.at(-1)!);
    expect(commandState(MASKING)).toBe(false);

    await openBodyMenu(target);
    menuRow(title(MASKING)).click();
    await tick();
    expect([commandState(MASKING), first!.secretMasking]).toEqual([true, true]);
    expect(ui.status).toBe("Secret masking enabled for this terminal");

    // The other terminal keeps its own choice, and the command follows the
    // focused one.
    selectTabInPane(TERMINAL_PANE, second!.id);
    expect(commandState(MASKING)).toBe(false);
    selectTabInPane(TERMINAL_PANE, first!.id);
    expect(commandState(MASKING)).toBe(true);
  });

  test("reads on under Privacy mode's override, where choosing it changes nothing and says why", async () => {
    const { tab } = await attached({ secret_masking: false });
    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    expect(commandState(MASKING)).toBe(true);

    allCommands().find((command) => command.id === MASKING)!.run();
    expect(ui.status).toBe("Secret masking is enabled by Privacy mode");
    expect([commandState(MASKING), tab.secretMasking]).toEqual([true, false]);

    privacy.enabled = false;
    expect(commandState(MASKING)).toBe(false);
  });
});

describe("the body menu's launcher row", () => {
  const agents = {
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    linux: "Mozilla/5.0 (X11; Linux x86_64)",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  } as const;
  const LAUNCHER = shortcutLabel("app.launcher.toggle");

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
    expect(menuShape().slice(-2)).toEqual(["---", "Command launcher"]);
    expect(menuRow(LAUNCHER).querySelector(".mbtn-chord")?.textContent?.trim()).toBe(chord);
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
      const row = menuRow(LAUNCHER);
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
    for (const label of ["Search", title("app.search.toggle"), title("app.settings.open")]) {
      expect(tabMenu).not.toContain(label);
      expect(bodyMenu).not.toContain(label);
    }
    expect(bodyMenu).toContain(title("terminal.find"));
  });
});

// A menu belongs to one terminal, and its checks are that terminal's even
// while another tab holds the pane's focus, where the launcher's rows read
// the focused one.
describe("a menu's checks", () => {
  test("are its own terminal's while another terminal is the focused tab", async () => {
    const [mine, other] = seatTerminals([
      terminalTab({ id: "term-1", inspectorOpen: true, broadcastEnabled: true }),
      terminalTab({ id: "term-2", group: "ops" }),
    ]);
    await mountTerminal(TerminalTab, mine!, { active: false, focused: false });
    await attach(TerminalSocket.all.at(-1)!);
    selectTabInPane(TERMINAL_PANE, other!.id);
    expect(commandState("app.terminal.details"), "the focused terminal's Details is closed").toBe(false);

    await openTerminalMenu(mine!);
    expect([checked("app.terminal.details"), checked("app.terminal.broadcastToggle")]).toEqual([true, true]);
  });
});

// A row is held to where its words come from: the catalog command it runs,
// the shortcut table for the one id the catalog does not hold, or an
// exemption that says why the menu words the row itself.
type Source =
  | { command: string }
  | { shortcut: string }
  | { option: string; of: string }
  | { own: string; why: string };

function expected(sources: readonly Source[]): string[] {
  return sources.map((source) => {
    if ("command" in source) return title(source.command);
    if ("shortcut" in source) return shortcutLabel(source.shortcut);
    if ("own" in source) return source.own;
    const command = allCommands().find((candidate) => candidate.id === source.of);
    const option = command?.options?.(commandContext()).find((candidate) => candidate.label === source.option);
    if (!option) throw new Error(`${source.of} offers no ${source.option}`);
    return option.label;
  });
}

describe("every row takes its words from the catalog", () => {
  // The style toolbar's row joins the menu only while the Rich Prompt shows;
  // TerminalTab.richPrompt.test.ts holds it to its command there.
  test("the body menu", async () => {
    const { target } = await attached();
    await openBodyMenu(target);

    expect(menuWords()).toEqual(
      expected([
        { own: "Terminal engine", why: "a display row: the engine this terminal runs on, beside its value" },
        { command: "app.terminal.secretMasking.toggle" },
        { command: "terminal.find" },
        { command: "terminal.copy" },
        { command: "terminal.paste" },
        { command: "app.terminal.copyScrollback" },
        { command: "terminal.richPrompt" },
        { shortcut: "app.launcher.toggle" },
      ]),
    );
  });

  test("the tab menu", async () => {
    const [tab] = seatTerminals([
      terminalTab({ id: "term-1", title: "Worker" }),
      terminalTab({ id: "term-2", title: "Logs" }),
    ]);
    await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    socket.onopen?.();
    // A name the shell was not spawned under raises the stale-environment
    // prompt, and a member in another window fills the list's second part.
    await receive(socket, { type: "session", id: "sess-1", seq: 0, generation: 1, name: "Worker", group: "default", spawn_name: "Spawned", spawn_group: "default" });
    applyTerminalRoster([
      { id: "sess-far", tab_name: "Far", tab_group: "default", window_id: "far-win", window_live: true, broadcast: false },
    ]);
    await openTerminalMenu(tab!);

    expect(menuWords()).toEqual(
      expected([
        { own: "Name", why: "a field label over its input" },
        { own: "Group", why: "a field label over its input" },
        { command: "app.terminal.restart" },
        { own: "Later", why: "puts the stale-environment prompt away, which no command does" },
        { command: "app.terminal.broadcastTargets" },
        { command: "app.terminal.broadcastToggle" },
        { option: "Worker (self)", of: "app.terminal.broadcastTargets" },
        { option: "Logs", of: "app.terminal.broadcastTargets" },
        { own: "other windows", why: "a caption over the members other windows hold" },
        { option: "Far", of: "app.terminal.broadcastTargets" },
        { command: "app.terminal.details" },
        { command: "app.pane.flip" },
        { command: "app.tab.close" },
      ]),
    );
  });

  test("the broadcast list is the launcher's choice, row for row, with its checks", async () => {
    const [tab] = seatTerminals([
      terminalTab({ id: "term-1", title: "Worker", broadcastEnabled: true }),
      terminalTab({ id: "term-2", title: "Logs" }),
    ]);
    await mountTerminal(TerminalTab, tab!);
    await attach(TerminalSocket.all.at(-1)!);
    applyTerminalRoster([
      { id: "sess-far", tab_name: "Far", tab_group: "default", window_id: "far-win", window_live: true, broadcast: true },
    ]);
    await openTerminalMenu(tab!);

    const rows = [...document.body.querySelectorAll(".terminal-tab-menu-bubble .target-row")].map((row) => ({
      label: text(row.querySelector(".target-name")),
      checked: row.querySelector<HTMLInputElement>("input")!.checked,
    }));
    const options = allCommands()
      .find((command) => command.id === "app.terminal.broadcastTargets")!
      .options!(commandContext())
      .map(({ label, checked }) => ({ label, checked }));
    expect(rows).toEqual(options);
    expect(rows).toEqual([
      { label: "Worker (self)", checked: true },
      { label: "Logs", checked: false },
      { label: "Far", checked: true },
    ]);
  });
});

// The tab menu holds fields and the broadcast list's checkboxes, so it is a
// dialog, and its action rows are the items of menus inside it; the body menu
// holds only actions and toggles, so it is a menu whose buttons are its
// items. A menu item is one only inside a menu.
describe("the menus' roles", () => {
  /// The tab menu of a terminal with a peer in its window and a member of
  /// its group in another, so the broadcast list shows both of its parts.
  async function openFullTabMenu(): Promise<HTMLElement> {
    const [tab] = seatTerminals([
      terminalTab({ id: "term-1", title: "Worker" }),
      terminalTab({ id: "term-2", title: "Logs" }),
    ]);
    await mountTerminal(TerminalTab, tab!);
    await attach(TerminalSocket.all.at(-1)!);
    applyTerminalRoster([
      { id: "sess-far", tab_name: "Far", tab_group: "default", window_id: "far-win", window_live: true, broadcast: false },
    ]);
    await openTerminalMenu(tab!);
    return document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
  }

  test("the tab menu is a named dialog", async () => {
    const { tab } = await attached();
    await openTerminalMenu(tab);
    const bubble = document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
    expect([bubble.getAttribute("role"), bubble.getAttribute("aria-label")]).toEqual([
      "dialog",
      "terminal tab settings",
    ]);
  });

  test("the tab menu's action rows are menu items, a toggle's a checkbox, each inside a menu of the dialog", async () => {
    const bubble = await openFullTabMenu();
    const rows = [...bubble.querySelectorAll<HTMLButtonElement>("button.mbtn")].map((button) => ({
      label: text(button.querySelector(".mbtn-label")),
      role: button.getAttribute("role"),
      menu: button.closest('[role="menu"]')?.getAttribute("aria-label") ?? null,
    }));

    expect(rows).toEqual([
      { label: title("app.terminal.broadcastToggle"), role: "menuitemcheckbox", menu: title("app.terminal.broadcastTargets") },
      { label: title("app.terminal.details"), role: "menuitemcheckbox", menu: "terminal tab actions" },
      { label: title("app.pane.flip"), role: "menuitem", menu: "terminal tab actions" },
      { label: title("app.tab.close"), role: "menuitem", menu: "terminal tab actions" },
    ]);
  });

  test("a menu inside the dialog holds items and separators alone, and the fields and checkboxes stay the dialog's", async () => {
    const bubble = await openFullTabMenu();
    const menus = [...bubble.querySelectorAll<HTMLElement>('[role="menu"]')];

    expect(menus).toHaveLength(2);
    for (const menu of menus) {
      const held = [...menu.children].map((child) => child.getAttribute("role"));
      expect(held.filter((role) => !["menuitem", "menuitemcheckbox", "separator"].includes(role ?? "")), menu.getAttribute("aria-label") ?? "").toEqual([]);
      expect(menu.querySelectorAll("input"), "no field inside a menu").toHaveLength(0);
    }
    // Name, Group and the three broadcast targets, none of them in a menu.
    expect(bubble.querySelectorAll("input")).toHaveLength(5);
  });

  test("no menu item of either menu sits outside a menu", async () => {
    const { tab, target } = await attached();
    for (const open of [() => openTerminalMenu(tab), () => openBodyMenu(target)]) {
      await open();
      const bubble = document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
      const items = [...bubble.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')];
      expect(items.length).toBeGreaterThan(0);
      expect(items.filter((item) => item.closest('[role="menu"]') === null).map(text)).toEqual([]);
      closeTabMenu();
      await tick();
    }
  });

  test("the body menu is a menu of menu items, a toggle's a checkbox", async () => {
    const { target } = await attached();
    await openBodyMenu(target);
    const bubble = document.body.querySelector<HTMLElement>(".terminal-tab-menu-bubble")!;
    expect(bubble.getAttribute("role")).toBe("menu");
    const roles = [...bubble.querySelectorAll<HTMLButtonElement>("button")].map((button) => [
      text(button.querySelector(".mbtn-label")),
      button.getAttribute("role"),
    ]);
    expect(roles).toEqual([
      [title("app.terminal.secretMasking.toggle"), "menuitemcheckbox"],
      [title("terminal.find"), "menuitem"],
      [title("terminal.copy"), "menuitem"],
      [title("terminal.paste"), "menuitem"],
      [title("app.terminal.copyScrollback"), "menuitem"],
      [title("terminal.richPrompt"), "menuitemcheckbox"],
      [shortcutLabel("app.launcher.toggle"), "menuitem"],
    ]);
  });
});

test("the optional privacy override changes a running terminal and restores its choice", async () => {
  const { target } = await attached({ secret_masking: false });
  await openBodyMenu(target);
  expect(masking()).toBe(false);
  privacy.enabled = true;
  await tick();
  expect(masking()).toBe(false);
  privacy.mask_terminal_secrets = true;
  await tick();
  expect(masking()).toBe(true);
  privacy.enabled = false;
  await tick();
  expect(masking()).toBe(false);
});
