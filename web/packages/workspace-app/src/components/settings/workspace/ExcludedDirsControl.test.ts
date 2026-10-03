// @vitest-environment jsdom
//
// The workspace's excluded directory names: an edit is saved after a pause,
// and the answer to a save replaces the list only when no edit came after
// the save was sent. The control offers every directory the tree has loaded
// and refuses a `/` alone, saying why; a name that holds a `\` is the
// server's to take or refuse, and a refused one leaves the list for the field
// with the server's sentence. The api is mocked; the server's normalizing,
// its refusals and the re-walk a save starts are not exercised.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import ExcludedDirsControl from "./ExcludedDirsControl.svelte";
import { api } from "../../../api/client";
import { ApiError } from "../../../api/errors";
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

test("a directory whose name holds a backslash is offered like any other", async () => {
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

  expect(offered()).toEqual(["build", "src", "x\\y"]);
});

function field(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("input")!;
}

function saveLabel(): string | null {
  return document.querySelector(".save-status")?.textContent?.trim() ?? null;
}

function sent(put: { mock: { calls: Array<[string[]]> } }): string[][] {
  return put.mock.calls.map(([names]) => names);
}

/// Mount the control over a stored set, with each save answered by `answer`.
async function mounted(
  stored: string[],
  answer: (names: string[], call: number) => ExcludedDirsView | Error = (names) => view(names),
) {
  vi.useFakeTimers();
  vi.spyOn(api, "excludedDirs").mockResolvedValue(view(stored));
  let calls = 0;
  const put = vi.spyOn(api, "setExcludedDirs").mockImplementation(async (names) => {
    calls += 1;
    const result = answer([...names], calls);
    if (result instanceof Error) throw result;
    return result;
  });
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  return put;
}

/// Let the pause before a save pass, and the save's answer land.
async function saved(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
  flushSync();
}

test.each(["a/b", "a/b\\c"])("a name that holds a slash, %s, says why, is kept in the field and saves nothing", async (name) => {
  const put = await mounted([]);
  expect(refusal(), "nothing is refused before a name is typed").toBeNull();

  add(name);

  expect(refusal()).toBe("A name cannot hold /: the list takes directory names, not paths.");
  expect(field().value).toBe(name);
  expect(document.querySelector<HTMLButtonElement>(".add-btn")!.disabled).toBe(true);
  await saved();
  expect(put).not.toHaveBeenCalled();

  add("dist");
  expect(refusal(), "a name the list takes clears the refusal").toBeNull();
  expect(workspaceNames()).toEqual(["dist"]);
});

test("a typed name that holds a backslash is taken and sent", async () => {
  const put = await mounted([]);

  add("X\\y");

  expect(refusal()).toBeNull();
  expect(field().value).toBe("");
  expect(workspaceNames()).toEqual(["x\\y"]);
  await saved();
  expect(sent(put)).toEqual([["x\\y"]]);
  expect(saveLabel()).toBe("Saved");
});

// The sentence is the server's own and no pin holds its wording: the control
// shows what the rejected save carried.
const SENTENCE = "no directory here is named so; the server's words, whatever they are";
const SHOWN = "No directory here is named so; the server's words, whatever they are";

test("a name the server refuses leaves the list for the field, and the rest of the set is saved once", async () => {
  const put = await mounted(["dist"], (names, call) => (call === 1 ? new ApiError(400, SENTENCE) : view(names)));

  add("build");
  add("x\\y");
  expect(workspaceNames()).toEqual(["build", "dist", "x\\y"]);
  await saved();

  expect(refusal()).toBe(SHOWN);
  expect(workspaceNames(), "the refused name left the list").toEqual(["build", "dist"]);
  expect(field().value, "and is back in the field").toBe("x\\y");
  expect(sent(put), "the set is saved again without it").toEqual([["build", "dist", "x\\y"], ["build", "dist"]]);
  expect(saveLabel()).toBe("Saved");

  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows that one").toHaveBeenCalledTimes(2);
});

test("a refused name that was the only change sends no second save", async () => {
  const put = await mounted(["dist"], () => new ApiError(400, SENTENCE));

  add("x\\y");
  await saved();

  expect(refusal()).toBe(SHOWN);
  expect(workspaceNames()).toEqual(["dist"]);
  expect(field().value).toBe("x\\y");
  expect(saveLabel(), "the refusal is not a failed save").toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sent(put)).toEqual([["dist", "x\\y"]]);
});

test("the save after a refusal fails as any other save does", async () => {
  const put = await mounted(["dist"], (_names, call) => new ApiError(400, call === 1 ? SENTENCE : "second refusal"));

  add("build");
  add("x\\y");
  await saved();

  expect(refusal(), "the first refusal's sentence stands").toBe(SHOWN);
  expect(saveLabel()).toBe("Save failed: second refusal");
  expect(workspaceNames()).toEqual(["build", "dist"]);
  expect(field().value).toBe("x\\y");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put).toHaveBeenCalledTimes(2);
});

test("a refused name leaves a field its user is typing in as it is", async () => {
  await mounted(["dist"], () => new ApiError(400, SENTENCE));

  add("x\\y");
  field().value = "nod";
  field().dispatchEvent(new Event("input", { bubbles: true }));
  await saved();

  expect(refusal()).toBe(SHOWN);
  expect(workspaceNames()).toEqual(["dist"]);
  expect(field().value).toBe("nod");
});

test("two names the server may have refused both leave the list, and neither returns to the field", async () => {
  const put = await mounted(["dist"], (names, call) => (call === 1 ? new ApiError(400, SENTENCE) : view(names)));

  add("build");
  add("a\\b");
  add("c\\d");
  await saved();

  expect(refusal()).toBe(SHOWN);
  expect(workspaceNames()).toEqual(["build", "dist"]);
  expect(field().value).toBe("");
  expect(sent(put)).toEqual([["a\\b", "build", "c\\d", "dist"], ["build", "dist"]]);
});

test("the server's sentence goes with the next change to the list", async () => {
  await mounted(["dist"], (names, call) => (call === 1 ? new ApiError(400, SENTENCE) : view(names)));
  add("x\\y");
  await saved();
  expect(refusal()).toBe(SHOWN);

  add("build");

  expect(refusal()).toBeNull();
  expect(workspaceNames()).toEqual(["build", "dist"]);
});

test.each([
  ["a server error", new ApiError(500, "boom"), "boom"],
  ["a network error", new TypeError("Failed to fetch"), "Failed to fetch"],
] as const)("%s is a failed save: the list is kept, with a name that holds a backslash", async (_what, error, message) => {
  const put = await mounted(["dist"], () => error);

  add("x\\y");
  await saved();

  expect(saveLabel()).toBe(`Save failed: ${message}`);
  expect(refusal()).toBeNull();
  expect(workspaceNames()).toEqual(["dist", "x\\y"]);
  expect(field().value).toBe("");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put).toHaveBeenCalledTimes(1);
});

test("a 400 for a set the server has already taken every backslash name of is a failed save", async () => {
  const put = await mounted(["x\\y"], () => new ApiError(400, SENTENCE));

  add("build");
  await saved();

  expect(saveLabel()).toBe(`Save failed: ${SENTENCE}`);
  expect(refusal()).toBeNull();
  expect(workspaceNames()).toEqual(["build", "x\\y"]);
  expect(put).toHaveBeenCalledTimes(1);
});
