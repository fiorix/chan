// @vitest-environment jsdom
//
// The workspace's excluded directory names: an edit is saved after a pause,
// and the answer to a save replaces the list only when no edit came after
// the save was sent. The control offers no name it refuses, and a refusal
// says why. The api is mocked; the server's normalizing and the re-walk a
// save starts are not exercised.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import ExcludedDirsControl from "./ExcludedDirsControl.svelte";
import { api } from "../../../api/client";
import type { ExcludedDirsView } from "../../../api/types";
import { tree } from "../../../state/store.svelte";

let app: Record<string, unknown> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.replaceChildren();
  tree.entries = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function view(workspace: string[]): ExcludedDirsView {
  return { defaults: [".git"], workspace } as unknown as ExcludedDirsView;
}

function add(name: string): void {
  const input = document.querySelector<HTMLInputElement>("input")!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  flushSync();
}

function workspaceNames(): string[] {
  const list = document.querySelector('[aria-label="Excluded directories for this workspace"]')!;
  return [...list.querySelectorAll(".chip-name")].map((chip) => chip.textContent ?? "");
}

test("a name added while a save is in flight is kept and saved by the next save", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "excludedDirs").mockResolvedValue(view([]));
  const answers: Array<(v: ExcludedDirsView) => void> = [];
  const put = vi
    .spyOn(api, "setExcludedDirs")
    .mockImplementation(() => new Promise<ExcludedDirsView>((resolve) => answers.push(resolve)));
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);

  add("dist");
  await vi.advanceTimersByTimeAsync(600);
  expect(put.mock.calls.map(([names]) => names), "the first save").toEqual([["dist"]]);

  add("build");
  answers[0]!(view(["dist"]));
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(workspaceNames(), "the list keeps the name added in flight").toEqual(["build", "dist"]);

  await vi.advanceTimersByTimeAsync(600);
  expect(put.mock.calls.map(([names]) => names), "the second save carries both").toEqual([
    ["dist"],
    ["build", "dist"],
  ]);
});

function offered(): string[] {
  return [...document.querySelectorAll<HTMLOptionElement>("datalist option")].map((option) => option.value);
}

function refusal(): string | null {
  return document.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
}

test("a directory whose name holds a backslash is not offered, since the list refuses it", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "excludedDirs").mockResolvedValue(view([]));
  tree.entries = [
    { path: "src", is_dir: true, mtime: null, size: 0 },
    { path: "src/x\\y", is_dir: true, mtime: null, size: 0 },
    { path: "src/Build", is_dir: true, mtime: null, size: 0 },
    { path: "notes.md", is_dir: false, mtime: null, size: 1 },
  ];
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(offered()).toEqual(["build", "src"]);
});

test.each(["x\\y", "a/b"])("a refused name %s says why, is kept in the field and saves nothing", async (name) => {
  vi.useFakeTimers();
  vi.spyOn(api, "excludedDirs").mockResolvedValue(view([]));
  const put = vi.spyOn(api, "setExcludedDirs").mockResolvedValue(view([]));
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(refusal(), "nothing is refused before a name is typed").toBeNull();

  add(name);

  expect(refusal()).toBe("A name cannot hold / or \\: the list takes directory names, not paths.");
  expect(document.querySelector<HTMLInputElement>("input")!.value).toBe(name);
  expect(document.querySelector<HTMLButtonElement>(".add-btn")!.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(600);
  expect(put).not.toHaveBeenCalled();

  add("dist");
  expect(refusal(), "a name the list takes clears the refusal").toBeNull();
  expect(workspaceNames()).toEqual(["dist"]);
});
