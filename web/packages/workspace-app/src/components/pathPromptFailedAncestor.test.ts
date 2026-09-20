// @vitest-environment jsdom
//
// The prompt's ancestor-loading effect asked only "is this loaded or loading",
// never "did this fail". loadTreeDir records the failure in tree.dirErrors,
// rethrows, and clears loadingDirs without ever setting loadedDirs, so the
// effect's guard was false again on the next run and the request re-armed at
// once. Over a directory that cannot be listed the app issued an unbounded
// stream of GET /api/fs and starved the macrotask queue.
//
// A failed load is a state. It is not retried until something changes that
// could make it succeed.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import PathPromptModal from "./PathPromptModal.svelte";
import {
  clearTreeDirError,
  resolvePathPrompt,
  tree,
  uiPathPrompt,
} from "../state/store.svelte";

/** How many failures the stub serves before it relents. */
const RETRY_CEILING = 5;

const listed = vi.hoisted(() => ({ calls: [] as string[], fail: new Set<string>() }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async (dir: string) => {
        listed.calls.push(dir);
        // The failure is bounded. Without the latch the effect re-arms on
        // every run, and an endlessly failing stub takes the worker out of
        // memory: the run then crashes instead of failing an assertion, which
        // proves nothing and cannot guard a regression. After RETRY_CEILING
        // the stub succeeds, so a broken guard shows up as a count.
        const soFar = listed.calls.filter((d) => d === dir).length;
        if (listed.fail.has(dir) && soFar <= RETRY_CEILING) {
          throw new Error(`cannot list ${dir}`);
        }
        return [];
      }),
    },
  };
});

const mounted: Array<Record<string, unknown>> = [];

function mountModal(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(PathPromptModal, { target }) as Record<string, unknown>);
  return target;
}

/// Let every queued effect and microtask drain. An unlatched retry loop keeps
/// re-arming across these turns, which is what makes the count grow.
async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  listed.calls = [];
  listed.fail = new Set(["bad"]);
  tree.entries = [{ path: "bad", is_dir: true, size: 0, mtime: null }];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
});

afterEach(() => {
  resolvePathPrompt(null);
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  tree.entries = [];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  vi.clearAllMocks();
});

describe("the path prompt over a directory that cannot be listed", () => {
  test("asks once, not forever", async () => {
    const target = mountModal();
    void uiPathPrompt({ title: "New file", kind: "file", mode: "create" });
    await tick();
    const input = target.querySelector("input")!;
    input.value = "bad/new.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const badCalls = listed.calls.filter((d) => d === "bad");
    expect(badCalls, `one request, got ${badCalls.length}`).toHaveLength(1);
    expect(tree.dirErrors["bad"], "the failure is recorded").toContain("cannot list bad");

    // The contract puts the failure where the content would have been.
    const status = target.querySelector(".status")!.textContent!.replace(/\s+/g, " ");
    expect(status, "the prompt says the directory could not be listed").toContain(
      "cannot list bad",
    );
  });

  test("a retry asks once more", async () => {
    const target = mountModal();
    void uiPathPrompt({ title: "New file", kind: "file", mode: "create" });
    await tick();
    const input = target.querySelector("input")!;
    input.value = "bad/new.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(listed.calls.filter((d) => d === "bad")).toHaveLength(1);

    // Clearing the recorded failure is what a manual retry does.
    clearTreeDirError("bad");
    await settle();

    const badCalls = listed.calls.filter((d) => d === "bad");
    expect(badCalls, `a second request, got ${badCalls.length}`).toHaveLength(2);
  });

  test("a segment that is not a known directory is never asked for", async () => {
    // What the retired source-text pin guarded: the load is gated on the
    // directory already existing, so a mistyped segment cannot make a request
    // (and so cannot produce a 404 the user never caused).
    const target = mountModal();
    void uiPathPrompt({ title: "New file", kind: "file", mode: "create" });
    await tick();
    const input = target.querySelector("input")!;
    input.value = "nosuchdir/new.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    expect(listed.calls, `nothing was requested, got ${listed.calls}`).toHaveLength(0);
  });

  test("a directory that lists is still loaded once", async () => {
    listed.fail = new Set();
    const target = mountModal();
    void uiPathPrompt({ title: "New file", kind: "file", mode: "create" });
    await tick();
    const input = target.querySelector("input")!;
    input.value = "bad/new.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    expect(listed.calls.filter((d) => d === "bad")).toHaveLength(1);
    expect(tree.loadedDirs["bad"], "it loaded").toBe(true);
  });
});
