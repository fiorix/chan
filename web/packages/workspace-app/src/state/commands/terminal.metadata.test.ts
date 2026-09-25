// @vitest-environment jsdom
//
// The terminal name and group commands propose metadata to the server, which
// owns it: each proposal carries the complete pair, so a group change keeps
// the terminal's live name and a name change keeps its group.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { allCommands } from "../commands";
import "./install";
import { promptState, resolvePrompt } from "../store.svelte";
import {
  layout,
  registerTerminalMetadataSink,
  type LeafNode,
  type TerminalTab,
} from "../tabs.svelte";

const PANE = "terminal-metadata-pane";
let proposals: Array<{ name: string; group: string | null }> = [];
let unregister = () => {};

function seatTerminal(): TerminalTab {
  const tab: TerminalTab = {
    kind: "terminal",
    id: "term-1",
    title: "worker",
    group: "build",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: "session-1",
  };
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  return (layout.nodes[PANE] as LeafNode).tabs[0] as TerminalTab;
}

async function run(id: string, answer: string | null): Promise<void> {
  const command = allCommands().find((c) => c.id === id);
  if (!command) throw new Error(`no command ${id}`);
  const done = Promise.resolve(command.run());
  await Promise.resolve();
  expect(promptState.open, "the command asks").toBe(true);
  resolvePrompt(answer);
  await done;
}

beforeEach(() => {
  proposals = [];
  unregister = registerTerminalMetadataSink("session-1", (proposal) => {
    proposals.push({ name: proposal.name, group: proposal.group ?? null });
    return true;
  });
});

afterEach(() => {
  unregister();
});

describe("the terminal metadata commands", () => {
  test("Set terminal group proposes the live name with the new group", async () => {
    seatTerminal();
    await run("app.terminal.setGroup", "ops");
    expect(proposals).toEqual([{ name: "worker", group: "ops" }]);
  });

  test("Set terminal name proposes the new name with the current group", async () => {
    seatTerminal();
    await run("app.terminal.setName", "deploy");
    expect(proposals).toEqual([{ name: "deploy", group: "build" }]);
  });

  test("a cancelled prompt proposes nothing", async () => {
    seatTerminal();
    await run("app.terminal.setGroup", null);
    expect(proposals).toEqual([]);
  });
});
