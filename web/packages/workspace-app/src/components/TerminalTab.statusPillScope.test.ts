// @vitest-environment jsdom

// The status pill watcher must never observe the document. Under an output
// flood (check 211 prints thousands of lines, then types into the find bar)
// a document-wide MutationObserver re-measures on every terminal frame and
// every find highlight restyle, and each measure forces sync layout plus a
// style write that refires the observer: the main thread never drains and
// CDP input dispatches time out. Scoping the observer to the always-mounted
// status bar subtree breaks the loop: terminal and find-bar writes land
// outside the watched subtree.
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
    // The always-mounted status bar with the pill, as the app renders it.
    const bar = document.createElement("div");
    bar.className = "app-statusbar";
    const pill = document.createElement("div");
    pill.setAttribute("data-app-status-pill", "");
    bar.append(pill);
    document.body.append(bar);

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
      expect(targets, "the bar watcher observes exactly one subtree").toHaveLength(1);
      expect(
        targets[0] === document || targets[0] === document.body || targets[0] === document.documentElement,
        `the bar watcher observes the status bar, not the document (got ${(targets[0] as Element)?.nodeName})`,
      ).toBe(false);
      expect(targets[0], "the bar watcher observes the status bar subtree").toBe(bar);
    } finally {
      bar.remove();
    }
  });
});
