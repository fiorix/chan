// Search surfaces for the frontend-only demo, over the in-memory snapshot.
// Serves the three real endpoints with plain-JS scoring instead of the
// server's tantivy/BM25 index: filename fuzzy search (the [[ autocomplete),
// wiki link-target search (file + heading rows), and content search (the
// Search overlay). Good ranking beats faithful ranking here; the wire shapes
// are the contract.

import type {
  ContentHit,
  ContentSearchResponse,
  LinkTarget,
  SearchHit,
} from "../api/types";
import type { DemoGraph } from "./graph";
import type { MockWorkspaceStore } from "./store";

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/// Filename match score: exact basename > basename prefix > basename
/// substring > path substring > in-order subsequence of the basename.
/// Zero means no match.
export function fileScore(path: string, q: string): number {
  const query = q.toLowerCase();
  if (!query) return 1;
  const base = baseName(path).toLowerCase();
  if (base === query || base.replace(/\.(md|txt)$/, "") === query) return 100;
  if (base.startsWith(query)) return 80;
  if (base.includes(query)) return 60;
  if (path.toLowerCase().includes(query)) return 40;
  let i = 0;
  for (const ch of base) {
    if (ch === query[i]) i++;
    if (i === query.length) return 20;
  }
  return 0;
}

export function searchFiles(
  store: MockWorkspaceStore,
  q: string,
  limit: number,
  prefix?: string | null,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const e of store.entries()) {
    if (prefix && !e.path.startsWith(`${prefix}/`) && e.path !== prefix) continue;
    const score = fileScore(e.path, q);
    if (score > 0) hits.push({ path: e.path, score });
  }
  hits.sort((a, z) => z.score - a.score || a.path.length - z.path.length);
  return hits.slice(0, limit);
}

export function linkTargets(graph: DemoGraph, q: string, limit: number): LinkTarget[] {
  const query = q.toLowerCase();
  const rows: Array<LinkTarget & { score: number }> = [];
  for (const doc of graph.documents()) {
    const title = doc.headings.find((h) => h.level === 1)?.text ?? null;
    const score = Math.max(
      fileScore(doc.path, q),
      title && title.toLowerCase().includes(query) ? 70 : 0,
    );
    if (score > 0) {
      rows.push({ kind: "File", path: doc.path, title, score });
    }
    if (query) {
      for (const h of doc.headings) {
        if (!h.text.toLowerCase().includes(query)) continue;
        rows.push({
          kind: "Heading",
          path: doc.path,
          heading: h.text,
          anchor: h.anchor,
          level: h.level,
          score: 50,
        });
      }
    }
  }
  rows.sort((a, z) => z.score - a.score || a.path.length - z.path.length);
  return rows.slice(0, limit).map(({ score: _score, ...row }) => row);
}

/// Nearest heading at or above `line` (0-based), as the hit's breadcrumb.
function headingFor(graph: DemoGraph, path: string, line: number, lines: string[]): string {
  let best = "";
  let inFence = false;
  let ord = -1;
  const rows = graph.headings(path);
  for (let i = 0; i <= line && i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s/.test(lines[i])) ord++;
  }
  if (ord >= 0 && ord < rows.length) best = rows[ord].text;
  return best;
}

export function searchContent(
  store: MockWorkspaceStore,
  graph: DemoGraph,
  q: string,
  limit: number,
): ContentSearchResponse {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Array<ContentHit & { rank: number }> = [];
  if (terms.length > 0) {
    for (const e of store.entries()) {
      if (!e.content) continue;
      const lines = e.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        const matched = terms.filter((t) => line.includes(t)).length;
        if (matched === 0) continue;
        // Rank: all-terms lines beat partial ones; markdown beats source.
        const rank = matched * 10 + (matched === terms.length ? 20 : 0) + (e.kind === "document" ? 5 : 0);
        hits.push({
          path: e.path,
          chunk_id: `${e.path}:${i + 1}`,
          heading: e.kind === "document" ? headingFor(graph, e.path, i, lines) : "",
          start_line: i + 1,
          snippet: lines[i].trim().slice(0, 240),
          score: rank,
          rank,
        });
        break; // One hit per file keeps the result list diverse.
      }
    }
  }
  hits.sort((a, z) => z.rank - a.rank || a.path.length - z.path.length);
  return {
    ready: true,
    readiness: { state: "ready", generation: 0 },
    mode: "bm25",
    hits: hits.slice(0, limit).map(({ rank: _rank, ...hit }) => hit),
  };
}

export function mentionLabels(
  graph: DemoGraph,
  q: string,
  limit: number,
): Array<{ label: string }> {
  const query = q.toLowerCase();
  return graph
    .mentionNames()
    .filter((name) => !query || name.toLowerCase().startsWith(query))
    .slice(0, limit)
    .map((name) => ({ label: `@@${name}` }));
}
