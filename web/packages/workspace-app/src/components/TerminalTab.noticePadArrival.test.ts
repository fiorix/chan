// @vitest-environment jsdom

// The pill arrives and leaves while the notice stays up: the index pill
// mounts only while a rebuild runs, so a notice owed across the reload
// usually renders first with no pill, and the pill inserts later. The
// watcher must follow that arrival: unless it re-measures once the pill
// is in the tree, the pad never applies and the pill covers Dismiss
// (J127 leg 1: the centre click hit DIV.app-statusbar over the button).
//
// jsdom reports zero boxes, so this pins the arrival path, not the pad
// value: once the pill inserts into the app container, the watcher must
// track it (the size observer takes it as a target, which only happens
// inside measure after the pill is found).

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import { ui } from "../state/store.svelte";
import { resetConnectionHealthForTests } from "../state/connectionHealth.svelte";
import {
  installTerminalDom,
  mountTerminal,
  resetTerminals,
  resizeObservers,
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

describe("status pill arrival while the notice stays up", () => {
  test("a pill inserted after the notice starts being tracked", async () => {
    const app = document.createElement("div");
    app.className = "app";
    document.body.append(app);

    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    try {
      const tab = terminalTab();
      tab.cliReloadNotice = true;
      await mountTerminal(TerminalTab, tab, { focused: true });
      await tick();
      await tick();

      expect(
        document.querySelector(".cli-reload-notice"),
        "the notice renders so its pill watcher attaches",
      ).not.toBeNull();
      // The arrival watch is on from the start, even with no pill yet.
      expect(
        observe.mock.calls.some((call) => call[0] === app),
        "the watcher observes the app container for the pill's arrival",
      ).toBe(true);

      const pill = document.createElement("div");
      pill.className = "app-statusbar";
      pill.setAttribute("data-app-status-pill", "");
      pill.textContent = "rebuilding search index";
      app.append(pill);
      await vi.waitFor(() => {
        expect(
          resizeObservers.some((record) => record.targets.includes(pill)),
          "measure ran after the arrival and tracks the pill",
        ).toBe(true);
      });
      expect(
        observe.mock.calls.some((call) => call[0] === pill),
        "the watcher follows the pill subtree once it arrives",
      ).toBe(true);
    } finally {
      app.remove();
    }
  });
});
