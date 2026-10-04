// @vitest-environment jsdom
//
// The workspace's excluded directory names: an edit is saved after a pause,
// and the answer to a save replaces the list only when no edit came after
// the save was sent, while it is the server's set either way. One save is on
// the wire at a time: a pause that ends meanwhile waits for the answer. The
// control offers the directories the tree has loaded that it does not list,
// folds a name as the server does, its ASCII letters alone, and refuses a `/`
// alone, saying why; a name that holds a `\` is the server's to take or
// refuse, and a refused one leaves the list for the field with the server's
// sentence. The api is mocked; the server's normalizing, its refusals and the
// re-walk a save starts are not exercised.

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

/// The names the list shows; an empty list renders no chips at all.
function workspaceNames(): string[] {
  const list = document.querySelector('[aria-label="Excluded directories for this workspace"]');
  return [...(list?.querySelectorAll(".chip-name") ?? [])].map((chip) => chip.textContent ?? "");
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

test("a directory is offered with the ASCII letters of its name folded and no other", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "excludedDirs").mockResolvedValue(view([]));
  tree.entries = [{ path: "src/\u00C9p\u00E9E\\X", is_dir: true, mtime: null, size: 0 }];
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(offered(), "the server finds a directory by its name with ASCII case ignored").toEqual([
    "\u00C9p\u00E9e\\x",
  ]);
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

/// Mount the control over a stored set, with each save left on the wire until
/// the case answers or fails it.
async function held(stored: string[]) {
  vi.useFakeTimers();
  vi.spyOn(api, "excludedDirs").mockResolvedValue(view(stored));
  const saves: Array<{ answer: (v: ExcludedDirsView) => void; fail: (e: Error) => void }> = [];
  const put = vi
    .spyOn(api, "setExcludedDirs")
    .mockImplementation(() => new Promise<ExcludedDirsView>((answer, fail) => saves.push({ answer, fail })));
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  return { put, saves };
}

/// Let what the case has just answered or failed reach the control.
async function landed(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
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

test("a typed name is sent with its ASCII letters folded and the others as typed", async () => {
  const put = await mounted([]);

  add("\u00C9P\u00C9E");
  await saved();

  expect(sent(put), "the walk matches a stored name with ASCII case ignored").toEqual([["\u00C9p\u00C9e"]]);
  expect(workspaceNames()).toEqual(["\u00C9p\u00C9e"]);
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

test.each([
  ["a name added", () => add("build"), ["build", "dist", "src"]],
  ["a name removed", () => document.querySelector<HTMLButtonElement>('[aria-label="Remove dist"]')!.click(), ["src"]],
] as const)("the server's sentence goes with the next change to the list: %s", async (_what, change, names) => {
  await mounted(["dist", "src"], (sent, call) => (call === 1 ? new ApiError(400, SENTENCE) : view(sent)));
  add("x\\y");
  await saved();
  expect(refusal()).toBe(SHOWN);

  change();
  flushSync();

  expect(refusal()).toBeNull();
  expect(workspaceNames()).toEqual(names);
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

test("a refusal after an answer an edit overtook takes back only the name the server does not hold", async () => {
  const { put, saves } = await held([]);

  add("a\\b");
  await saved();
  add("c\\d");
  saves[0]!.answer(view(["a\\b"]));
  await saved();
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(sent(put), "the two saves").toEqual([["a\\b"], ["a\\b", "c\\d"]]);
  expect(workspaceNames(), "the name the server holds stays listed").toEqual(["a\\b"]);
  expect(field().value, "the name it refused is back in the field").toBe("c\\d");
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel(), "the list is the server's set, so nothing is saved").toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("the set left after a refusal is saved when it differs from an answer an edit overtook", async () => {
  const { put, saves } = await held(["dist"]);

  document.querySelector<HTMLButtonElement>('[aria-label="Remove dist"]')!.click();
  flushSync();
  await saved();
  add("dist");
  add("x\\y");
  saves[0]!.answer(view([]));
  await saved();
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(sent(put), "the server holds nothing, so the name left is saved").toEqual([[], ["dist", "x\\y"], ["dist"]]);
  saves[2]!.answer(view(["dist"]));
  await landed();
  expect(workspaceNames()).toEqual(["dist"]);
  expect(field().value).toBe("x\\y");
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel()).toBe("Saved");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows that one").toHaveBeenCalledTimes(3);
});

test("a save that failed under a later edit may have landed, so the set left after a refusal is saved", async () => {
  const { put, saves } = await held([]);

  add("a\\b");
  await saved();
  add("c\\d");
  saves[0]!.fail(new TypeError("Failed to fetch"));
  await saved();
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(sent(put), "the empty set is saved over whatever the first save left").toEqual([
    ["a\\b"],
    ["a\\b", "c\\d"],
    [],
  ]);
  saves[2]!.answer(view([]));
  await landed();
  expect(workspaceNames()).toEqual([]);
  expect(field().value, "two names left, so neither returns").toBe("");
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel()).toBe("Saved");

  add("e\\f");
  await saved();
  saves[3]!.fail(new ApiError(400, SENTENCE));
  await landed();
  expect(field().value).toBe("e\\f");
  expect(saveLabel(), "the server has answered since, so its set is known again").toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and a refusal after that answer saves nothing").toHaveBeenCalledTimes(4);
});

test("a failed save that is shown may have landed too, so the set left after a refusal is saved", async () => {
  const { put, saves } = await held([]);

  add("a\\b");
  await saved();
  saves[0]!.fail(new ApiError(504, "gateway timeout"));
  await landed();
  expect(saveLabel()).toBe("Save failed: gateway timeout");
  expect(workspaceNames()).toEqual(["a\\b"]);

  add("c\\d");
  await saved();
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(sent(put), "the empty set is saved over whatever the failed save left").toEqual([
    ["a\\b"],
    ["a\\b", "c\\d"],
    [],
  ]);
  saves[2]!.answer(view([]));
  await landed();
  expect(workspaceNames()).toEqual([]);
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel()).toBe("Saved");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows that one").toHaveBeenCalledTimes(3);
});

test("a save waits for the answer to the one on the wire, and a refusal after it reads that answer", async () => {
  const { put, saves } = await held([]);

  add("a\\b");
  await saved();
  add("c\\d");
  await saved();
  expect(sent(put), "the second save waits").toEqual([["a\\b"]]);

  saves[0]!.answer(view(["a\\b"]));
  await landed();
  expect(sent(put), "and goes out when the first is answered").toEqual([["a\\b"], ["a\\b", "c\\d"]]);
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(workspaceNames(), "the name the server holds stays listed").toEqual(["a\\b"]);
  expect(field().value).toBe("c\\d");
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel()).toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("a save that waits shows Saving until the last answer lands, and the list is the last set sent", async () => {
  const { put, saves } = await held([]);

  add("build");
  await saved();
  document.querySelector<HTMLButtonElement>('[aria-label="Remove build"]')!.click();
  flushSync();
  add("dist");
  await saved();
  expect(sent(put), "the second save waits").toEqual([["build"]]);
  expect(saveLabel()).toBe("Saving...");

  saves[0]!.answer(view(["build"]));
  await landed();
  expect(workspaceNames(), "an answer an edit overtook leaves the list alone").toEqual(["dist"]);
  expect(sent(put), "and the save that waited goes out").toEqual([["build"], ["dist"]]);
  expect(saveLabel(), "one label for both saves").toBe("Saving...");

  saves[1]!.answer(view(["dist"]));
  await landed();
  expect(workspaceNames()).toEqual(["dist"]);
  expect(saveLabel()).toBe("Saved");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("a save that waited goes out at the end of a pause still running, once", async () => {
  const { put, saves } = await held([]);

  add("build");
  await saved();
  add("dist");
  await saved();
  add("src");
  saves[0]!.answer(view(["build"]));
  await landed();
  expect(sent(put), "nothing is sent inside the pause").toEqual([["build"]]);

  await saved();
  expect(sent(put), "the pause's end sends the list as it stands").toEqual([["build"], ["build", "dist", "src"]]);
  saves[1]!.answer(view(["build", "dist", "src"]));
  await landed();
  expect(saveLabel()).toBe("Saved");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and that set is sent once").toHaveBeenCalledTimes(2);
});

test("a save that waits goes out when the answer lands, though the control has unmounted", async () => {
  const { put, saves } = await held([]);

  add("build");
  await saved();
  add("dist");
  await saved();
  expect(sent(put), "the second save waits").toEqual([["build"]]);

  unmount(app!);
  app = null;
  saves[0]!.answer(view(["build"]));
  await landed();
  expect(sent(put), "the save that waited is owed, so the last set sent holds both names").toEqual([
    ["build"],
    ["build", "dist"],
  ]);
  saves[1]!.answer(view(["build", "dist"]));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("a save that waits goes out at the answer though the unmount ended a later pause", async () => {
  const { put, saves } = await held([]);

  add("build");
  await saved();
  add("dist");
  await saved();
  add("src");
  unmount(app!);
  app = null;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sent(put), "the pause the unmount ended sends nothing").toEqual([["build"]]);

  saves[0]!.answer(view(["build"]));
  await landed();
  expect(sent(put), "the owed save carries the list as it stood at the unmount").toEqual([
    ["build"],
    ["build", "dist", "src"],
  ]);
  saves[1]!.answer(view(["build", "dist", "src"]));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("the unmount ends a pause still running, and the edit made inside it is not sent", async () => {
  const { put } = await held([]);

  add("build");
  unmount(app!);
  app = null;
  await vi.advanceTimersByTimeAsync(5_000);

  expect(sent(put), "no save is owed before a pause has ended").toEqual([]);
});

test("an edit inside a pause at the unmount is not sent when a save on the wire is answered", async () => {
  const { put, saves } = await held([]);

  add("build");
  await saved();
  add("dist");
  unmount(app!);
  app = null;
  saves[0]!.answer(view(["build"]));
  await vi.advanceTimersByTimeAsync(5_000);

  expect(sent(put), "only a save whose pause had ended is owed").toEqual([["build"]]);
});

test("a refusal an edit overtook stores nothing, so a later refusal saves no set the server holds", async () => {
  const { put, saves } = await held(["dist"]);

  add("a\\b");
  await saved();
  add("c\\d");
  saves[0]!.fail(new ApiError(400, SENTENCE));
  await saved();
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(sent(put), "the set left is the server's after an overtaken refusal, so it is not saved").toEqual([
    ["a\\b", "dist"],
    ["a\\b", "c\\d", "dist"],
  ]);
  expect(workspaceNames()).toEqual(["dist"]);
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel(), "nothing is being saved").toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("a refusal shown as a failed save stores nothing either, so a later refusal saves no set the server holds", async () => {
  const { put, saves } = await held(["x\\y"]);

  add("build");
  await saved();
  saves[0]!.fail(new ApiError(400, SENTENCE));
  await landed();
  expect(saveLabel()).toBe(`Save failed: ${SENTENCE}`);

  document.querySelector<HTMLButtonElement>('[aria-label="Remove build"]')!.click();
  flushSync();
  add("c\\d");
  await saved();
  saves[1]!.fail(new ApiError(400, SENTENCE));
  await landed();

  expect(sent(put), "the set left is the server's after a shown refusal, so it is not saved").toEqual([
    ["build", "x\\y"],
    ["c\\d", "x\\y"],
  ]);
  expect(workspaceNames()).toEqual(["x\\y"]);
  expect(field().value).toBe("c\\d");
  expect(refusal()).toBe(SHOWN);
  expect(saveLabel(), "nothing is being saved").toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(put, "and no save follows").toHaveBeenCalledTimes(2);
});

test("the field takes no name until the control's first read has answered", async () => {
  vi.useFakeTimers();
  let answerRead: (v: ExcludedDirsView) => void = () => {};
  vi.spyOn(api, "excludedDirs").mockImplementation(
    () =>
      new Promise<ExcludedDirsView>((answer) => {
        answerRead = answer;
      }),
  );
  const put = vi.spyOn(api, "setExcludedDirs").mockImplementation(async (names) => view([...names]));
  app = mount(ExcludedDirsControl, { target: document.body });
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  const addButton = () => document.querySelector<HTMLButtonElement>(".add-btn")!;

  expect(field().disabled, "the field before the read has answered").toBe(true);
  add("x");
  expect(workspaceNames(), "a name typed before the read is not listed").toEqual([]);
  expect(addButton().disabled, "the button with a name in the field before the read").toBe(true);
  await saved();
  expect(sent(put), "and nothing is saved before the read").toEqual([]);

  answerRead(view(["dist"]));
  await landed();
  expect({ disabled: field().disabled, names: workspaceNames() }, "the field after the read").toEqual({
    disabled: false,
    names: ["dist"],
  });

  add("x");
  await saved();
  expect(sent(put), "a name added after the read is saved with the stored set").toEqual([["dist", "x"]]);
  expect(workspaceNames()).toEqual(["dist", "x"]);
  expect(saveLabel()).toBe("Saved");
});
