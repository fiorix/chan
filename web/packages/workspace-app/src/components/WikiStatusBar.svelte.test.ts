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
