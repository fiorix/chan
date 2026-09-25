// @vitest-environment jsdom
//
// While the search index is being rebuilt, content search is paused, and the
// search panel says so in place of results: "rebuilding search index -
// content search is paused until it finishes". It says it when a search
// answers that the workspace is recovering and when the index status reports
// recovery, and it says it ahead of any hit count or "no matches".

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const served = vi.hoisted(() => ({ recovering: false }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async () => []),
      searchContent: vi.fn(async () => ({
        hits: [],
        readiness: served.recovering ? { state: "recovering" } : { state: "ready" },
      })),
      reportFile: vi.fn(async () => null),
    },
  };
});

import type { IndexStatus } from "../api/types";
import { indexStatus, searchPanel } from "../state/store.svelte";
import SearchPanel from "./SearchPanel.svelte";

const PAUSED = "rebuilding search index - content search is paused until it finishes";

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

beforeEach(async () => {
  served.recovering = false;
  searchPanel.open = true;
  searchPanel.query = "";
  target = document.createElement("div");
  document.body.append(target);
  view = mount(SearchPanel, { target });
  await tick();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  searchPanel.open = false;
  searchPanel.query = "";
  indexStatus.value = null;
});

function search(text: string): void {
  const input = target.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function status(): string {
  return target.querySelector(".status-line")!.textContent!.replace(/\s+/g, " ").trim();
}

describe("the search panel during an index rebuild", () => {
  test("says content search is paused when a search answers that the workspace is recovering", async () => {
    served.recovering = true;

    search("alpha");

    await vi.waitFor(() => expect(status()).toBe(PAUSED), { timeout: 2_000 });
  });

  test("says so when the index status reports recovery", async () => {
    indexStatus.value = { state: "recovering", readiness: { state: "recovering" } } as IndexStatus;
    await tick();

    expect(status()).toBe(PAUSED);
  });

  test("reports no matches once the workspace is ready", async () => {
    search("alpha");

    await vi.waitFor(() => expect(status()).toBe("no matches"), { timeout: 2_000 });
  });
});
