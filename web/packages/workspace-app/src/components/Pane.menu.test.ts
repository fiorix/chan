// @vitest-environment jsdom
//
// A pane's hamburger menu opens with Commands and Hybrid Nav, then the Apps
// rows that spawn a tab, each running its command (New draft creates a draft
// and opens it). The pane's theme and side flip are not rows here, and there
// is no Settings row: those are commands of their own.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinks);

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
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
