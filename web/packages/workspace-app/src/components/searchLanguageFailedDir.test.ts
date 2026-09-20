// @vitest-environment jsdom
//
// `language:<name>` is a workspace-wide query, so it hydrates every directory
// listing before scanning report rows. Its walk filtered on loaded and loading
// only, and a directory whose listing failed is neither, so it stayed pending
// and the loop asked for it again on every one of its 1000 turns while the
// panel sat on "searching".
//
// The real store runs; only the transport is stubbed, so the walk, the latch
// and tree.dirErrors are the production ones.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import SearchPanel from "./SearchPanel.svelte";
import { searchPanel, tree } from "../state/store.svelte";

/** How many failures the stub serves before it relents, so a broken walk
 *  shows up as a count rather than as a run that never returns. */
const RETRY_CEILING = 6;

const listed = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async (dir: string) => {
        listed.calls.push(dir);
        const soFar = listed.calls.filter((d) => d === dir).length;
        if (dir === "locked" && soFar <= RETRY_CEILING) {
          throw new Error(`cannot list ${dir}`);
        }
        return [];
      }),
      searchContent: vi.fn(async () => ({ hits: [], readiness: null })),
      reportFile: vi.fn(async () => null),
      reportPrefix: vi.fn(async () => {
        throw new Error("no report");
      }),
    },
  };
});

// jsdom carries none of these, and the panel's layout code reads all of them.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
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
    dispatchEvent() {
      return false;
    },
  }),
});

/// The panel searches from its input's oninput, not from an effect on
/// searchPanel.query, so a programmatic assignment schedules nothing.
function typeQuery(target: HTMLElement, text: string): void {
  const input = target.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const mounted: Array<Record<string, unknown>> = [];

/// The query is debounced by 200ms before the walk starts, so a settle made
/// only of microtask turns never reaches it.
async function settle(turns = 14): Promise<void> {
  await tick();
  await new Promise((r) => setTimeout(r, 260));
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  listed.calls = [];
  tree.entries = [
    { path: "locked", is_dir: true, size: 0, mtime: null },
    { path: "ok", is_dir: true, size: 0, mtime: null },
  ];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  searchPanel.open = true;
  searchPanel.query = "";
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  searchPanel.open = false;
  searchPanel.query = "";
  tree.entries = [];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  vi.clearAllMocks();
});

describe("a language query over a directory that cannot be listed", () => {
  test("asks for it once", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(SearchPanel, { target }) as Record<string, unknown>);
    await tick();

    typeQuery(target, "language:rust");
    await settle();

    const lockedCalls = listed.calls.filter((d) => d === "locked");
    expect(lockedCalls, `one request, got ${lockedCalls.length}`).toHaveLength(1);
    expect(tree.dirErrors["locked"], "the failure is recorded").toContain("cannot list");
  });

  test("still walks the directories that do list", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(SearchPanel, { target }) as Record<string, unknown>);
    await tick();

    typeQuery(target, "language:rust");
    await settle();

    expect(listed.calls.filter((d) => d === "ok"), "the readable one loaded").toHaveLength(1);
    expect(tree.loadedDirs["ok"], "and is marked loaded").toBe(true);
  });
});
