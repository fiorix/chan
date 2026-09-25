// @vitest-environment jsdom
//
// The indexing pill shows while the indexer works and clears the moment it
// reports idle. Building shows a files counter, hidden during the embedding
// batch whose numbers are chunk counts rather than files; reindexing names
// the file, recovery says search is paused, and an error says what failed.
// Idle with embeddings still generating in the background shows a passive
// chip with the embedded count, its dot still rather than pulsing.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import type { IndexStatus } from "../api/types";
import { indexStatus } from "../state/store.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  indexStatus.value = null;
});

function show(status: IndexStatus | null): void {
  indexStatus.value = status;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(AppStatusBar, { target });
  flushSync();
}

function pill(): { text: string; pulsing: boolean; error: boolean } | null {
  const button = target.querySelector<HTMLElement>('[aria-label="open indexing dashboard"]');
  if (!button) return null;
  const dot = button.querySelector(".dot")!;
  return {
    text: button.textContent!.replace(/\s+/g, " ").trim(),
    pulsing: dot.classList.contains("working"),
    error: dot.classList.contains("err"),
  };
}

describe("the indexing pill", () => {
  test("is absent before the first status arrives", () => {
    show(null);
    expect(pill()).toBeNull();
  });

  test("counts files while building, pulsing", () => {
    show({ state: "building", current: 42, total: 100, file: "notes/a.md" } as IndexStatus);
    expect(pill()).toEqual({ text: "indexing 42/100 (notes/a.md)", pulsing: true, error: false });
  });

  test("drops the counter during the embedding batch", () => {
    show({ state: "building", current: 4143, total: 4096, file: "embedding" } as IndexStatus);
    expect(pill()?.text).toBe("indexing (embedding)");
  });

  test("names the file while reindexing one", () => {
    show({ state: "reindexing", file: "notes/x.md" } as IndexStatus);
    expect(pill()).toEqual({ text: "reindexing notes/x.md", pulsing: true, error: false });
  });

  test("says search is paused while the index is rebuilt", () => {
    show({ state: "recovering", readiness: { state: "recovering" } });
    expect(pill()?.text).toBe("rebuilding search index search paused");
  });

  test("says what failed, without pulsing", () => {
    show({ state: "error", message: "boom" } as IndexStatus);
    expect(pill()).toEqual({ text: "index error: boom", pulsing: false, error: true });
  });

  test("clears the moment the indexer reports idle", () => {
    show({ state: "building", current: 99, total: 100, file: "notes/a.md" } as IndexStatus);
    expect(pill()).not.toBeNull();

    indexStatus.value = { state: "idle" } as IndexStatus;
    flushSync();
    expect(pill()).toBeNull();
  });

  test("stays as a still chip while embeddings generate in the background", () => {
    show({
      state: "idle",
      indexed_docs: 10,
      indexed_vectors: 4,
      model: "BAAI/bge-small-en-v1.5",
      embedding: { done: 4, total: 10 },
    } as IndexStatus);
    expect(pill()).toEqual({ text: "embedding 4/10", pulsing: false, error: false });
  });
});
