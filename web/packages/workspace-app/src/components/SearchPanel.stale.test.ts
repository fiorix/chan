// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, searchContent: vi.fn(), list: vi.fn(), reportFile: vi.fn() } };
});
vi.mock("../state/graphData.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/graphData.svelte")>()),
  ensureGraphLoaded: vi.fn(async () => {}),
}));

import SearchPanel from "./SearchPanel.svelte";
import { api } from "../api/client";
import type { ContentSearchResponse, TreeEntry, ReportFileStats } from "../api/types";
import { indexStatus, searchPanel, tree } from "../state/store.svelte";
import { installEditorDom } from "../__tests__/wysiwyg";

installEditorDom();

const EMPTY: ContentSearchResponse = { ready: true, readiness: { state: "ready" }, mode: "bm25", hits: [] };
const FILE: TreeEntry = { path: "folder/alpha.rs", is_dir: false, size: 10, mtime: 1 };
const STATS: ReportFileStats = { path: FILE.path, language: "Rust", code: 1, comments: 0, blanks: 0, complexity: 0, bytes: 10 };
let component: ReturnType<typeof mount>;
let target: HTMLElement;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

function search(query: string): void {
  const input = target.querySelector("input")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchContent).mockResolvedValue(EMPTY);
  vi.mocked(api.list).mockResolvedValue([]);
  vi.mocked(api.reportFile).mockResolvedValue(STATS);
  searchPanel.open = true;
  searchPanel.query = "";
  searchPanel.inspectorOpen = false;
  tree.entries = [FILE];
  indexStatus.value = null;
  target = document.createElement("div");
  document.body.append(target);
  component = mount(SearchPanel, { target });
  await flush();
});

afterEach(() => {
  unmount(component);
  searchPanel.open = false;
  searchPanel.query = "";
  tree.entries = [];
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function start(kind: "content" | "language" | "path") {
  const response = deferred<ContentSearchResponse>();
  const listing = deferred<TreeEntry[]>();
  const report = deferred<ReportFileStats>();
  if (kind === "content") vi.mocked(api.searchContent).mockReturnValue(response.promise);
  if (kind === "path") vi.mocked(api.list).mockReturnValue(listing.promise);
  if (kind === "language") vi.mocked(api.reportFile).mockReturnValue(report.promise);
  search(kind === "language" ? "language:rust" : kind === "path" ? "folder/a" : "alpha");
  await flush();
  await vi.advanceTimersByTimeAsync(200);
  expect(kind === "language" ? api.reportFile : kind === "path" ? api.list : api.searchContent).toHaveBeenCalledTimes(1);
  search("");
  await flush();
  expect(target.querySelectorAll(".hits li")).toHaveLength(0);
  expect(target.querySelector(".status-line")!.textContent).not.toContain("searching...");
  return {
    resolve() {
      response.resolve({ ...EMPTY, hits: [{ path: "result.md", chunk_id: "c1", heading: "", start_line: 1, snippet: "alpha", score: 1 }] });
      listing.resolve([FILE]);
      report.resolve(STATS);
    },
    reject() {
      const error = new Error(`late ${kind} failure`);
      if (kind === "content") response.reject(error);
      else report.reject(error);
    },
  };
}

describe("clearing a search in flight", () => {
  test.each(["content", "language", "path"] as const)("discards late %s results", async (kind) => {
    const pending = await start(kind);
    pending.resolve();
    await flush();
    expect(target.querySelectorAll(".hits li")).toHaveLength(0);
    expect(target.querySelector("input")!.value).toBe("");
    expect(target.querySelector(".status-line")!.textContent).not.toContain("searching...");
    expect(target.querySelector(".err")).toBeNull();
  });

  test.each(["content", "language"] as const)("discards a late %s failure", async (kind) => {
    const pending = await start(kind);
    pending.reject();
    await flush();
    expect(target.querySelector(".err")).toBeNull();
    expect(target.querySelectorAll(".hits li")).toHaveLength(0);
    expect(target.querySelector(".status-line")!.textContent).not.toContain("searching...");
  });
});
