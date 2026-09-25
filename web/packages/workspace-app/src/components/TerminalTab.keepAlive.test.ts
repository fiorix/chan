// @vitest-environment jsdom
//
// Hybrid Nav never unmounts a terminal: that would dispose its xterm and drop
// the scrollback. While Hybrid Nav is on, the terminal stays mounted and is
// hidden from assistive tech, and when it ends the same terminal is active
// again. A terminal on a pane's hidden side is hidden the same way.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { FakeTerminal } from "../__tests__/xterm";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { cancelPaneMode, flipHybrid } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  cancelPaneMode();
  vi.restoreAllMocks();
  await unmountApp();
});

function terminal(): HTMLElement {
  return document.querySelector<HTMLElement>(".terminal-tab")!;
}

describe("a terminal tab", () => {
  test("stays mounted through Hybrid Nav, hidden while it is on", async () => {
    resetLayout([terminalTab({ id: "term" })]);
    await settle();
    await vi.waitFor(() => expect(terminal()).not.toBeNull());
    const mounted = terminal();
    const dispose = vi.spyOn(FakeTerminal.prototype, "dispose");
    expect(mounted.getAttribute("aria-hidden")).toBe("false");

    press({ key: ".", code: "Period", ctrlKey: true });
    await settle();
    expect(terminal()).toBe(mounted);
    expect(mounted.getAttribute("aria-hidden")).toBe("true");
    expect(mounted.classList.contains("active")).toBe(false);

    press({ key: "Escape", code: "Escape" });
    await settle();
    expect(terminal()).toBe(mounted);
    expect(mounted.getAttribute("aria-hidden")).toBe("false");
    expect(dispose).not.toHaveBeenCalled();
  });

  test("is hidden on the pane's hidden side", async () => {
    resetLayout([terminalTab({ id: "term" })]);
    await settle();
    await vi.waitFor(() => expect(terminal()).not.toBeNull());

    flipHybrid("pane-test");
    await settle();

    expect(terminal().getAttribute("aria-hidden")).toBe("true");
  });
});
