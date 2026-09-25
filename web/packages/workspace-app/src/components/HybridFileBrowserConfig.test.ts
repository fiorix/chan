// @vitest-environment jsdom
//
// The Hybrid File Browser back card is the shared shell and nothing else: its
// title and an OK that hands back to the pane. It renders no control and
// sends no request. The workspace's excluded directories live in Settings >
// This workspace: the editor loads the workspace's own names beside the
// machine-wide ones, takes a directory name (trimmed and lowercased, never a
// path, never one already excluded), suggests the workspace's folders, and
// saves the list shortly after each change.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import type { ExcludedDirsView } from "../api/types";
import { recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import { tree } from "../state/store.svelte";
import HybridFileBrowserConfig from "./HybridFileBrowserConfig.svelte";
import ExcludedDirsControl from "./settings/workspace/ExcludedDirsControl.svelte";

describe("the Hybrid File Browser back card", () => {
  afterEach(() => {
    stopRecordingRequests();
    document.body.innerHTML = "";
  });

  test("shows its title and no control, sends nothing, and hands back on OK", () => {
    const requests = recordRequests();
    const onDone = vi.fn();
    const target = document.createElement("div");
    document.body.append(target);
    const view = mount(HybridFileBrowserConfig, { target, props: { onDone } });
    try {
      flushSync();
      const card = target.querySelector<HTMLElement>('[aria-label="File Browser settings"]')!;
      expect(card.querySelector("h2")?.textContent).toBe("Hybrid File Browser");
      expect(card.querySelectorAll("input, select, textarea")).toHaveLength(0);

      card.querySelector<HTMLButtonElement>(".config-ok")!.click();
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([]);
    } finally {
      unmount(view);
    }
  });
});

describe("Settings > This workspace > Excluded directories", () => {
  let stored: ExcludedDirsView;
  let view: Record<string, unknown> | null = null;
  let target: HTMLElement;

  beforeEach(async () => {
    stored = { defaults: ["node_modules"], workspace: ["build"], effective: ["build", "node_modules"] };
    vi.spyOn(api, "excludedDirs").mockImplementation(async () => ({ ...stored }));
    vi.spyOn(api, "setExcludedDirs").mockImplementation(async (workspace) => {
      stored = { ...stored, workspace: [...workspace], effective: [...workspace, ...stored.defaults] };
      return { ...stored };
    });
    tree.entries = [
      { path: "Vendor", is_dir: true, size: 0, mtime: null },
      { path: "docs/Drafts", is_dir: true, size: 0, mtime: null },
      { path: "build", is_dir: true, size: 0, mtime: null },
      { path: "notes.md", is_dir: false, kind: "document", size: 1, mtime: null },
    ];
    target = document.createElement("div");
    document.body.append(target);
    view = mount(ExcludedDirsControl, { target });
    await vi.waitFor(() => expect(chips()).toEqual(["build"]));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (view) unmount(view);
    view = null;
    document.body.innerHTML = "";
    tree.entries = [];
    vi.restoreAllMocks();
  });

  function chips(): string[] {
    return [...target.querySelectorAll('[aria-label="Excluded directories for this workspace"] li')].map(
      (chip) => chip.textContent!.replace("×", "").trim(),
    );
  }

  function add(name: string): void {
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Add an excluded directory name"]')!;
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    flushSync();
  }

  test("shows the machine-wide names apart from the workspace's own", () => {
    expect(target.querySelector("details.defaults")?.textContent).toContain("node_modules");
    expect(chips()).toEqual(["build"]);
  });

  test("adds a name trimmed and lowercased, and saves the list", async () => {
    add("  Target ");

    expect(chips()).toEqual(["build", "target"]);
    await vi.waitFor(() => expect(api.setExcludedDirs).toHaveBeenCalledWith(["build", "target"]));
  });

  test("refuses a path, a name already excluded and a machine-wide one", () => {
    vi.useFakeTimers();
    add("docs/out");
    add("BUILD");
    add("node_modules");
    vi.runAllTimers();

    expect(chips()).toEqual(["build"]);
    expect(api.setExcludedDirs).not.toHaveBeenCalled();
  });

  test("removing a name saves the list without it", async () => {
    target.querySelector<HTMLButtonElement>('button[aria-label="Remove build"]')!.click();
    flushSync();

    await vi.waitFor(() => expect(api.setExcludedDirs).toHaveBeenCalledWith([]));
  });

  test("suggests the workspace's folder names that are not excluded yet", () => {
    const suggested = [...target.querySelectorAll("#settings-excluded-dir-suggestions option")].map((option) =>
      option.getAttribute("value"),
    );

    expect(suggested).toEqual(["drafts", "vendor"]);
  });
});
