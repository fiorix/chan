// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
import type { ContentSearchResponse } from "../api/types";
import { indexStatus, searchPanel, tree } from "../state/store.svelte";
import { installEditorDom } from "../__tests__/wysiwyg";

installEditorDom();

let component: ReturnType<typeof mount>;
let target: HTMLElement;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(api.list).mockResolvedValue([]);
  searchPanel.open = true;
  searchPanel.query = "";
  searchPanel.inspectorOpen = false;
  tree.entries = [];
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
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
});

// A snippet is the file's raw text with bare `<b>` markers around each match.
// Markup in the file is shown as text and runs nothing; only the marker pair
// becomes a highlight.
test("a snippet shows file markup as text and highlights the match", async () => {
  const response: ContentSearchResponse = {
    ready: true,
    readiness: { state: "ready" },
    mode: "bm25",
    hits: [
      {
        path: "a.md",
        chunk_id: "a.md:0",
        heading: "",
        start_line: 1,
        snippet: 'if a > b && c <script>alert(1)</script> <img src=x onerror="alert(2)"> the <b>fox</b> ran',
        score: 1,
      },
    ],
  };
  vi.mocked(api.searchContent).mockResolvedValue(response);
  const input = target.querySelector("input")!;
  input.value = "fox";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  await vi.advanceTimersByTimeAsync(200);
  await flush();

  const snippet = target.querySelector(".hits li .snippet")!;
  expect(snippet.textContent).toBe('if a > b && c <script>alert(1)</script> <img src=x onerror="alert(2)"> the fox ran');
  expect(snippet.querySelector("script, img")).toBeNull();
  expect([...snippet.children].map((child) => child.outerHTML)).toEqual(["<mark>fox</mark>"]);
});
