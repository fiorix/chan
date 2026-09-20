// @vitest-environment jsdom
//
// `loadTreeDir` records a directory it could not list in `tree.dirErrors` and
// rethrows, and it sets neither `loadedDirs` nor `loadingDirs` on the way out.
// Two things follow for every caller that fires it without awaiting, and this
// file drives all three of them into the failure.
//
// A caller whose guard asks only "loaded or loading" re-arms the instant the
// failure lands, which is an unbounded request loop over a directory the
// server's uid cannot read. The stub here is bounded so that defect arrives as
// a count rather than as a worker that runs out of memory.
//
// A caller that lets the rejection escape puts `Unhandled error: ...` on the
// status bus, a second and shoutier copy of a failure the tree row already
// carries, for a listing the user never asked for. That escape is not
// something a case in this runner can assert on: the rejection is Node's,
// Vitest catches it first and fails the whole run under "Unhandled Errors",
// and a jsdom `window` listener never fires. The runner is the guard for it.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// jsdom has no layout, so it implements no scrollIntoView. Selecting a row
// schedules one in an animation frame, and an uncaught TypeError from a frame
// callback fails the whole run.
Element.prototype.scrollIntoView = vi.fn();

/// How many failures the stub serves before it relents. The stub is bounded on
/// purpose: a caller that re-arms on failure would otherwise take the worker
/// out of memory, and a crashed run proves nothing. Bounded, the same defect
/// arrives as a count.
const RETRY_CEILING = 5;

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
        if (dir === "bad" && soFar <= RETRY_CEILING) throw new Error(`cannot list ${dir}`);
        return [];
      }),
      inspector: vi.fn(async () => null),
      read: vi.fn(async () => ({ content: "" })),
      reportDir: vi.fn(async () => {
        throw new Error("no report");
      }),
      reportPrefix: vi.fn(async () => {
        throw new Error("no report");
      }),
      reportFileStream: vi.fn(async () => {}),
      graphStream: vi.fn(async () => null),
      backlinksStream: vi.fn(async () => {}),
    },
  };
});

vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => false,
  saveBytesToDownloads: vi.fn(async () => {}),
}));
vi.mock("../api/download", () => ({ downloadBytes: vi.fn() }));
vi.mock("../api/transport", () => ({ handleDemoDownload: () => false }));

import FileInfoBody from "./FileInfoBody.svelte";
import FileTree from "./FileTree.svelte";
import {
  clearTreeDirError,
  disposeFbTreeInstance,
  ensureFbTreeInstance,
  tree,
} from "../state/store.svelte";

const INSTANCE = "fb-rejection-test";

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  listed.calls = [];
  tree.entries = [
    { path: "bad", is_dir: true, size: 0, mtime: null },
    { path: "ok.md", is_dir: false, kind: "document", size: 1, mtime: null },
  ];
  tree.loadedDirs = { "": true };
  tree.loadingDirs = {};
  tree.dirErrors = {};
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  disposeFbTreeInstance(INSTANCE);
  tree.entries = [];
  tree.loadedDirs = {};
  tree.loadingDirs = {};
  tree.dirErrors = {};
  vi.clearAllMocks();
});

/// Let every queued effect, microtask and macrotask drain, so a rejection that
/// escapes has been delivered by the time the case ends.
async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function mountTree(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(FileTree, {
      target,
      props: { instanceId: INSTANCE },
    }) as Record<string, unknown>,
  );
  return target;
}

function mountInspector(path: string): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(FileInfoBody, { target, props: { path } }) as Record<string, unknown>,
  );
  return target;
}

/// The directory name is the expand affordance: clicking it toggles the node.
function expandDir(target: HTMLElement, name: string): void {
  const label = [...target.querySelectorAll<HTMLElement>(".name")].find(
    (el) => el.textContent === `${name}/`,
  );
  expect(label, `tree row for ${name}`).toBeDefined();
  label!.click();
}

describe("a directory that cannot be listed", () => {
  test("the tree's load effect records the failure and does not retry", async () => {
    // The effect's own path: the directory is already expanded when the tree
    // mounts, which is what a restored surface looks like.
    ensureFbTreeInstance(INSTANCE).expanded = { "": true, bad: true };
    mountTree();
    await settle();

    expect(listed.calls.filter((d) => d === "bad")).toHaveLength(1);
    expect(tree.dirErrors["bad"]).toContain("cannot list bad");
  });

  test("expanding it from the tree records the failure and shows it on the row", async () => {
    const target = mountTree();
    await settle();
    expandDir(target, "bad");
    await settle();

    expect(listed.calls.filter((d) => d === "bad")).toHaveLength(1);
    expect(tree.dirErrors["bad"]).toContain("cannot list bad");
    expect(target.textContent).toContain("cannot list bad");
  });

  test("the inspector asks for the parent once, not until the stub relents", async () => {
    mountInspector("bad/unseen.md");
    await settle();

    const asked = listed.calls.filter((d) => d === "bad");
    expect(asked, `one request, got ${asked.length}`).toHaveLength(1);
    expect(tree.dirErrors["bad"]).toContain("cannot list bad");
  });

  test("the inspector asks again once the recorded failure is cleared", async () => {
    // Clearing the record is what the tree's collapse and a refresh do, and it
    // is the only thing that makes the parent worth asking for again.
    mountInspector("bad/unseen.md");
    await settle();
    expect(listed.calls.filter((d) => d === "bad")).toHaveLength(1);

    clearTreeDirError("bad");
    await settle();

    const asked = listed.calls.filter((d) => d === "bad");
    expect(asked, `a second request, got ${asked.length}`).toHaveLength(2);
  });
});
