// @vitest-environment jsdom
//
// The backlink count under a note follows the note's path: a bar that stays
// mounted while its path changes (a rename) asks for the new path's count
// after the same pause. The api is mocked.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import WikiStatusBar from "./WikiStatusBar.svelte";
import { api } from "../api/client";

let view: Record<string, unknown> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a new path on a mounted bar is asked for its own backlinks", async () => {
  vi.useFakeTimers();
  const backlinks = vi.spyOn(api, "backlinks").mockResolvedValue([] as never);
  const props = $state({ path: "notes/a.md", content: "" });
  view = mount(WikiStatusBar, { target: document.body, props });
  await vi.advanceTimersByTimeAsync(600);
  expect(backlinks.mock.calls.map(([path]) => path), "the first path").toEqual(["notes/a.md"]);

  props.path = "notes/b.md";
  flushSync();
  await vi.advanceTimersByTimeAsync(600);

  expect(backlinks.mock.calls.map(([path]) => path), "the renamed note's own count").toEqual([
    "notes/a.md",
    "notes/b.md",
  ]);
});


test("a rename keeps its count until the query after the index debounce answers", async () => {
  vi.useFakeTimers();
  let indexed = false;
  const backlinks = vi.spyOn(api, "backlinks").mockImplementation(async (path) =>
    (path === "notes/a.md" || indexed ? [{}, {}, {}] : []) as never,
  );
  const props = $state({ path: "notes/a.md", content: "" });
  view = mount(WikiStatusBar, { target: document.body, props });
  await vi.advanceTimersByTimeAsync(600);
  const count = () => document.querySelector('[title="incoming links"]')!.textContent!.trim();
  expect(count()).toBe("3 backlinks");

  props.path = "notes/b.md";
  flushSync();
  await vi.advanceTimersByTimeAsync(600);
  expect(backlinks.mock.calls.at(-1)).toEqual(["notes/b.md"]);
  expect(count(), "the early stale zero never replaces the displayed count").toBe("3 backlinks");
  indexed = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(backlinks.mock.calls.map(([path]) => path), "ask again after the slowest index debounce").toEqual([
    "notes/a.md", "notes/b.md", "notes/b.md",
  ]);
  expect(count()).toBe("3 backlinks");
});

test("a rename displays an answered zero only after the index debounce", async () => {
  vi.useFakeTimers();
  const backlinks = vi.spyOn(api, "backlinks").mockResolvedValueOnce([{}, {}] as never).mockResolvedValue([] as never);
  const props = $state({ path: "notes/a.md", content: "" });
  view = mount(WikiStatusBar, { target: document.body, props });
  await vi.advanceTimersByTimeAsync(600);
  props.path = "notes/b.md";
  flushSync();
  await vi.advanceTimersByTimeAsync(2600);
  expect(backlinks.mock.calls.length, "zero comes from the delayed second query").toBe(3);
  expect(document.querySelector('[title="incoming links"]')!.textContent!.trim()).toBe("0 backlinks");
});
