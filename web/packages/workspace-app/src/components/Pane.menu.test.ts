// @vitest-environment jsdom
//
// A pane's hamburger menu opens with Commands and Hybrid Nav, then the Apps
// rows that spawn a tab, each running its command (New draft creates a draft
// and opens it). The pane's theme and side flip are not rows here, and there
// is no Settings row: those are commands of their own. When the server offers
// more than one shell, each is a row right under New terminal, in a workspace
// window and a terminal-only one alike, and picking one opens a terminal in
// that shell.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinks);

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { api } from "../api/client";
import type { TerminalShellsResponse } from "../api/types";
import { reloadShellProfiles } from "../state/shellProfiles.svelte";
import { ui } from "../state/store.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp();
  resetLayout([]);
  await settle();
});

afterEach(async () => {
  await unmountApp();
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

describe("the pane's hamburger menu", () => {
  test("opens with Commands and Hybrid Nav, then the Apps rows", async () => {
    const labels = rows(await openMenu());

    expect(labels.slice(0, 2)).toEqual(["Commands", "Hybrid Nav"]);
    expect(labels).toContain("New draft");
    expect(labels).toContain("New terminal");
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

    await vi.waitFor(() =>
      expect((layout.nodes["pane-test"] as LeafNode).tabs).toMatchObject([
        { kind: "file", path: expect.stringMatching(/^\.Drafts\/untitled-\d+\/draft\.md$/) },
      ]),
    );
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

  test("open a terminal in the shell picked", async () => {
    row(await openMenu(), "Bash").click();

    await vi.waitFor(() =>
      expect((layout.nodes["pane-test"] as LeafNode).tabs).toMatchObject([{ kind: "terminal", profile: "bash" }]),
    );
  });
});
