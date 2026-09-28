// @vitest-environment jsdom
//
// A typed path lists its directory, and each row under it names the entry by
// its last path component, cut at `/` alone: a name that holds `\` reads
// whole.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async () => [
        { path: "dir/a\\b.md", is_dir: false, kind: "document", size: 5, mtime: 100 },
        { path: "dir/x\\y", is_dir: true, size: 0, mtime: 100 },
      ]),
      search: vi.fn(async () => []),
      searchContent: vi.fn(async () => ({ hits: [], readiness: { state: "ready" } })),
      reportFile: vi.fn(async () => null),
    },
  };
});

import { labelFor } from "../state/kinds";
import { searchPanel } from "../state/store.svelte";
import SearchPanel from "./SearchPanel.svelte";

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
});

function search(text: string): void {
  const input = target.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function previews(): string[] {
  return [...target.querySelectorAll(".preview.muted")].map((el) => el.textContent?.trim() ?? "");
}

describe("a typed path's rows", () => {
  test("name a file whose name holds a backslash whole", async () => {
    search("dir/");

    await vi.waitFor(() => expect(previews()).toContain("a\\b.md"), { timeout: 2_000 });
  });

  test("chip a directory as a folder and a file as a document", async () => {
    search("dir/");
    await vi.waitFor(() => expect(previews()).toContain("a\\b.md"), { timeout: 2_000 });

    const rows = [...target.querySelectorAll(".row1")].map((row) => [
      row.querySelector(".path")?.textContent?.trim(),
      row.querySelector(".kind-chip")?.textContent?.trim(),
    ]);
    expect(rows, "the file's chip").toContainEqual(["dir/a\\b.md", labelFor("document")]);
    expect(rows, "the directory's chip").toContainEqual(["dir/x\\y/", labelFor("folder")]);
  });
});
