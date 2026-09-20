// @vitest-environment jsdom
//
// The inspector must render a target that one document links more than once.
// The edges table's key is (src, dst, kind, anchor) and chan-workspace asserts
// it keeps two anchors to one target, so this is a shape the server sends.
// Keyed on the source path alone the Backlinks `{#each}` threw
// each_key_duplicate, which killed the section until the inspector was
// reopened; keyed on the node id, the same held for the Links to, Tags and
// Dates lists that selectionEdgesFor feeds.
//
// Mounted, because the failure is a render throw: a unit test over the data
// cannot see it. The graph loader and selectionEdgesFor run for real; only the
// transport under them is mocked.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import FileInfoBody from "./FileInfoBody.svelte";
import { graphData } from "../state/graphData.svelte";
import type { GraphEdge, GraphView } from "../api/types";

const entries = vi.hoisted(() => [
  { path: "a.md", is_dir: false, kind: "document", size: 10, mtime: null },
  { path: "src.md", is_dir: false, kind: "document", size: 10, mtime: null },
  { path: "b.md", is_dir: false, kind: "document", size: 10, mtime: null },
]);

const streamed = vi.hoisted(() => ({ backlinks: [] as unknown[], view: null as unknown }));

vi.mock("../api/client", () => ({
  api: {
    inspector: vi.fn(async () => null),
    read: vi.fn(async () => ({ content: "" })),
    reportDir: vi.fn(async () => {
      throw new Error("no report");
    }),
    reportPrefix: vi.fn(async () => {
      throw new Error("no report");
    }),
    reportFileStream: vi.fn(async () => {}),
    downloadUrl: (p: string) => `/api/fs/${p}?download=1`,
    graphStream: vi.fn(async () => streamed.view),
    // Edges arrive after an await, as they do over the wire. Delivering them
    // synchronously would run onEdge inside the caller's $effect, where
    // `backlinks = [...backlinks, edge]` reads and writes one piece of state
    // and Svelte stops with effect_update_depth_exceeded.
    backlinksStream: vi.fn(
      async (_path: string, opts: { onEdge(e: unknown): void }) => {
        await Promise.resolve();
        for (const edge of streamed.backlinks) opts.onEdge(edge);
      },
    ),
  },
  withTokenQuery: (u: string) => u,
}));

vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => false,
  saveBytesToDownloads: vi.fn(async () => {}),
}));
vi.mock("../api/download", () => ({ downloadBytes: vi.fn() }));
vi.mock("../api/transport", () => ({ handleDemoDownload: () => false }));

vi.mock("../state/store.svelte", () => ({
  copyTextToClipboard: vi.fn(async () => {}),
  draftsDir: () => ".Drafts",
  isDraftPath: (p: string) => p.startsWith(".Drafts"),
  setTransientStatus: vi.fn(),
  ui: { status: "", statusKind: "transient" },
  workspace: { info: { root: "/ws", label: "ws" } },
  fileOps: { downloadPathWithProgress: vi.fn() },
  loadTreeDir: vi.fn(async () => {}),
  openGraphAtNode: vi.fn(),
  openGraphForContact: vi.fn(),
  openGraphForLanguage: vi.fn(),
  openGraphForMention: vi.fn(),
  openGraphForTag: vi.fn(),
  revealPathInBrowser: vi.fn(),
  tree: { entries, loadingDirs: {}, loadedDirs: {}, dirErrors: {} },
}));

vi.mock("../state/tabs.svelte", () => ({ openTerminalInActivePane: vi.fn() }));

function fileNode(path: string) {
  return { kind: "file" as const, id: `f:${path}`, label: path, path };
}

function link(src: string, dst: string, anchor: string | null): GraphEdge {
  return { src, dst, kind: "link", anchor };
}

const mounted: Array<Record<string, unknown>> = [];

function render(path: string): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(FileInfoBody, { target, props: { path, showRefs: true } }));
  return target;
}

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  graphData.view = null;
  streamed.backlinks = [];
  streamed.view = null;
});

describe("an inspector target referenced twice from one document", () => {
  test("lists both backlinks instead of killing the section", async () => {
    // One document linking a.md twice, by two anchors: two rows of the edges
    // table, two edges on the wire.
    streamed.backlinks = [link("src.md", "a.md", "one"), link("src.md", "a.md", "two")];
    streamed.view = { nodes: [], edges: [] } satisfies GraphView;

    const target = render("a.md");
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(target.textContent, "the Backlinks section rendered").toContain("Backlinks");
    const rows = target.querySelectorAll(".refs li");
    const backlinkRows = [...rows].filter((li) => li.textContent?.includes("src.md"));
    expect(backlinkRows, "both edges are listed").toHaveLength(2);
  });

  test("lists one row per target when a document links it twice", async () => {
    // The outgoing half: two link edges a.md -> b.md differing only by rank,
    // which both survive the loader's dedupe and reach selectionEdgesFor.
    streamed.view = {
      nodes: [fileNode("a.md"), fileNode("b.md")],
      edges: [
        { source: "f:a.md", target: "f:b.md", kind: "link", rank: 1 },
        { source: "f:a.md", target: "f:b.md", kind: "link", rank: 2 },
      ],
    } satisfies GraphView;

    const target = render("a.md");
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    const rows = [...target.querySelectorAll(".refs li")].filter((li) =>
      li.textContent?.includes("b.md"),
    );
    expect(rows, "one row for the target, not one per edge").toHaveLength(1);
  });
});
