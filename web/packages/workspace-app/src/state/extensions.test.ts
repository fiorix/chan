// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import appRaw from "../App.svelte?raw";
import { allCommands } from "./commands";
import {
  isValidExtensionInfo,
  loadExtensions,
  markExtensionFrameReady,
  registerExtensionFrame,
} from "./extensions.svelte";
import { activePane, layout, type LeafNode } from "./tabs.svelte";

describe("local extensions", () => {
  const capability = "a".repeat(64);

  test("accepts only capability-scoped tenant entry paths", () => {
    expect(
      isValidExtensionInfo({
        id: "echo-test",
        name: "Echo",
        entry_path: `/_chan/extensions/echo-test/${capability}/`,
      }),
    ).toBe(true);

    for (const entry_path of [
      `http://127.0.0.1:48123/_chan/extensions/echo/${capability}/`,
      `//example.com/_chan/extensions/echo/${capability}/`,
      `/_chan/extensions/other/${capability}/`,
      "/_chan/extensions/echo/short/",
      `/_chan/extensions/echo/${capability}/?t=secret`,
      `/api/extensions/echo/${capability}/`,
    ]) {
      expect(
        isValidExtensionInfo({ id: "echo", name: "Echo", entry_path }),
      ).toBe(false);
    }
    expect(isValidExtensionInfo(null)).toBe(false);
    expect(isValidExtensionInfo({ id: "echo", name: "Echo" })).toBe(false);
    expect(
      isValidExtensionInfo({
        id: "echo",
        name: "Echo",
        entry_path: `/_chan/extensions/echo/${capability}/`,
        capabilities: ["workspace-files"],
      }),
    ).toBe(false);
    expect(
      isValidExtensionInfo({
        id: "echo",
        name: "Echo",
        entry_path: `/_chan/extensions/echo/${capability}/`,
        commands: [{ id: "Bad.Id", title: "Bad" }],
      }),
    ).toBe(false);
  });

  test("registers singleton commands and queues dispatch until frame readiness", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "extension-pane",
      tabs: [],
      activeTabId: null,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    vi.spyOn(api, "extensions").mockResolvedValue([
      {
        id: "echo",
        name: "Echo test",
        entry_path: `/_chan/extensions/echo/${capability}/`,
        singleton: true,
        commands: [
          { id: "say-hello", title: "Say hello", keywords: ["greet"] },
        ],
      },
    ]);

    await loadExtensions();
    const command = allCommands().find((entry) => entry.id === "extension.echo");
    expect(command?.category).toBe("Apps");
    command?.run();

    const tab = activePane().tabs[0];
    if (tab?.kind !== "extension") throw new Error("expected extension tab");
    expect(tab.extensionId).toBe("echo");
    expect(tab.title).toBe("Echo test");
    expect(JSON.stringify(tab)).not.toContain("secret");

    const declared = allCommands().find(
      (entry) => entry.id === "extension.echo.say-hello",
    );
    expect(declared?.keywords).toContain("greet");
    declared?.run();
    expect(activePane().tabs).toHaveLength(1);

    const posted: { id: string; requestId: string }[] = [];
    const unregister = registerExtensionFrame(tab.id, (message) => posted.push(message));
    expect(posted).toEqual([]);
    markExtensionFrameReady(tab.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.id).toBe("say-hello");
    unregister();

    expect(appRaw).toMatch(
      /commandName\.startsWith\("extension\."\)[\s\S]{0,300}allCommands\(\)[\s\S]{0,300}command\.run\(\)/,
    );
  });
});
