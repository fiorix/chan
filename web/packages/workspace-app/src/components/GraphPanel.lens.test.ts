// @vitest-environment jsdom
//
// Which nodes a graph lens shows. GraphPanel is mounted on the real tab model
// with the api served from a fixed graph, and the assertions read the node set
// it hands the canvas.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
import {
  canvas,
  g,
  graphServer,
  graphTab,
  installGraphDom,
  mountGraphPanel,
  resetGraphServer,
  unmountGraphPanels,
  visibleIds,
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { layout } from "../state/tabs.svelte";

installGraphDom();

const A = "notes/a.md";
const B = "notes/b.md";
const C = "notes/c.md";
const DEEP = "notes/deep/d.md";
const MAIN = "src/main.rs";
const NOTES = "directory:notes";
const NOTES_DEEP = "directory:notes/deep";
const SRC = "directory:src";
const ROOT = "";

/// notes/{a,b,c}.md, notes/deep/d.md and src/main.rs under the root, with:
///   a -> #t, b -> #t, c -> #other            (tags)
///   c -> a, a -> b, d -> c                   (links)
///   b -> @@alice                             (mention)
///   main.rs -> rust                          (language)
function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("notes/deep"),
      g.dir("src"),
      g.file("notes/a.md"),
      g.file("notes/b.md"),
      g.file("notes/c.md"),
      g.file("notes/deep/d.md"),
      g.file("src/main.rs"),
      g.tag("t"),
      g.tag("other"),
      g.mention("alice"),
      g.language("rust"),
    ],
    edges: [
      g.edge(ROOT, NOTES, "contains"),
      g.edge(ROOT, SRC, "contains"),
      g.edge(NOTES, NOTES_DEEP, "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge(NOTES, B, "contains"),
      g.edge(NOTES, C, "contains"),
      g.edge(NOTES_DEEP, DEEP, "contains"),
      g.edge(SRC, MAIN, "contains"),
      g.edge(A, "#t", "tag"),
      g.edge(B, "#t", "tag"),
      g.edge(C, "#other", "tag"),
      g.edge(C, A, "link"),
      g.edge(A, B, "link"),
      g.edge(DEEP, C, "link"),
      g.edge(B, "@@alice", "mention"),
      g.edge(MAIN, "language:rust", "language"),
    ],
  };
}

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  serveGraph();
});

afterEach(() => {
  unmountGraphPanels();
  timers.release();
});

async function lens(scopeId: string, depth = 1): Promise<string[]> {
  await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId, depth }));
  return visibleIds();
}

describe("the tag lens", () => {
  test("walks edges in both directions from the tag", async () => {
    // Every edge into #t points AT the tag, so a forward-only walk from it
    // would find nothing.
    const ids = await lens("tag:#t");
    expect(ids).toContain(A);
    expect(ids).toContain(B);
    expect(ids).not.toContain(C);
  });

  test("goes one hop further per depth step, both ways", async () => {
    const ids = await lens("tag:#t", 2);
    expect(ids, "c links to a, one hop back from a").toContain(C);
    expect(ids).not.toContain(DEEP);
  });

  test("closes over the meta nodes of what it shows", async () => {
    const ids = await lens("tag:#t");
    expect(ids, "b's mention comes along").toContain("@@alice");
  });

  test("anchors what it shows to the directory spine", async () => {
    const ids = await lens("tag:#t");
    expect(ids).toContain(NOTES);
    expect(ids).toContain(ROOT);
    expect(ids, "no file of src is shown").not.toContain(SRC);
  });
});

describe("the mention lens", () => {
  test("walks in both directions, closes over meta nodes and anchors to the spine", async () => {
    const ids = await lens("mention:@@alice");
    expect(ids).toEqual([ROOT, "#t", "@@alice", NOTES, B].sort());
  });

  test("goes one hop further per depth step, both ways", async () => {
    const ids = await lens("mention:@@alice", 2);
    expect(ids, "a links to b, one hop back from b").toContain(A);
    expect(ids).toEqual([ROOT, "#t", "@@alice", NOTES, A, B].sort());
  });
});

describe("the contact lens", () => {
  test("seeds on the contact file and walks both ways", async () => {
    const ids = await lens("contact:notes/a.md");
    expect(ids, "a's outgoing link and tag").toEqual(expect.arrayContaining([B, "#t"]));
    expect(ids, "c's backlink to a").toContain(C);
    expect(ids, "meta nodes of b and c").toEqual(expect.arrayContaining(["@@alice", "#other"]));
    expect(ids, "the spine").toEqual(expect.arrayContaining([NOTES, ROOT]));
    expect(ids).not.toContain(MAIN);
  });

  test("goes one hop further per depth step, both ways", async () => {
    const ids = await lens("contact:notes/a.md", 2);
    expect(ids, "d links to c, two hops back from a").toContain(DEEP);
    expect(ids).toEqual(
      [ROOT, "#other", "#t", "@@alice", NOTES, NOTES_DEEP, A, B, C, DEEP].sort(),
    );
  });

  test("shows nothing when no file is the contact", async () => {
    expect(await lens("contact:notes/none.md")).toEqual([]);
  });
});

describe("the language lens", () => {
  test("shows the language's files one hop out, on their spine", async () => {
    const ids = await lens("language:rust");
    expect(ids).toEqual([ROOT, SRC, MAIN, "language:rust"].sort());
  });

  test("does not close over its files' other meta nodes", async () => {
    graphServer.view.edges.push(g.edge(MAIN, "#other", "tag"));
    const ids = await lens("language:rust");
    expect(ids).toEqual([ROOT, SRC, MAIN, "language:rust"].sort());
  });

  // Language mode's own graph: each language linked to the directories that
  // hold its files, as the server spells them, with src shared by both.
  function serveLanguageGraph(): void {
    const lang = (name: string, files: number) =>
      ({ kind: "language", id: `language:${name}`, label: name, language: name, files, code: files }) as const;
    const dir = (path: string) =>
      ({ kind: "directory", id: `directory:${path}`, label: path, path, files: 1, code: 1 }) as const;
    const edge = (name: string, path: string) =>
      ({ source: `language:${name}`, target: `directory:${path}`, kind: "language", rank: 1, files: 1, code: 1 }) as const;
    graphServer.languageView = {
      max_depth: 1,
      nodes: [lang("Rust", 1), lang("Python", 2), dir("src"), dir("scripts")],
      edges: [edge("Rust", "src"), edge("Python", "src"), edge("Python", "scripts")],
    };
  }

  // Depth 0 reads as "max" in language mode. Depth 2 is past this fixture's
  // slider (max_depth 1): it reaches the lens because the tab is built at 2
  // and the depth clamp returns early in language mode.
  for (const depth of [0, 2]) {
    test(`takes exactly one hop in language mode at depth ${depth}`, async () => {
      serveLanguageGraph();
      await mountGraphPanel(
        GraphPanel,
        layout,
        graphTab({ mode: "language", scopeId: "language:Rust", depth }),
      );
      const edges = canvas.props?.visibleEdges ?? [];
      expect(edges.map((e) => e.source), "only rust's own edge").toEqual(["language:Rust"]);
      expect(visibleIds(), "python is two hops out, through src").not.toContain("language:Python");
    });
  }
});

describe("a file scope", () => {
  test("walks forward only: what the file links to, not what links to it", async () => {
    const ids = await lens("file:notes/a.md");
    expect(ids).toContain(B);
    expect(ids).toContain("#t");
    expect(ids, "c links to a; a backlink is not in a file's forward lens").not.toContain(C);
  });

  test("does not close over the meta nodes of what it shows", async () => {
    const ids = await lens("file:notes/a.md");
    expect(ids).toContain(B);
    expect(ids, "b's mention is not one of a's forward hops").not.toContain("@@alice");
  });

  test("pulls the whole spine up to the root, through nested directories", async () => {
    const ids = await lens("file:notes/deep/d.md");
    expect(ids).toEqual(expect.arrayContaining([DEEP, NOTES_DEEP, NOTES, ROOT]));
    expect(ids, "d links to c").toContain(C);
    expect(ids, "a is two links on, past depth 1").not.toContain(A);
  });
});
