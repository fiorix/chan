// @vitest-environment jsdom

// The status pill watcher must never observe the document. When the watcher
// is attached (find bar or reload notice showing) under an output flood, a
// document-wide MutationObserver re-measures on every terminal frame, and
// each measure forces sync layout: the main thread never drains (check 211
// hung exactly so at the unscoped tip). Watching the app container's direct
// children plus the pill subtree removes the hazard: terminal output churns
// deep inside the workspace subtree and never fires either watch.
//
// The connection notice keeps its own pre-existing document-wide observer
// (TerminalConnectionNotice.svelte): it only schedules a frame, and 211 is
// green with it at base, so it stays out of this pin. The spy below is
// cleared right before the find bar opens so the calls it records belong to
// the bar's watcher alone.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import { ui } from "../state/store.svelte";
import { resetConnectionHealthForTests } from "../state/connectionHealth.svelte";
import {
  installTerminalDom,
  mountTerminal,
  resetTerminals,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

installTerminalDom();

beforeEach(() => {
  TerminalSocket.connecting = false;
  ui.terminalControl = false;
  resetConnectionHealthForTests();
});

afterEach(() => {
  ui.disconnectBlocking = false;
  ui.terminalControl = false;
  resetConnectionHealthForTests();
  resetTerminals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("status pill observation scope", () => {
  test("the find bar watches the status bar subtree, never the document", async () => {
    // The app container with the pill, as the app renders it: one div
    // carries both the statusbar class and the pill marker, a direct
    // child of the container, while terminal output churns deep inside
    // the workspace subtree.
    const app = document.createElement("div");
    app.className = "app";
    const bar = document.createElement("div");
    bar.className = "app-statusbar";
    bar.setAttribute("data-app-status-pill", "");
    app.append(bar);
    document.body.append(app);

    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    try {
      await mountTerminal(TerminalTab, terminalTab(), { focused: true });
      expect(document.querySelector(".terminal-find input")).toBeNull();

      // Only the bar's watcher may observe from here on: the connection
      // notice attached its own observer at mount, before this clear.
      observe.mockClear();
      window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.find.open" } }));
      await tick();
      await tick();

      expect(
        document.querySelector(".terminal-find input.find"),
        "the find bar opens so its pill watcher attaches",
      ).not.toBeNull();
      const targets = observe.mock.calls.map((call) => call[0] as Node);
      for (const target of targets) {
        expect(
          target === document || target === document.body || target === document.documentElement,
          `the bar watcher stays off the document (got ${(target as Element)?.nodeName})`,
        ).toBe(false);
      }
      expect(targets, "the watcher observes the app container for arrivals").toContain(app);
      expect(targets, "the watcher observes the pill subtree while present").toContain(bar);
    } finally {
      app.remove();
    }
  });
});
