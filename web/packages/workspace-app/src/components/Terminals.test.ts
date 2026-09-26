// @vitest-environment jsdom
//
// A terminal whose render throws is contained by its own boundary, which
// Terminals draws with the terminal, above the pane tree: the card lands in
// the pane that holds the terminal, where its body would be, names it, and
// closes it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./TerminalTab.svelte", () => ({
  default: function ThrowingTerminalTab() {
    throw new Error("terminal render blew up");
  },
}));

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { layout, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await unmountApp();
});

describe("a terminal whose render throws", () => {
  test("draws its failure card in its own pane and closes from it", async () => {
    resetLayout([terminalTab({ id: "broken", title: "broken" }), fileTab({ id: "notes", path: "notes.md" })]);
    await settle();

    const pane = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-pane-id="pane-test"]');
      expect(el?.textContent).toContain("This tab could not be drawn.");
      return el!;
    });
    expect(pane.textContent).toContain("terminal render blew up");

    const close = [...pane.querySelectorAll("button")].find((b) => b.textContent === "Close broken");
    expect(close, "the card closes the terminal it names").toBeDefined();
    close!.click();
    await settle();

    await vi.waitFor(() =>
      expect((layout.nodes["pane-test"] as LeafNode).tabs.map((tab) => tab.id)).toEqual(["notes"]),
    );
  });
});
