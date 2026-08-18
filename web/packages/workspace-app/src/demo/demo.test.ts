import { afterEach, describe, expect, test, vi } from "vitest";
import { handleDemoDownload, setDownloadHandler } from "../api/transport";
import { CHAN_DEMO_MD, demoDownload } from "./download";
import type {
  FileResponse,
  GraphView,
  MoveResponse,
  TreeEntry,
  WorkspaceInfo,
} from "../api/types";
import type { MockWorkspaceData } from "./data";
import { DemoGraph, parseMarkdown } from "./graph";
import { MockReports } from "./report";
import { createDemoFetch } from "./router";
import { MockWorkspaceStore } from "./store";
import { applyUpload, createDemoUploadXhr } from "./upload";

const A_MD = [
  "# Alpha",
  "",
  "See [[README]] and [design](../design.md#goals) plus [[missing-note]].",
  "Tagged #demo and #web/ui, mentions @@Alex.",
  "",
  "## Usage",
  "```",
  "#not-a-tag [[not-a-link]]",
  "```",
].join("\n");

function fixture(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 4,
      textCount: 4,
    },
    files: [
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "design.md", kind: "document", size: 5, mtime: 100, content: "specs" },
      { path: "docs/a.md", kind: "document", size: A_MD.length, mtime: 100, content: A_MD },
      { path: "src/main.rs", kind: "text", size: 4, mtime: 100, content: "fn()" },
      { path: "src/util.rs", kind: "text", size: 4, mtime: 100, content: "fn()" },
    ],
    reports: {
      files: [
        { path: "src/main.rs", language: "Rust", code: 40, comments: 8, blanks: 6, complexity: 5, bytes: 900, mtime: null },
        { path: "src/util.rs", language: "Rust", code: 60, comments: 2, blanks: 4, complexity: 7, bytes: 700, mtime: null },
        { path: "docs/a.md", language: "Markdown", code: 10, comments: 0, blanks: 3, complexity: 0, bytes: 120, mtime: null },
      ],
    },
  };
}

function demoFetch(store: MockWorkspaceStore, data?: MockWorkspaceData) {
  return createDemoFetch(store, new DemoGraph(store), new MockReports(data?.reports?.files ?? []));
}

describe("MockWorkspaceStore", () => {
  test("lists root: directories first, then files, sorted", () => {
    const s = new MockWorkspaceStore(fixture());
    const names = s.list("").map((e: TreeEntry) => `${e.is_dir ? "d:" : "f:"}${e.path}`);
    expect(names).toEqual(["d:docs", "d:src", "f:design.md", "f:README.md"]);
  });

  test("lists a subdirectory", () => {
    const s = new MockWorkspaceStore(fixture());
    expect(s.list("docs").map((e) => e.path)).toEqual(["docs/a.md"]);
  });

  test("reads a file and returns null for missing", () => {
    const s = new MockWorkspaceStore(fixture());
    expect(s.read("README.md")?.content).toBe("hello");
    expect(s.read("nope.md")).toBeNull();
  });

  test("write is in-memory and readable back", () => {
    const s = new MockWorkspaceStore(fixture());
    s.write("README.md", "changed");
    expect(s.read("README.md")?.content).toBe("changed");
  });

  test("create adds a new file that lists and reads", () => {
    const s = new MockWorkspaceStore(fixture());
    s.create("docs/new.md", false, "n");
    expect(s.list("docs").map((e) => e.path).sort()).toEqual(["docs/a.md", "docs/new.md"]);
    expect(s.read("docs/new.md")?.content).toBe("n");
  });

  test("remove drops a file", () => {
    const s = new MockWorkspaceStore(fixture());
    s.remove("docs/a.md");
    expect(s.read("docs/a.md")).toBeNull();
    expect(s.list("").some((e) => e.path === "docs")).toBe(false);
  });

  test("move renames a file and reports it", () => {
    const s = new MockWorkspaceStore(fixture());
    const res: MoveResponse = s.move("README.md", "READ.md");
    expect(res.renamed).toEqual([["README.md", "READ.md"]]);
    expect(s.read("READ.md")?.content).toBe("hello");
    expect(s.read("README.md")).toBeNull();
  });

  test("move renames a whole directory subtree", () => {
    const s = new MockWorkspaceStore(fixture());
    s.move("docs", "documentation");
    expect(s.read("documentation/a.md")?.content).toBe(A_MD);
    expect(s.read("docs/a.md")).toBeNull();
  });

  test("session is in-memory per window", () => {
    const s = new MockWorkspaceStore(fixture());
    expect(s.getSession("w1")).toBeNull();
    s.putSession("w1", { layout: 1 });
    expect(s.getSession("w1")).toEqual({ layout: 1 });
    s.deleteSession("w1");
    expect(s.getSession("w1")).toBeNull();
  });
});

describe("createDemoFetch router", () => {
  const store = () => new MockWorkspaceStore(fixture());

  test("GET /api/workspace returns WorkspaceInfo with demo preferences", async () => {
    const f = demoFetch(store());
    const info = (await (await f("/api/workspace")).json()) as WorkspaceInfo;
    expect(info.root).toBe("demo");
    expect(info.drafts_dir).toBe(".Drafts");
    expect(info.preferences.terminal.default_term).toBe("xterm-256color");
  });

  test("GET /api/config then PATCH round-trips a preference", async () => {
    const f = demoFetch(store());
    const cfg = (await (await f("/api/config")).json()) as {
      revision: number;
      preferences: { theme: string };
    };
    const patched = (await (
      await f("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          expected_revision: cfg.revision,
          preferences: { theme: "light" },
        }),
      })
    ).json()) as { revision: number; preferences: { theme: string } };
    expect(patched.revision).toBe(cfg.revision + 1);
    expect(patched.preferences.theme).toBe("light");
  });

  test("GET /api/fs lists root and ?dir lists a subdir", async () => {
    const f = demoFetch(store());
    const root = (await (await f("/api/fs")).json()) as TreeEntry[];
    expect(root.map((e) => e.path)).toContain("README.md");
    const docs = (await (await f("/api/fs?dir=docs")).json()) as TreeEntry[];
    expect(docs.map((e) => e.path)).toEqual(["docs/a.md"]);
  });

  test("GET /api/fs/<path> reads content; missing is 404", async () => {
    const f = demoFetch(store());
    const ok = await f("/api/fs/README.md");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as FileResponse).content).toBe("hello");
    expect((await f("/api/fs/missing.md")).status).toBe(404);
  });

  test("PUT /api/fs/<path> writes and DELETE removes", async () => {
    const st = store();
    const f = demoFetch(st);
    await f("/api/fs/README.md", { method: "PUT", body: "x" });
    expect(st.read("README.md")?.content).toBe("x");
    const del = await f("/api/fs/README.md", { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(st.read("README.md")).toBeNull();
  });

  test("POST /api/fs/transfer is not consumed by the file wildcard", async () => {
    const st = store();
    const f = demoFetch(st);
    const response = await f("/api/fs/transfer", {
      method: "POST",
      body: JSON.stringify({ op: "move", sources: ["docs/a.md"], dest_dir: "" }),
    });

    expect(response.status).toBe(200);
    expect(st.read("a.md")?.content).toBe("A");
    expect(st.read("docs/a.md")).toBeNull();
  });

  test("streaming read emits meta/chunk/done NDJSON", async () => {
    const f = demoFetch(store());
    const body = await (await f("/api/fs/README.md?stream=1")).text();
    const events = body.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["meta", "chunk", "done"]);
    expect(events[0]).toMatchObject({
      authority_version: null,
      disk_conflicted: false,
    });
    expect(events[1].content).toBe("hello");
  });

  test("GET /api/session is 204 until PUT, then returns the payload", async () => {
    const f = demoFetch(store());
    expect((await f("/api/session?w=default")).status).toBe(204);
    await f("/api/session?w=default", { method: "PUT", body: JSON.stringify({ a: 1 }) });
    expect(await (await f("/api/session?w=default")).json()).toEqual({ a: 1 });
  });

  test("POST /api/drafts/new creates a draft file", async () => {
    const st = store();
    const f = demoFetch(st);
    const draft = (await (await f("/api/drafts/new", { method: "POST" })).json()) as {
      path: string;
      name: string;
    };
    expect(draft.path).toBe(".Drafts/untitled-1/draft.md");
    expect(st.read(draft.path)).not.toBeNull();
  });

  test("unhandled GET path is 404", async () => {
    const f = demoFetch(store());
    expect((await f("/api/nope")).status).toBe(404);
  });
});

describe("parseMarkdown", () => {
  test("extracts wiki links, md links, tags, mentions, headings", () => {
    const idx = parseMarkdown(A_MD);
    expect(idx.links).toEqual([
      { target: "README", anchor: null, wiki: true },
      { target: "missing-note", anchor: null, wiki: true },
      { target: "../design.md", anchor: "goals", wiki: false },
    ]);
    expect(idx.tags.sort()).toEqual(["demo", "web/ui"]);
    expect(idx.mentions).toEqual(["Alex"]);
    expect(idx.headings).toEqual([
      { level: 1, text: "Alpha", anchor: "alpha", ord: 0 },
      { level: 2, text: "Usage", anchor: "usage", ord: 1 },
    ]);
  });

  test("code blocks produce no tags or links", () => {
    const idx = parseMarkdown("```\n#tag [[link]]\n```\nand `#inline [[x]]` code");
    expect(idx.tags).toEqual([]);
    expect(idx.links).toEqual([]);
  });
});

describe("DemoGraph", () => {
  const build = () => {
    const s = new MockWorkspaceStore(fixture());
    return { s, g: new DemoGraph(s) };
  };

  test("view has file nodes per document plus tag/mention/ghost nodes", () => {
    const { g } = build();
    const view = g.view();
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    expect(byId.get("README.md")?.kind).toBe("file");
    expect(byId.get("docs/a.md")?.kind).toBe("file");
    expect(byId.get("#demo")?.kind).toBe("tag");
    expect(byId.get("@@Alex")?.kind).toBe("mention");
    const ghost = byId.get("docs/missing-note.md");
    expect(ghost?.kind).toBe("file");
    expect((ghost as { missing?: boolean }).missing).toBe(true);
  });

  test("view includes the filesystem spine: root, directories, all files", () => {
    const { g } = build();
    const view = g.view();
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const root = byId.get("");
    expect(root).toMatchObject({ kind: "directory", label: "/", path: "" });
    expect(byId.get("directory:docs")?.kind).toBe("directory");
    expect(byId.get("src/main.rs")?.kind).toBe("file");
    const contains = view.edges.filter((e) => e.kind === "contains");
    expect(contains).toContainEqual({ source: "", target: "directory:docs", kind: "contains" });
    expect(contains).toContainEqual({ source: "directory:docs", target: "docs/a.md", kind: "contains" });
    expect(contains).toContainEqual({ source: "", target: "README.md", kind: "contains" });
  });

  test("wiki basename resolution links docs/a.md to root README.md", () => {
    const { g } = build();
    const edges = g.view().edges.filter((e) => e.source === "docs/a.md" && e.kind === "link");
    const targets = edges.map((e) => e.target).sort();
    expect(targets).toEqual(["README.md", "design.md", "docs/missing-note.md"]);
    const broken = edges.filter((e) => e.broken).map((e) => e.target);
    expect(broken).toEqual(["docs/missing-note.md"]);
  });

  test("language layer: language nodes + language->file edges from reports", () => {
    const d = fixture();
    const g = new DemoGraph(new MockWorkspaceStore(d), d.reports?.files ?? []);
    const view = g.view();
    const rust = view.nodes.find((n) => n.id === "language:Rust");
    expect(rust).toMatchObject({ kind: "language", label: "Rust", files: 2, code: 100 });
    const langEdges = view.edges.filter((e) => e.kind === "language");
    expect(langEdges).toContainEqual({ source: "language:Rust", target: "src/main.rs", kind: "language" });
    // docs/a.md is a report row (Markdown) AND a graph file node -> gets an edge.
    expect(langEdges).toContainEqual({ source: "language:Markdown", target: "docs/a.md", kind: "language" });
  });

  test("backlinks returns incoming raw edges with anchors", () => {
    const { g } = build();
    expect(g.backlinks("README.md")).toEqual([
      { src: "docs/a.md", dst: "README.md", kind: "link", anchor: null },
    ]);
    expect(g.backlinks("design.md")).toEqual([
      { src: "docs/a.md", dst: "design.md", kind: "link", anchor: "goals" },
    ]);
  });

  test("indexFile after a write reshapes the graph", () => {
    const { s, g } = build();
    s.write("README.md", "now links [[design]] and #fresh");
    g.indexFile("README.md", "now links [[design]] and #fresh");
    const edges = g.view().edges.filter((e) => e.source === "README.md");
    expect(edges.map((e) => `${e.kind}:${e.target}`).sort()).toEqual([
      "link:design.md",
      "tag:#fresh",
    ]);
  });
});

describe("graph endpoints", () => {
  test("GET /api/graph returns the view; ?stream=1 frames NDJSON events", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = createDemoFetch(st, new DemoGraph(st), new MockReports([]));
    const view = (await (await f("/api/graph")).json()) as GraphView;
    expect(view.nodes.length).toBeGreaterThan(3);
    const body = await (await f("/api/graph?stream=1")).text();
    const events = body.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["meta", "nodes", "edges", "done"]);
    expect(events[0]).toMatchObject({ scope: "workspace", path: "", depth: 6 });
    expect(events[1].nodes.length).toBe(view.nodes.length);
  });

  test("backlinks stream frames meta/edge/done", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = createDemoFetch(st, new DemoGraph(st), new MockReports([]));
    const body = await (await f("/api/backlinks/README.md?stream=1")).text();
    const events = body.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["meta", "edge", "done"]);
    expect(events[1].edge.src).toBe("docs/a.md");
  });

  test("headings endpoint serves the outline", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = createDemoFetch(st, new DemoGraph(st), new MockReports([]));
    const rows = (await (await f("/api/headings/docs/a.md")).json()) as Array<{ text: string }>;
    expect(rows.map((r) => r.text)).toEqual(["Alpha", "Usage"]);
  });

  test("resolve-link resolves wiki targets and 404s broken ones", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = createDemoFetch(st, new DemoGraph(st), new MockReports([]));
    const ok = (await (await f("/api/resolve-link?target=README")).json()) as { path: string };
    expect(ok.path).toBe("README.md");
    expect((await f("/api/resolve-link?target=nope-note")).status).toBe(404);
  });
});

describe("search endpoints", () => {
  const setup = () => {
    const st = new MockWorkspaceStore(fixture());
    return createDemoFetch(st, new DemoGraph(st), new MockReports([]));
  };

  test("search/files matches the complete basename", async () => {
    const f = setup();
    const hits = (await (await f("/api/search/files?q=README.md&limit=5")).json()) as Array<{
      path: string;
    }>;
    expect(hits.map((hit) => hit.path)).toEqual(["README.md"]);
  });

  test("link-targets returns File and Heading rows", async () => {
    const f = setup();
    const rows = (await (await f("/api/link-targets?q=usage&limit=5")).json()) as Array<{
      kind: string;
      path: string;
      heading?: string;
    }>;
    expect(rows.some((r) => r.kind === "Heading" && r.heading === "Usage")).toBe(true);
  });

  test("search/content returns hits with snippet, line, and heading", async () => {
    const f = setup();
    const res = (await (await f("/api/search/content?q=tagged&limit=5")).json()) as {
      ready: boolean;
      hits: Array<{ path: string; start_line: number; snippet: string; heading: string }>;
    };
    expect(res.ready).toBe(true);
    expect(res.hits[0].path).toBe("docs/a.md");
    expect(res.hits[0].start_line).toBe(4);
    expect(res.hits[0].heading).toBe("Alpha");
    expect(res.hits[0].snippet).toContain("Tagged #demo");
  });

  test("mentions serves @@ labels from the corpus", async () => {
    const f = setup();
    const rows = (await (await f("/api/mentions?q=al&limit=5")).json()) as Array<{
      label: string;
    }>;
    expect(rows).toEqual([{ label: "@@Alex" }]);
  });
});

describe("report endpoints", () => {
  const setup = () => {
    const d = fixture();
    return demoFetch(new MockWorkspaceStore(d), d);
  };

  test("reports are enabled in the demo", async () => {
    const f = setup();
    expect(await (await f("/api/index/reports/state")).json()).toEqual({ enabled: true });
  });

  test("report/file returns per-file stats; missing file is 404", async () => {
    const f = setup();
    const stats = (await (await f("/api/report/file?path=src/main.rs")).json()) as {
      language: string;
      code: number;
      complexity: number;
    };
    expect(stats).toMatchObject({ language: "Rust", code: 40, complexity: 5 });
    expect((await f("/api/report/file?path=README.md")).status).toBe(404);
  });

  test("report/file?stream=1 frames meta/report/done; missing frames meta/missing/done", async () => {
    const f = setup();
    const ok = (await (await f("/api/report/file?path=src/main.rs&stream=1")).text())
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(ok.map((e) => e.type)).toEqual(["meta", "report", "done"]);
    expect(ok[1].stats.code).toBe(40);
    const miss = (await (await f("/api/report/file?path=README.md&stream=1")).text())
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(miss.map((e) => e.type)).toEqual(["meta", "missing", "done"]);
  });

  test("report/prefix rolls up a subtree by language with COCOMO", async () => {
    const f = setup();
    const r = (await (await f("/api/report/prefix?path=src")).json()) as {
      totals: { files: number; code: number; complexity: number };
      by_language: Array<{ name: string; code: number; files: number }>;
      cocomo: { model: string; estimated_cost_usd: number };
    };
    expect(r.totals).toMatchObject({ files: 2, code: 100, complexity: 12 });
    expect(r.by_language).toEqual([
      { name: "Rust", files: 2, bytes: 1600, code: 100, comments: 10, blanks: 10, complexity: 12 },
    ]);
    expect(r.cocomo.model).toBe("basic-organic");
    expect(r.cocomo.estimated_cost_usd).toBeGreaterThan(0);
  });

  test("report/dir on empty path is the whole-workspace roll-up", async () => {
    const f = setup();
    const r = (await (await f("/api/report/dir?path=")).json()) as {
      totals: { files: number; code: number };
      by_language: Array<{ name: string }>;
    };
    expect(r.totals).toMatchObject({ files: 3, code: 110 });
    // Rust (100 code) sorts before Markdown (10 code).
    expect(r.by_language.map((l) => l.name)).toEqual(["Rust", "Markdown"]);
  });
});

describe("uploads", () => {
  const build = () => {
    const s = new MockWorkspaceStore(fixture());
    return { s, g: new DemoGraph(s, []) };
  };

  test("applyUpload writes a text file under dir and returns {path,size}", async () => {
    const { s, g } = build();
    const form = new FormData();
    form.append("file", new File(["# Note\nhi"], "note.md", { type: "text/markdown" }));
    form.append("dir", "docs");
    const res = await applyUpload(s, g, form);
    expect(res).toEqual({ path: "docs/note.md", size: 9 });
    expect(s.read("docs/note.md")?.content).toContain("# Note");
  });

  test("applyUpload replace targets the explicit path", async () => {
    const { s, g } = build();
    const form = new FormData();
    form.append("file", new File(["changed"], "whatever.md"));
    form.append("path", "README.md");
    expect((await applyUpload(s, g, form)).path).toBe("README.md");
    expect(s.read("README.md")?.content).toBe("changed");
  });

  test("applyUpload stores an image as media with byte size, no content", async () => {
    const { s, g } = build();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "pic.png", { type: "image/png" }));
    form.append("dir", "assets");
    const res = await applyUpload(s, g, form);
    expect(res).toEqual({ path: "assets/pic.png", size: 4 });
    const entry = s.get("assets/pic.png");
    expect(entry).toMatchObject({ kind: "media", size: 4 });
    expect(entry?.content).toBeUndefined();
  });

  test("the mock XHR drives an upload through the XHR surface", async () => {
    const { s, g } = build();
    const xhr = createDemoUploadXhr(s, g);
    const form = new FormData();
    form.append("file", new File(["hello"], "up.txt"));
    form.append("dir", "docs");
    xhr.open("POST", "/api/fs/upload");
    const done = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error(xhr.responseText));
    });
    xhr.send(form);
    await done;
    expect(xhr.status).toBe(200);
    expect(JSON.parse(xhr.responseText)).toEqual({ path: "docs/up.txt", size: 5 });
    expect(s.read("docs/up.txt")?.content).toBe("hello");
  });

  test("POST /api/attachments lands under attachments/ and returns the path", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = demoFetch(st);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9, 9])], "diagram.png", { type: "image/png" }));
    const res = (await (await f("/api/attachments", { method: "POST", body: form })).json()) as {
      path: string;
    };
    expect(res.path).toBe("attachments/diagram.png");
    expect(st.list("attachments").map((e) => e.path)).toContain("attachments/diagram.png");
  });
});

describe("metadata export / import", () => {
  test("export carries archive headers and captures live edits", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = demoFetch(st);
    await f("/api/fs/README.md", { method: "PUT", body: "edited" });
    const res = await f("/api/metadata/export", { method: "POST" });
    expect(res.headers.get("content-disposition")).toContain("metadata.json");
    expect(Number(res.headers.get("x-chan-metadata-files"))).toBeGreaterThan(0);
    const archive = JSON.parse(await res.text()) as { format: string; files: Array<{ path: string }> };
    expect(archive.format).toBe("chan-demo-metadata");
    expect(archive.files.find((x) => x.path === "README.md")).toBeTruthy();
  });

  test("import applies an exported archive into a fresh in-memory store", async () => {
    const src = new MockWorkspaceStore(fixture());
    const fsrc = demoFetch(src);
    await fsrc("/api/fs/README.md", { method: "PUT", body: "edited" });
    const archive = await (await fsrc("/api/metadata/export", { method: "POST" })).text();

    const dst = new MockWorkspaceStore(fixture());
    const fdst = demoFetch(dst);
    const form = new FormData();
    form.append("file", new File([archive], "a.json"));
    form.append("rescan", "true");
    const report = (await (await fdst("/api/metadata/import", { method: "POST", body: form })).json()) as {
      files: number;
      rescanned: boolean;
      imported_subtrees: string[];
      manifest: { archive_format_version: number };
    };
    expect(report.files).toBeGreaterThan(0);
    expect(report.rescanned).toBe(true);
    expect(report.imported_subtrees).toContain("README.md");
    expect(report.manifest.archive_format_version).toBe(1);
    expect(dst.read("README.md")?.content).toBe("edited");
  });

  test("importing a non-demo archive is a benign empty report", async () => {
    const st = new MockWorkspaceStore(fixture());
    const f = demoFetch(st);
    const form = new FormData();
    form.append("file", new File(["not an archive"], "x.txt"));
    const report = (await (await f("/api/metadata/import", { method: "POST", body: form })).json()) as {
      files: number;
    };
    expect(report.files).toBe(0);
  });
});

describe("demo downloads (chan-demo.md)", () => {
  afterEach(() => setDownloadHandler(null));

  test("CHAN_DEMO_MD is the About page with a fenced UTF8 QR and the chan.app link", () => {
    expect(CHAN_DEMO_MD).toContain("Your new terminal and workspace manager.");
    expect(CHAN_DEMO_MD).toContain("https://chan.app");
    // UTF8 half-block QR, fenced, no ANSI escapes: square modules that scan and
    // render in both a terminal and a Markdown editor.
    expect(CHAN_DEMO_MD).not.toContain(String.fromCharCode(27)); // no ANSI escape
    expect(CHAN_DEMO_MD).toContain(String.fromCharCode(0x2588)); // full block
    expect(CHAN_DEMO_MD).toContain("```"); // fenced keeps it monospace in Markdown
  });

  test("handleDemoDownload routes through the installed handler, else no-op", () => {
    expect(handleDemoDownload("crates/x.rs", false)).toBe(false);
    const calls: Array<[string, boolean]> = [];
    setDownloadHandler((p, d) => calls.push([p, d]));
    expect(handleDemoDownload("crates/x.rs", false)).toBe(true);
    expect(calls).toEqual([["crates/x.rs", false]]);
  });

  test("demoDownload builds a chan-demo.md anchor from an object URL", () => {
    const created: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "a") created.push(el as HTMLAnchorElement);
        return el;
      });
    const clickSpy = vi
      .spyOn(HTMLElement.prototype, "click")
      .mockImplementation(() => {});
    const urlApi = URL as unknown as {
      createObjectURL: (b: Blob) => string;
      revokeObjectURL: (u: string) => void;
    };
    urlApi.createObjectURL = () => "blob:demo-download";
    urlApi.revokeObjectURL = () => {};
    let clicks = 0;
    try {
      demoDownload();
      clicks = clickSpy.mock.calls.length;
    } finally {
      createSpy.mockRestore();
      clickSpy.mockRestore();
    }
    const anchor = created.at(-1);
    expect(anchor?.download).toBe("chan-demo.md");
    expect(anchor?.getAttribute("href")).toBe("blob:demo-download");
    expect(clicks).toBe(1);
  });
});

describe("MockReports COCOMO", () => {
  test("organic formula and zero case match chan-report/cocomo.rs", () => {
    const r = new MockReports([
      { path: "a.rs", language: "Rust", code: 32000, comments: 0, blanks: 0, complexity: 0, bytes: 0, mtime: null },
    ]);
    // crates/chan-report/src/cocomo.rs: 32 KSLOC organic ~= 91.34 person-months.
    expect(r.prefix("").cocomo.effort_person_months).toBeCloseTo(91.34, 0);
    const empty = new MockReports([]);
    expect(empty.prefix("").cocomo).toMatchObject({
      model: "basic-organic",
      effort_person_months: 0,
      estimated_cost_usd: 0,
    });
  });
});
