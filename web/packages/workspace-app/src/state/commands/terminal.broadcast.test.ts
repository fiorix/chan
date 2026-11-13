// @vitest-environment jsdom
//
// The terminal's two broadcast commands, over the tab state they share with
// the terminal's menu. Group broadcast reports the whole group. Broadcast
// targets is a choice with one option per terminal the focused one can
// broadcast to: itself, its group in this window, and the group's members in
// other windows, which flip through the server.

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../../api/client";
import { resetLayout, terminalTab } from "../../__tests__/tabs";
import { allCommands, commandContext, commandState, type Command } from "../commands";
import { applyTerminalRoster, type TerminalTab } from "../tabs.svelte";
import type { TerminalRosterEntry } from "../../api/types";
import "./install";

const TARGETS = "app.terminal.broadcastTargets";
const GROUP = "app.terminal.broadcastToggle";

function command(id: string): Command {
  const found = allCommands().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

/// Seat the tabs in one pane with `active` focused; returns the live copies.
function seat(tabs: TerminalTab[], active: string): TerminalTab[] {
  return resetLayout(tabs, { activeTabId: active }).tabs as TerminalTab[];
}

function member(id: string, over: Partial<TerminalRosterEntry> = {}): TerminalRosterEntry {
  return { id, tab_name: id, tab_group: "default", window_id: "far-window", window_live: true, broadcast: false, ...over };
}

function options(): Array<{ id: string; label: string; checked: boolean }> {
  return command(TARGETS).options!(commandContext()).map(({ id, label, checked }) => ({ id, label, checked }));
}

function choose(label: string): void | Promise<void> {
  const option = command(TARGETS).options!(commandContext()).find((candidate) => candidate.label === label);
  if (!option) throw new Error(`no option ${label}`);
  return option.run();
}

afterEach(() => {
  applyTerminalRoster([]);
  resetLayout();
  vi.restoreAllMocks();
});

describe("Broadcast targets", () => {
  test("is a choice, listed after Group broadcast, that opens on its options", () => {
    expect(command(TARGETS)).toMatchObject({
      title: "Broadcast targets",
      category: "Terminal",
      scope: "app",
      surface: "terminal",
      kind: "choice",
      requirement: "terminal",
    });
    expect(command(TARGETS).order).toBe(command(GROUP).order! + 1);
  });

  test("lists the focused terminal first, then its group in this window, then the members other windows hold", () => {
    seat(
      [
        terminalTab({ id: "build", title: "Build" }),
        terminalTab({ id: "logs", title: "Logs" }),
        terminalTab({ id: "ops", title: "Ops", group: "ops" }),
      ],
      "logs",
    );
    applyTerminalRoster([
      member("far", { tab_name: "Far", broadcast: true }),
      member("unnamed", { tab_name: null }),
      member("hidden", { window_live: false }),
      member("elsewhere", { tab_group: "ops" }),
    ]);

    expect(options()).toEqual([
      { id: "logs", label: "Logs (self)", checked: false },
      { id: "build", label: "Build", checked: false },
      { id: "far", label: "Far", checked: true },
      { id: "unnamed", label: "terminal", checked: false },
    ]);
    expect(commandState(TARGETS)).toBe("1 of 4");
  });

  test("an option flips its own terminal and no other", () => {
    const [build, logs] = seat(
      [terminalTab({ id: "build", title: "Build" }), terminalTab({ id: "logs", title: "Logs" })],
      "build",
    );

    void choose("Build (self)");
    expect([build!.broadcastEnabled, logs!.broadcastEnabled]).toEqual([true, false]);
    expect(commandState(TARGETS)).toBe("1 of 2");

    void choose("Logs");
    expect(options().map(({ checked }) => checked)).toEqual([true, true]);
    expect(commandState(GROUP), "every target on is the group on").toBe(true);

    void choose("Build (self)");
    expect(options()).toEqual([
      { id: "build", label: "Build (self)", checked: false },
      { id: "logs", label: "Logs", checked: true },
    ]);
    expect(commandState(GROUP)).toBe(false);
  });

  test("a member in another window flips through the server, to the other of what the roster says", async () => {
    const sent = vi.spyOn(api, "setTerminalSessionBroadcast").mockResolvedValue(undefined);
    seat([terminalTab({ id: "build", title: "Build" })], "build");
    applyTerminalRoster([member("far", { tab_name: "Far", broadcast: true }), member("near", { tab_name: "Near" })]);

    await choose("Far");
    await choose("Near");
    expect(sent.mock.calls).toEqual([
      ["far", false],
      ["near", true],
    ]);
  });

  test("offers nothing with no terminal focused", () => {
    resetLayout();
    expect(options()).toEqual([]);
    expect(commandState(TARGETS)).toBeNull();
  });
});

describe("Group broadcast", () => {
  test("reads on only once every target is on, a member in another window included", () => {
    seat(
      [
        terminalTab({ id: "build", title: "Build", broadcastEnabled: true, broadcastTargetIds: ["logs"] }),
        terminalTab({ id: "logs", title: "Logs", broadcastEnabled: true, broadcastTargetIds: ["build"] }),
      ],
      "build",
    );
    expect(commandState(GROUP)).toBe(true);

    applyTerminalRoster([member("far")]);
    expect(commandState(GROUP)).toBe(false);
    applyTerminalRoster([member("far", { broadcast: true })]);
    expect(commandState(GROUP)).toBe(true);
  });
});
