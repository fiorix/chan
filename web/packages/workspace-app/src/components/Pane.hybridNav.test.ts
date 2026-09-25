// @vitest-environment jsdom
//
// The pane names Hybrid Nav in title case wherever a user reads it: the
// hamburger's Hybrid Nav row, which enters it, and the preview each pane
// shows while it is on. No visible text or accessible name says "Pane Mode"
// or "Hybrid NAV".

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, resetLayout } from "../__tests__/tabs";
import { cancelPaneMode, paneMode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp();
  resetLayout([fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
});

afterEach(async () => {
  cancelPaneMode();
  await unmountApp();
});

/// Everything a user reads or hears: text, accessible names and tooltips.
function readable(): string {
  const names = [...document.querySelectorAll("[aria-label], [title]")].flatMap((el) => [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
  ]);
  return [document.body.textContent ?? "", ...names].join("\n");
}

describe("Hybrid Nav in the pane", () => {
  test("the hamburger's Hybrid Nav row enters it, and each pane shows the Hybrid Nav preview", async () => {
    document.querySelector<HTMLButtonElement>('.pane [aria-label="Menu"]')!.click();
    await settle();
    [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")]
      .find((button) => button.querySelector(".menu-row-label")?.textContent?.trim() === "Hybrid Nav")!
      .click();
    await settle();

    expect(paneMode.active).toBe(true);
    expect(document.querySelectorAll('[aria-label="Hybrid Nav preview"]')).toHaveLength(1);
  });

  test("no readable text says Pane Mode or Hybrid NAV, with the menu open or Hybrid Nav on", async () => {
    document.querySelector<HTMLButtonElement>('.pane [aria-label="Menu"]')!.click();
    await settle();
    expect(readable()).not.toMatch(/Pane Mode|Hybrid NAV/);

    press({ key: "Escape", code: "Escape" });
    press({ key: ".", code: "Period", ctrlKey: true });
    press({ key: "h", code: "KeyH" });
    await settle();
    expect(paneMode.active).toBe(true);
    expect(readable()).toContain("Hybrid Nav");
    expect(readable()).not.toMatch(/Pane Mode|Hybrid NAV/);
  });
});
