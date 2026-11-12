// @vitest-environment jsdom
//
// The launcher's recent commands: the newest first, each id once, a bounded
// list, kept in session storage so a reload of the window finds it.

import { beforeEach, expect, test, vi } from "vitest";

const KEY = "chan.command-launcher.recent.v1";

async function load() {
  vi.resetModules();
  return import("./recent.svelte");
}

beforeEach(() => sessionStorage.clear());

test("a run moves its command to the front, once", async () => {
  const recent = await load();
  recent.noteCommandRun("a");
  recent.noteCommandRun("b");
  recent.noteCommandRun("a");
  expect(recent.recentCommandIds()).toEqual(["a", "b"]);
});

test("the list survives a reload of the window", async () => {
  const before = await load();
  before.noteCommandRun("app.tab.close");
  before.noteCommandRun("app.pane.splitRight");
  const after = await load();
  expect(after.recentCommandIds()).toEqual(["app.pane.splitRight", "app.tab.close"]);
});

test("the list is bounded and drops its oldest", async () => {
  const recent = await load();
  for (let index = 0; index < 40; index += 1) recent.noteCommandRun(`command-${index}`);
  const ids = recent.recentCommandIds();
  expect(ids).toHaveLength(16);
  expect(ids[0]).toBe("command-39");
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "[]")).toEqual([...ids]);
});

test("stored state that is not a list of ids is ignored", async () => {
  sessionStorage.setItem(KEY, JSON.stringify({ ids: ["a"] }));
  expect((await load()).recentCommandIds()).toEqual([]);
  sessionStorage.setItem(KEY, JSON.stringify(["a", 7, "", "b"]));
  expect((await load()).recentCommandIds()).toEqual(["a", "b"]);
  sessionStorage.setItem(KEY, "not json");
  expect((await load()).recentCommandIds()).toEqual([]);
});

test("clearing forgets the list and its stored copy", async () => {
  const recent = await load();
  recent.noteCommandRun("a");
  recent.clearRecentCommands();
  expect(recent.recentCommandIds()).toEqual([]);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});
