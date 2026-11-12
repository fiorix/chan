// @vitest-environment jsdom
//
// A pane's hamburger menu opens with Command launcher, Hybrid Nav and Search workspace,
// then the Apps rows that spawn a tab, each running its command (New draft creates a draft
// and opens it). The pane's theme and side flip are not rows here, and there
// is no Settings row: those are commands of their own. When the server offers
// more than one shell, each is a row right under New terminal, in a workspace
// window and a terminal-only one alike, and picking one opens a terminal in
// that shell. Every row takes its words from the catalog: a spawner, Hybrid
// Nav, Search workspace and Close pane from their commands, a focus colour
// and a shell from the options of the choices that list them in the
// launcher, and the launcher's own row from the shortcut table.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { expectWords, type WordSource } from "../__tests__/menuWords";
import { resetLayout } from "../__tests__/tabs";
import { api } from "../api/client";
import type { TerminalShellsResponse } from "../api/types";
import { draftServerPath } from "../__tests__/drafts";
import { reloadShellProfiles } from "../state/shellProfiles.svelte";
import { searchPanel, ui } from "../state/store.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp();
  resetLayout([]);
  await settle();
});

afterEach(async () => {
  await unmountApp();
  ui.terminalOnly = false;
  vi.restoreAllMocks();
});

async function openMenu(): Promise<HTMLElement> {
  document.querySelector<HTMLButtonElement>('.pane [aria-label="Menu"]')!.click();
  await settle();
  return document.querySelector<HTMLElement>(".hamburger-menu")!;
}

function rows(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll(".menu-row-label")].map((label) => label.textContent!.trim());
}

function row(menu: HTMLElement, label: string): HTMLButtonElement {
  return [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.querySelector(".menu-row-label")?.textContent?.trim() === label,
  )!;
}

/// The words of every line the menu draws, separators aside: a row's label,
/// the colour section's heading, and a colour row's name.
function everyLabel(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll("li:not(.sep)")].map((line) => {
    const words =
      line.querySelector(".menu-row-label") ??
      line.querySelector("span:not(.color-dot):not(.menu-row-chord)");
    return words?.textContent?.trim() ?? "";
  });
}

const SPAWNERS: WordSource[] = [
  { command: "app.dashboard.open" },
  { command: "app.diagram.new" },
  { command: "app.draft.new" },
  { command: "app.files.toggle" },
  { command: "app.graph.toggle" },
  { command: "app.slides.new" },
  { command: "app.terminal.teamWork" },
  { command: "app.terminal.toggle" },
];

const COLOURS: WordSource[] = [
  { command: "app.pane.focusColor" },
  { choice: "app.pane.focusColor", option: "blue" },
  { choice: "app.pane.focusColor", option: "orange" },
  { choice: "app.pane.focusColor", option: "green" },
  { choice: "app.pane.focusColor", option: "pink" },
  { choice: "app.pane.focusColor", option: "grey" },
];

describe("the pane's hamburger menu", () => {
  test.each([false, true])("New dashboard opens a tab with terminal-only mode %s", async (terminalOnly) => {
    ui.terminalOnly = terminalOnly;
    const menu = await openMenu();
    expect(rows(menu)).toContain("New dashboard");
    row(menu, "New dashboard").click();
    await settle();
    const pane = layout.nodes["pane-test"] as LeafNode;
    expect(pane.tabs).toMatchObject([{ kind: "dashboard", carouselSlide: 3 }]);
    expect(pane.activeTabId).toBe(pane.tabs[0]!.id);
  });

  test("the command launcher offers and opens Dashboard in a terminal-only window", async () => {
    ui.terminalOnly = true;
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k", code: "KeyK", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    }));
    await settle();
    const input = document.querySelector<HTMLInputElement>(".deck-input");
    expect(input).not.toBeNull();
    input!.value = "New dashboard";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    const command = [...document.querySelectorAll<HTMLButtonElement>(".deck-result")]
      .find((button) => button.querySelector(".deck-result-title")?.textContent === "New dashboard");
    expect(command).toBeDefined();
    command!.click();
    await settle();
    expect((layout.nodes["pane-test"] as LeafNode).tabs).toMatchObject([{ kind: "dashboard", carouselSlide: 3 }]);
  });

  test("opens with Command launcher, Hybrid Nav and Search workspace, then the Apps rows", async () => {
    const labels = rows(await openMenu());

    expect(labels.slice(0, 3)).toEqual(["Command launcher", "Hybrid Nav", "Search workspace"]);
    expect(labels).toContain("New draft");
    expect(labels).toContain("New terminal");
  });

  test("words every row by the catalog", async () => {
    expectWords(everyLabel(await openMenu()), [
      { shortcut: "app.launcher.toggle" },
      { command: "app.pane.mode" },
      { command: "app.search.toggle" },
      ...SPAWNERS,
      ...COLOURS,
      { command: "app.pane.kill" },
    ]);
  });

  test("checks the window's focus colour, as the launcher's choice does", async () => {
    const menu = await openMenu();
    const checked = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .filter((button) => button.getAttribute("aria-checked") === "true")
      .map((button) => button.textContent?.trim());

    expect(checked).toEqual([layout.focusColor]);
  });

  test("Search workspace opens search and closes the menu", async () => {
    searchPanel.open = false;
    row(await openMenu(), "Search workspace").click();
    await settle();

    expect(searchPanel.open).toBe(true);
    expect(document.querySelector(".hamburger-menu")).toBeNull();
  });

  test("carries no New Draft grid row, no theme or flip row, and no Settings row", async () => {
    const labels = rows(await openMenu());

    for (const gone of ["New Draft", "Light mode", "Dark mode", "Flip pane", "Settings"]) {
      expect(labels).not.toContain(gone);
    }
  });

  test("New draft creates a draft and opens it in the pane", async () => {
    const menu = await openMenu();
    [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.querySelector(".menu-row-label")?.textContent?.trim() === "New draft")!
      .click();

    await vi.waitFor(() => {
      const tabs = (layout.nodes["pane-test"] as LeafNode).tabs;
      expect(tabs).toMatchObject([{ kind: "file" }]);
      expect(draftServerPath((tabs[0] as { path: string }).path)).toEqual(
        expect.stringMatching(/^untitled-\d+\/draft\.md$/),
      );
    });
  });
});

describe("New terminal's shell rows", () => {
  const shells: TerminalShellsResponse = {
    profiles: [
      { id: "bash", name: "Bash", program: "/bin/bash", kind: "posix", source: "discovered" },
      { id: "zsh", name: "Zsh", program: "/usr/bin/zsh", kind: "posix", source: "user" },
    ],
    default_profile: "zsh",
  };

  async function offerShells(response: TerminalShellsResponse): Promise<void> {
    vi.spyOn(api, "terminalShells").mockResolvedValue(response);
    await reloadShellProfiles();
    vi.restoreAllMocks();
  }

  beforeEach(() => offerShells(shells));

  afterEach(async () => {
    ui.terminalOnly = false;
    await offerShells({ profiles: [], default_profile: null });
  });

  function underNewTerminal(labels: string[]): string[] {
    const at = labels.indexOf("New terminal");
    return labels.slice(at + 1, at + 3);
  }

  test("list each shell under New terminal in a workspace window, marking the default", async () => {
    const menu = await openMenu();

    expect(underNewTerminal(rows(menu))).toEqual(["Bash", "Zsh"]);
    expect(row(menu, "Zsh").querySelector(".menu-row-chord")?.textContent).toBe("default");
    expect(row(menu, "Bash").querySelector(".menu-row-chord")).toBeNull();
  });

  test("list each shell under New terminal in a terminal-only window", async () => {
    ui.terminalOnly = true;
    await settle();

    expect(underNewTerminal(rows(await openMenu()))).toEqual(["Bash", "Zsh"]);
  });

  test("word each shell by an option of New terminal with profile", async () => {
    const labels = everyLabel(await openMenu());
    const at = labels.indexOf("New terminal");

    expectWords(labels.slice(at + 1, at + 3), [
      { choice: "app.terminal.profile", option: "bash" },
      { choice: "app.terminal.profile", option: "zsh" },
    ]);
  });

  test("open a terminal in the shell picked", async () => {
    row(await openMenu(), "Bash").click();

    await vi.waitFor(() =>
      expect((layout.nodes["pane-test"] as LeafNode).tabs).toMatchObject([{ kind: "terminal", profile: "bash" }]),
    );
  });
});
