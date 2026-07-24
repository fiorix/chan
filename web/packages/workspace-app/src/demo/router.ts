// The demo's mock fetch. Maps (method, path) to the in-memory store and
// returns synthetic Response objects, so every api call (typed helpers,
// streaming NDJSON readers, and multipart alike) resolves with no backend.
//
// Core surfaces (workspace, config, files, drafts, session) are real. The
// graph, headings, backlinks, and search return empty-but-valid shapes here
// and are filled in by later phases. Everything else returns a benign inert
// response so no surface errors; unhandled paths are logged once so gaps are
// visible during the browser smoke.

import type { FetchImpl } from "../api/transport";
import type { GlobalConfig, Preferences } from "../api/types";
import { DEMO_PREFERENCES, demoWorkspaceInfo } from "./data";
import type { DemoGraph } from "./graph";
import { exportMetadata, importMetadata } from "./metadata";
import type { MockReports } from "./report";
import { linkTargets, mentionLabels, searchContent, searchFiles } from "./search";
import { kindForPath, type MockWorkspaceStore } from "./store";
import { applyUpload } from "./upload";

const JSON_HEADERS = { "content-type": "application/json" } as const;

// Temporary: log every request so gaps and freeze-triggers are visible during
// the browser smoke. Flip off once the demo is stable.
const DEMO_TRACE = true;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data ?? null), { status, headers: JSON_HEADERS });
}
function empty(status = 204): Response {
  return new Response(null, { status });
}
function text(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}
function notFound(message = "not found"): Response {
  return new Response(JSON.stringify({ error: message }), { status: 404, headers: JSON_HEADERS });
}
function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function decodePath(rest: string): string {
  return rest.split("/").map(decodeURIComponent).join("/");
}

function parseBody(init?: RequestInit): unknown {
  const body = init?.body;
  if (typeof body !== "string" || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const warned = new Set<string>();
function warnOnce(key: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[demo] unhandled ${key}`);
}

export function createDemoFetch(
  store: MockWorkspaceStore,
  graph: DemoGraph,
  reports: MockReports,
  preferenceOverrides: Partial<Preferences> = {},
): FetchImpl {
  // Mutable session state the mock owns: preferences (round-tripped through
  // config), plus monotonic counters for draft and terminal naming.
  let prefs: Preferences = { ...DEMO_PREFERENCES, ...preferenceOverrides };
  let draftSeq = 0;
  let termSeq = 0;

  const config = (): GlobalConfig => ({
    preferences: prefs,
    workspaces: [
      {
        path: store.data.metadata.workspaceRoot,
        metadata_key: "demo",
        last_seen_at: new Date(store.data.metadata.generatedAt).toISOString(),
      },
    ],
  });

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input, "http://demo.local");
    const path = u.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const qs = u.searchParams;
    if (DEMO_TRACE) console.debug(`[demo] ${method} ${path}${u.search}`);

    // --- workspace + config ---
    if (path === "/api/workspace" && method === "GET") {
      return json(demoWorkspaceInfo(store.data, prefs));
    }
    if (path === "/api/config") {
      if (method === "GET") return json(config());
      if (method === "PATCH") {
        const body = parseBody(init) as GlobalConfig | undefined;
        if (body?.preferences) prefs = { ...prefs, ...body.preferences };
        return json(config());
      }
    }

    // --- files ---
    if (path === "/api/files") {
      if (method === "GET") return json(store.list(qs.get("dir") ?? ""));
      if (method === "POST") {
        const body = parseBody(init) as { path: string; is_dir: boolean; content?: string };
        store.create(body.path, body.is_dir, body.content);
        if (!body.is_dir && kindForPath(body.path) === "document") {
          graph.indexFile(body.path, body.content ?? "");
        }
        return empty();
      }
    }
    if (path.startsWith("/api/files/")) {
      const rel = decodePath(path.slice("/api/files/".length));
      if (method === "GET") {
        if (qs.has("stream")) return streamFile(store, rel);
        const file = store.read(rel);
        return file ? json(file) : notFound(`no such file: ${rel}`);
      }
      if (method === "PUT") {
        const raw = typeof init?.body === "string" ? init.body : "";
        const parsed = parseBody(init) as { content?: string } | undefined;
        const content = parsed?.content ?? raw;
        const written = store.write(rel, content);
        if (store.get(rel)?.kind === "document") {
          graph.indexFile(rel, content);
        }
        return json(written);
      }
      if (method === "DELETE") {
        store.remove(rel);
        graph.removeByPrefix(rel);
        return empty();
      }
    }
    if (path === "/api/move" && method === "POST") {
      const body = parseBody(init) as { from: string; to: string };
      const moved = store.move(body.from, body.to);
      for (const [from, to] of moved.renamed) graph.renameFile(from, to);
      return json(moved);
    }

    // --- uploads + metadata (multipart / blob; land in memory) ---
    if (path === "/api/attachments" && method === "POST") {
      const form = init?.body instanceof FormData ? init.body : null;
      if (!form) return notFound("no form data");
      const { path: saved } = await applyUpload(store, graph, form, "attachments");
      return json({ path: saved });
    }
    if (path === "/api/metadata/export" && method === "POST") {
      const meta = exportMetadata(store);
      return new Response(meta.body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${meta.filename}"`,
          "x-chan-metadata-files": String(meta.files),
          "x-chan-metadata-bytes": String(meta.bytes),
        },
      });
    }
    if (path === "/api/metadata/import" && method === "POST") {
      const form = init?.body instanceof FormData ? init.body : null;
      const file = form?.get("file");
      const rescan = form?.get("rescan") !== "false";
      const text = file instanceof Blob ? await file.text() : "";
      return json(importMetadata(store, graph, text, { rescan }));
    }
    if (path === "/api/fs/transfer" && method === "POST") {
      const body = parseBody(init) as { op: string; sources: string[]; dest_dir: string };
      const renamed: Array<[string, string]> = [];
      for (const src of body?.sources ?? []) {
        const dest = `${body.dest_dir ? `${body.dest_dir}/` : ""}${src.slice(src.lastIndexOf("/") + 1)}`;
        if (dest === src) continue;
        if (body.op === "move") {
          const moved = store.move(src, dest);
          for (const [from, to] of moved.renamed) graph.renameFile(from, to);
        }
        renamed.push([src, dest]);
      }
      return json({ moved: renamed, copied: [], skipped: [], conflicts: [] });
    }

    // --- drafts ---
    if (path === "/api/drafts/new" && method === "POST") {
      const name = `untitled-${++draftSeq}`;
      const draftPath = `.Drafts/${name}/draft.md`;
      store.create(draftPath, false, "");
      return json({ path: draftPath, name });
    }
    if (path === "/api/drafts/inspect" && method === "POST") {
      const body = parseBody(init) as { path: string };
      return json({
        path: body.path,
        name: body.path.split("/").filter(Boolean).slice(-2, -1)[0] ?? "draft",
        file_count: 1,
        dir_count: 0,
        total_size: 0,
        has_attachments: false,
      });
    }
    if (path === "/api/drafts/discard" && method === "POST") {
      const body = parseBody(init) as { path: string };
      store.remove(body.path);
      return empty();
    }
    if (path === "/api/drafts/promote" && method === "POST") {
      const body = parseBody(init) as { path: string; target: string };
      store.move(body.path, body.target);
      return json({ path: body.target, name: body.target.split("/").pop() ?? "note", mode: "file" });
    }

    // --- session (per-window layout, in memory) ---
    if (path === "/api/session") {
      const w = qs.get("w") ?? "default";
      if (method === "GET") {
        const s = store.getSession(w);
        return s == null ? empty() : json(s);
      }
      if (method === "PUT") {
        store.putSession(w, parseBody(init));
        return empty();
      }
      if (method === "DELETE") {
        store.deleteSession(w);
        return empty();
      }
    }

    // --- graph / headings / backlinks ---
    if (path === "/api/graph" && method === "GET") {
      const view = graph.view();
      if (!qs.has("stream")) return json(view);
      // Same NDJSON framing the server streams: meta, node batches, edge
      // batches, done. One batch each is enough in memory.
      return ndjson([
        {
          type: "meta",
          scope: qs.get("scope") ?? "workspace",
          path: qs.get("path") ?? "",
          depth: Number(qs.get("depth")) || 6,
        },
        { type: "nodes", nodes: view.nodes },
        { type: "edges", edges: view.edges },
        { type: "done" },
      ]);
    }
    if (path === "/api/links" && method === "GET") {
      return json({ edges: [], broken: [], file_count: 0 });
    }
    if (path === "/api/fs-graph" && method === "GET") {
      return fsGraph(
        store,
        qs.get("scope") === "directory" ? "directory" : "file",
        qs.get("path") ?? "",
        Number(qs.get("depth")) || 1,
        qs.has("limit") || qs.has("cursor"),
      );
    }
    if (path.startsWith("/api/headings/") && method === "GET") {
      return json(graph.headings(decodePath(path.slice("/api/headings/".length))));
    }
    if (path.startsWith("/api/backlinks/") && method === "GET") {
      const rel = decodePath(path.slice("/api/backlinks/".length));
      const edges = graph.backlinks(rel);
      if (!qs.has("stream")) return json(edges);
      return ndjson([
        { type: "meta", path: rel },
        ...edges.map((edge) => ({ type: "edge", edge })),
        { type: "done" },
      ]);
    }

    // --- search ---
    if (path === "/api/search/files" && method === "GET") {
      return json(
        searchFiles(store, qs.get("q") ?? "", Number(qs.get("limit")) || 10, qs.get("prefix")),
      );
    }
    if (path === "/api/link-targets" && method === "GET") {
      return json(linkTargets(graph, qs.get("q") ?? "", Number(qs.get("limit")) || 10));
    }
    if (path === "/api/search/content" && method === "GET") {
      return json(searchContent(store, graph, qs.get("q") ?? "", Number(qs.get("limit")) || 20));
    }
    if (path === "/api/contacts" && method === "GET") return json([]);
    if (path === "/api/mentions" && method === "GET") {
      return json(mentionLabels(graph, qs.get("q") ?? "", Number(qs.get("limit")) || 10));
    }
    if (path === "/api/resolve-link" && method === "GET") {
      const target = qs.get("target") ?? "";
      if (store.isDir(target)) return json({ path: target, kind: "file", is_dir: true });
      const resolved = graph.resolve(target, "", true);
      if (resolved === null) return notFound("broken link");
      return json({ path: resolved, kind: "file" });
    }

    // --- chan-reports (SLOC / complexity / COCOMO from the snapshot) ---
    if (path === "/api/report/file" && method === "GET") {
      const rel = qs.get("path") ?? "";
      const stats = reports.file(rel);
      if (qs.has("stream")) {
        return ndjson([
          { type: "meta", path: rel },
          stats ? { type: "report", stats } : { type: "missing" },
          { type: "done" },
        ]);
      }
      return stats ? json(stats) : notFound("no report");
    }
    // /api/report/prefix walks; /api/report/dir is the O(1) cache. Same shape
    // here; empty path is the whole-workspace roll-up.
    if ((path === "/api/report/prefix" || path === "/api/report/dir") && method === "GET") {
      return json(reports.prefix(qs.get("path") ?? ""));
    }
    if (path === "/api/inspector" && method === "GET") {
      return json(store.inspector(qs.get("path") ?? ""));
    }
    if (path === "/api/preflight" && method === "GET") {
      return json({
        phase: "ready",
        locked: false,
        steps: [],
        error: null,
        cs_link: null,
        cs_dismissed: true,
        summary: null,
      });
    }

    // --- index / health / status ---
    if (path === "/api/index/status" && method === "GET") {
      return json({
        state: "idle",
        indexed_docs: store.data.metadata.textCount,
        indexed_vectors: 0,
        model: "none",
      });
    }
    if (path === "/api/indexing/state" && method === "GET") {
      return json({ root: "", nodes: [] });
    }
    if (path === "/api/health" && method === "GET") {
      return json({ instance: "demo", indexer: { status: "idle", queue_depth: 0 } });
    }
    if (path === "/api/build-info" && method === "GET") {
      return json({ version: "demo", features: { embeddings: false } });
    }

    // --- terminals (the sockets do the real work; these seed names/roster) ---
    if (path === "/api/terminal/next-name" && method === "GET") {
      return text(`Terminal ${++termSeq}`);
    }
    if (path === "/api/terminals/roster" && method === "GET") return json({ sessions: [] });
    if (path === "/api/terminals" && method === "POST") {
      return json({ session: `demo-${++termSeq}`, tab_label: "Terminal" });
    }
    if (path.startsWith("/api/terminals/") && (method === "POST" || method === "DELETE")) {
      return empty();
    }

    // --- inert settings surfaces (Phase 6 hardens these) ---
    if (path === "/api/index/excluded-dirs" && method === "GET") {
      return json({ defaults: [], workspace: [], effective: [] });
    }
    if (path === "/api/index/reports/state" && method === "GET") return json({ enabled: true });
    if (path === "/api/index/semantic/state" && method === "GET") {
      return json({
        mode: "bm25",
        model_present: false,
        model_name: "",
        model_path: "",
        model_size_bytes: null,
      });
    }
    if (path === "/api/screensaver/state" && method === "GET") {
      return json({ enabled: false, timeout_secs: 0, theme: "system", pin_set: false });
    }
    if (path === "/api/library/local-color") {
      return method === "GET" ? json({ color: null }) : empty();
    }

    warnOnce(`${method} ${path}`);
    return method === "GET" ? notFound(`unhandled: ${path}`) : empty();
  };
}

// GET /api/fs-graph: filesystem neighborhood of a path. BFS from the anchor
// directory over the in-memory tree, `contains` edges, capped so a giant
// directory cannot flood the canvas. No symlinks or ghosts in the demo.
const FS_GRAPH_NODE_CAP = 400;

function fsGraph(
  store: MockWorkspaceStore,
  scope: "file" | "directory",
  path: string,
  depth: number,
  paged: boolean,
): Response {
  const anchor = scope === "file" ? path.slice(0, Math.max(path.lastIndexOf("/"), 0)) : path;
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  let truncated = false;

  // Ids are bare workspace-relative paths, the ROOT id is the empty string:
  // GraphPanel normalizes fs directory ids into the semantic
  // `directory:<path>` scheme (root stays ""), so the two sources collapse
  // onto one node. A synthetic root id would duplicate the root.
  const nodeFor = (p: string, isDir: boolean) => {
    const e = store.get(p);
    return {
      id: p,
      kind: isDir ? "directory" : "file",
      name: p === "" ? store.data.metadata.label : p.slice(p.lastIndexOf("/") + 1),
      path: p,
      size: e?.size ?? 0,
      mtime: e?.mtime ?? null,
    };
  };

  nodes.push(nodeFor(anchor, true));
  const queue: Array<{ dir: string; level: number }> = [{ dir: anchor, level: 0 }];
  while (queue.length > 0) {
    const { dir, level } = queue.shift()!;
    if (level >= depth) continue;
    for (const entry of store.list(dir)) {
      if (nodes.length >= FS_GRAPH_NODE_CAP) {
        truncated = true;
        break;
      }
      nodes.push(nodeFor(entry.path, entry.is_dir));
      edges.push({ source: dir, target: entry.path, kind: "contains" });
      if (entry.is_dir) queue.push({ dir: entry.path, level: level + 1 });
    }
    if (truncated) break;
  }

  const body: Record<string, unknown> = {
    root: store.data.metadata.label,
    scope,
    path,
    depth,
    nodes,
    edges,
    truncated,
  };
  if (paged) {
    body.cursor = null;
    body.done = true;
  }
  return json(body);
}

// GET /api/files/<path>?stream=1: emit the meta/chunk/done NDJSON the editor's
// streaming reader expects, from the in-memory file.
function streamFile(store: MockWorkspaceStore, rel: string): Response {
  const file = store.read(rel);
  if (!file) return notFound(`no such file: ${rel}`);
  return ndjson([
    {
      type: "meta",
      path: file.path,
      mtime: file.mtime,
      mtime_ns: file.mtime_ns ?? null,
      writable: true,
      size: file.content.length,
    },
    { type: "chunk", content: file.content, bytes: file.content.length },
    { type: "done" },
  ]);
}
