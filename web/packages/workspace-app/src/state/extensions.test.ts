// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import { ApiError } from "../api/errors";
import appRaw from "../App.svelte?raw";
import extensionTabRaw from "../components/ExtensionTab.svelte?raw";
import { allCommands } from "./commands";
import {
  extensionFor,
  isValidExtensionInfo,
  loadExtensions,
  markExtensionFrameReady,
  refreshExtensions,
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

// A devserver restart re-mints every per-process entry capability; a
// surviving page must converge without a manual reload. The catalog
// re-resolves on watch reconnect (store.onWatchReady wiring is pinned in
// serverInstanceReload.test.ts) and mounted frames follow reactively.
describe("catalog refresh across a devserver restart", () => {
  const capA = "a".repeat(64);
  const capB = "b".repeat(64);
  const capC = "c".repeat(64);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("refresh rotates entry paths and drops vanished extensions", async () => {
    vi.spyOn(api, "extensions").mockResolvedValue([
      { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${capA}/` },
      { id: "gone", name: "Gone", entry_path: `/_chan/extensions/gone/${capA}/` },
    ]);
    await refreshExtensions();
    expect(extensionFor("echo")?.entry_path).toContain(capA);
    expect(extensionFor("gone")).toBeDefined();

    vi.spyOn(api, "extensions").mockResolvedValue([
      { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${capB}/` },
    ]);
    await refreshExtensions();
    // The rotated capability replaces the dead one; the vanished
    // extension resolves to undefined, which is exactly what drops its
    // mounted frame to ExtensionTab's unavailable state.
    expect(extensionFor("echo")?.entry_path).toContain(capB);
    expect(extensionFor("gone")).toBeUndefined();
  });

  test("singleton focus is unchanged across a refresh: run() focuses, never reopens", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "refresh-pane",
      tabs: [],
      activeTabId: null,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    vi.spyOn(api, "extensions").mockResolvedValue([
      {
        id: "echo",
        name: "Echo",
        entry_path: `/_chan/extensions/echo/${capA}/`,
        singleton: true,
      },
    ]);
    await refreshExtensions();
    allCommands()
      .find((entry) => entry.id === "extension.echo")
      ?.run();
    const tab = activePane().tabs[0];
    if (tab?.kind !== "extension") throw new Error("expected extension tab");

    vi.spyOn(api, "extensions").mockResolvedValue([
      {
        id: "echo",
        name: "Echo",
        entry_path: `/_chan/extensions/echo/${capB}/`,
        singleton: true,
      },
    ]);
    await refreshExtensions();
    allCommands()
      .find((entry) => entry.id === "extension.echo")
      ?.run();
    // Reconciliation happens on reconnect, not on focus: the existing
    // tab is focused, no second tab appears.
    expect(activePane().tabs).toHaveLength(1);
    expect(activePane().tabs[0]?.id).toBe(tab.id);
  });

  test("a transient refresh failure retries, then lands the fresh catalog", async () => {
    vi.useFakeTimers();
    const extensions = vi
      .spyOn(api, "extensions")
      .mockRejectedValueOnce(new ApiError(503, "unavailable"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([
        { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${capC}/` },
      ]);
    const promise = refreshExtensions();
    await vi.runAllTimersAsync();
    await promise;
    expect(extensions).toHaveBeenCalledTimes(3);
    expect(extensionFor("echo")?.entry_path).toContain(capC);
  });

  test("a persistent failure retains the current catalog (stale beats empty)", async () => {
    const extensions = vi.spyOn(api, "extensions").mockResolvedValue([
      { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${capC}/` },
    ]);
    await refreshExtensions();

    vi.useFakeTimers();
    extensions.mockClear().mockRejectedValue(new ApiError(502, "bad gateway"));
    const promise = refreshExtensions();
    await vi.runAllTimersAsync();
    await promise;
    expect(extensions).toHaveBeenCalledTimes(5);
    expect(extensionFor("echo")?.entry_path).toContain(capC);
  });

  test("a non-transient failure gives up immediately and retains the catalog", async () => {
    const extensions = vi.spyOn(api, "extensions").mockResolvedValue([
      { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${capC}/` },
    ]);
    await refreshExtensions();

    extensions.mockClear().mockRejectedValue(new ApiError(404, "not found"));
    await refreshExtensions();
    expect(extensions).toHaveBeenCalledTimes(1);
    expect(extensionFor("echo")?.entry_path).toContain(capC);
  });

  test("concurrent refresh calls coalesce into one resolve", async () => {
    const extensions = vi.spyOn(api, "extensions").mockResolvedValue([
      { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${capA}/` },
    ]);
    const first = refreshExtensions();
    const second = refreshExtensions();
    expect(second).toBe(first);
    await first;
    expect(extensions).toHaveBeenCalledTimes(1);
  });

  test("ExtensionTab's frame src tracks the live catalog, with the unavailable fallthrough", () => {
    expect(extensionTabRaw).toContain(
      "const extension = $derived(extensionFor(tab.extensionId));",
    );
    expect(extensionTabRaw).toContain(
      "const frameSrc = $derived(extension ? apiPath(extension.entry_path) : undefined);",
    );
    expect(extensionTabRaw).toMatch(
      /\{#if extension\}[\s\S]{1,600}<iframe[\s\S]{1,300}src=\{frameSrc\}[\s\S]{1,600}\{:else\}[\s\S]{1,500}is unavailable\./,
    );
  });
});
