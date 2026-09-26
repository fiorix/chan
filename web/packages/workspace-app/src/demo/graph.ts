// Markdown-derived graph for the test transport. Reproduces, in JS, the
// derivation chan-workspace does in Rust (crates/chan-workspace/src/markdown):
// wiki links and markdown links become link edges, #tags become tag edges,
// @@names become mention edges, ATX headings become the per-file outline.
// Missing link targets become ghost file nodes (missing: true), matching the
// server's GraphNodeView synthesis.
//
// The graph indexes document-kind files only (markdown), like the real graph
// DB. It updates incrementally: the router calls indexFile/removeFile on the
// mock's in-memory writes so a saved edit reshapes the graph live.

import type {
  GraphEdge,
  GraphView,
  GraphViewEdge,
  GraphViewNode,
  HeadingRow,
  ReportFileStats,
} from "../api/types";
import { fenceLineTracker } from "../editor/commands/fence";
import { parentDir } from "../state/format";
import type { MockWorkspaceStore } from "./store";

/// One parsed outgoing reference, pre-resolution.
type RawLink = {
  /// Target as written (wiki target or md href), minus anchor.
  target: string;
  anchor: string | null;
  wiki: boolean;
};

type FileIndex = {
  links: RawLink[];
  tags: string[];
  mentions: string[];
  headings: HeadingRow[];
};

/// Resolved edge in the raw (backlinks) shape plus the resolution the
/// /api/links snapshot wants.
type ResolvedEdge = GraphEdge & { wiki: boolean; missing: boolean };

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function fileLabel(path: string): string {
  return baseName(path).replace(/\.(md|markdown|txt)$/i, "");
}

/// Join + normalize a relative href against a source directory, POSIX-style.
function joinNormalize(dir: string, href: string): string {
  const parts: string[] = dir === "" ? [] : dir.split("/");
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/// GitHub-style heading slug, close enough to the server's anchors for the
/// demo outline and anchored links.
function headingAnchor(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/// Strip fenced code blocks and inline code spans so their contents never
/// produce tags or links (mirrors the Rust parser skipping code).
function stripCode(content: string): string {
  return content
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

const WIKI_LINK = /\[\[([^\]]+?)\]\]/g;
const MD_LINK = /!?\[[^\]]*\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;
const TAG = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
const MENTION = /(^|[\s(])@@([A-Za-z0-9][\w-]*)/g;
const EXTERNAL_HREF = /^[a-z][a-z0-9+.-]*:/i;

export function parseMarkdown(content: string): FileIndex {
  const headings: HeadingRow[] = [];
  // Headings scan runs line-wise with a fence tracker (stripCode would drop
  // heading-looking lines inside fences anyway, but ord must count real
  // headings only, in document order).
  const fence = fenceLineTracker();
  let ord = 0;
  for (const line of content.split("\n")) {
    if (fence(line) !== "text") continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    headings.push({
      level: m[1].length,
      text: m[2],
      anchor: headingAnchor(m[2]),
      ord: ord++,
    });
  }

  const text = stripCode(content);
  const links: RawLink[] = [];
  const tags = new Set<string>();
  const mentions = new Set<string>();

  for (const m of text.matchAll(WIKI_LINK)) {
    // [[target]], [[target|label]], [[target#anchor|label]]
    const inner = m[1].split("|")[0].trim();
    if (!inner) continue;
    const hash = inner.indexOf("#");
    const target = (hash < 0 ? inner : inner.slice(0, hash)).trim();
    const anchor = hash < 0 ? null : inner.slice(hash + 1).trim() || null;
    if (target) links.push({ target, anchor, wiki: true });
  }

  for (const m of text.matchAll(MD_LINK)) {
    let href = m[1];
    if (EXTERNAL_HREF.test(href) || href.startsWith("#")) continue;
    let anchor: string | null = null;
    const hash = href.indexOf("#");
    if (hash >= 0) {
      anchor = href.slice(hash + 1) || null;
      href = href.slice(0, hash);
    }
    href = href.replace(/\?[^#]*$/, "");
    try {
      href = decodeURIComponent(href);
    } catch {
      // Keep the raw href when it is not valid percent-encoding.
    }
    if (href) links.push({ target: href, anchor, wiki: false });
  }

  for (const m of text.matchAll(TAG)) tags.add(m[2]);
  for (const m of text.matchAll(MENTION)) mentions.add(m[2]);

  return { links, tags: [...tags], mentions: [...mentions], headings };
}

export class DemoGraph {
  #store: MockWorkspaceStore;
  #files = new Map<string, FileIndex>();
  /// Lowercased document basename (with extension) to paths, for the wiki
  /// basename resolution the real link_targets table provides.
  #basenames = new Map<string, string[]>();
  /// Report language + code per file, for the graph's language layer.
  #reportByPath = new Map<string, { language: string; code: number }>();

  constructor(store: MockWorkspaceStore, reportRows: ReportFileStats[] = []) {
    this.#store = store;
    for (const e of store.entries()) {
      if (e.kind === "document" && e.content) {
        this.#files.set(e.path, parseMarkdown(e.content));
      }
    }
    for (const r of reportRows) {
      this.#reportByPath.set(r.path, { language: r.language, code: r.code });
    }
    this.#rebuildBasenames();
  }

  #rebuildBasenames(): void {
    this.#basenames = new Map();
    for (const e of this.#store.entries()) {
      if (e.kind !== "document" && e.kind !== "media") continue;
      const key = baseName(e.path).toLowerCase();
      const list = this.#basenames.get(key) ?? [];
      list.push(e.path);
      this.#basenames.set(key, list);
    }
  }

  indexFile(path: string, content: string): void {
    this.#files.set(path, parseMarkdown(content));
    this.#rebuildBasenames();
  }

  removeByPrefix(path: string): void {
    for (const p of [...this.#files.keys()]) {
      if (p === path || p.startsWith(`${path}/`)) this.#files.delete(p);
    }
    this.#rebuildBasenames();
  }

  renameFile(from: string, to: string): void {
    const idx = this.#files.get(from);
    this.#files.delete(from);
    if (idx) this.#files.set(to, idx);
    this.#rebuildBasenames();
  }

  /// Resolve a link target from a source directory to a workspace path.
  /// Probes the exact path, then .md / .txt suffixes, then (wiki only) a
  /// workspace-wide document basename match. Null when nothing matches.
  resolve(target: string, fromDir: string, wiki: boolean): string | null {
    const rel = target.startsWith("/")
      ? joinNormalize("", target)
      : joinNormalize(fromDir, target);
    for (const probe of [rel, `${rel}.md`, `${rel}.txt`]) {
      if (this.#store.get(probe)) return probe;
    }
    if (wiki) {
      const base = baseName(rel).toLowerCase();
      for (const key of [`${base}.md`, base]) {
        const hits = this.#basenames.get(key);
        if (hits && hits.length > 0) return hits[0];
      }
    }
    return null;
  }

  /// All resolved outgoing edges of one file, raw shape.
  #fileEdges(path: string, idx: FileIndex): ResolvedEdge[] {
    const dir = parentDir(path);
    const edges: ResolvedEdge[] = [];
    for (const link of idx.links) {
      const resolved = this.resolve(link.target, dir, link.wiki);
      if (resolved !== null && this.#store.isDir(resolved)) continue;
      // Ghost target: workspace-rooted normalized path, defaulting to .md
      // for extensionless wiki targets so the ghost label reads naturally.
      const ghost = link.target.startsWith("/")
        ? joinNormalize("", link.target)
        : joinNormalize(dir, link.target);
      const dst =
        resolved ?? (link.wiki && !/\.[A-Za-z0-9]+$/.test(ghost) ? `${ghost}.md` : ghost);
      if (!dst || dst === path) continue;
      edges.push({
        src: path,
        dst,
        kind: "link",
        anchor: link.anchor,
        wiki: link.wiki,
        missing: resolved === null,
      });
    }
    for (const tag of idx.tags) {
      edges.push({ src: path, dst: `#${tag}`, kind: "tag", anchor: null, wiki: false, missing: false });
    }
    for (const name of idx.mentions) {
      edges.push({
        src: path,
        dst: `@@${name}`,
        kind: "mention",
        anchor: null,
        wiki: false,
        missing: false,
      });
    }
    return edges;
  }

  /// The unified /api/graph view, mirroring the server's two layers
  /// (chan-server routes/graph.rs merge_unified_tree_layer):
  ///
  ///   1. Filesystem tree spine: a root directory node (id "", label "/"),
  ///      `directory:<path>` nodes chained by `contains` edges, and EVERY
  ///      tree file as a file/media node hung off its parent directory.
  ///   2. Semantic layer: wiki/md link, tag, and mention edges from the
  ///      indexed markdown, plus tag / mention / ghost nodes.
  view(): GraphView {
    const nodes = new Map<string, GraphViewNode>();
    const edges: GraphViewEdge[] = [];
    const edgeSet = new Set<string>();
    const pushEdge = (edge: GraphViewEdge): void => {
      const key = `${edge.source} ${edge.target} ${edge.kind}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push(edge);
    };

    const dirId = (p: string): string => (p === "" ? "" : `directory:${p}`);
    const ensureDir = (p: string): void => {
      const id = dirId(p);
      if (nodes.has(id)) return;
      nodes.set(id, {
        kind: "directory",
        id,
        label: p === "" ? "/" : baseName(p),
        path: p,
        files: 0,
        code: 0,
      });
      if (p === "") return;
      const parent = parentDir(p);
      ensureDir(parent);
      pushEdge({ source: dirId(parent), target: id, kind: "contains" });
    };

    ensureDir("");
    for (const e of this.#store.entries()) {
      const parent = parentDir(e.path);
      ensureDir(parent);
      if (e.kind === "media") {
        nodes.set(e.path, { kind: "media", id: e.path, label: baseName(e.path), path: e.path });
      } else {
        nodes.set(e.path, { kind: "file", id: e.path, label: fileLabel(e.path), path: e.path });
      }
      pushEdge({ source: dirId(parent), target: e.path, kind: "contains" });
    }

    for (const [path, idx] of this.#files) {
      for (const e of this.#fileEdges(path, idx)) {
        if (!nodes.has(e.dst)) {
          if (e.kind === "tag") {
            nodes.set(e.dst, { kind: "tag", id: e.dst, label: e.dst.slice(1) });
          } else if (e.kind === "mention") {
            nodes.set(e.dst, { kind: "mention", id: e.dst, label: e.dst.slice(2) });
          } else {
            nodes.set(e.dst, {
              kind: "file",
              id: e.dst,
              label: fileLabel(e.dst),
              path: e.dst,
              missing: true,
            });
          }
        }
        const viewEdge: GraphViewEdge = { source: e.src, target: e.dst, kind: e.kind };
        if (e.missing) viewEdge.broken = true;
        pushEdge(viewEdge);
      }
    }

    // Language layer (chan-server routes/graph.rs): one `language:<Name>` node
    // per report language, and a language -> file edge for every file the
    // report classifies. Node carries file count + summed SLOC.
    const byLanguage = new Map<string, { files: number; code: number }>();
    const languageEdges: GraphViewEdge[] = [];
    for (const node of nodes.values()) {
      if (node.kind !== "file") continue;
      const rep = this.#reportByPath.get(node.id);
      if (!rep) continue;
      const agg = byLanguage.get(rep.language) ?? { files: 0, code: 0 };
      agg.files++;
      agg.code += rep.code;
      byLanguage.set(rep.language, agg);
      languageEdges.push({ source: `language:${rep.language}`, target: node.id, kind: "language" });
    }
    for (const [language, agg] of byLanguage) {
      nodes.set(`language:${language}`, {
        kind: "language",
        id: `language:${language}`,
        label: language,
        language,
        files: agg.files,
        code: agg.code,
      });
    }
    for (const edge of languageEdges) pushEdge(edge);

    return { nodes: [...nodes.values()], edges };
  }

  /// Incoming raw edges for /api/backlinks/{path}.
  backlinks(path: string): GraphEdge[] {
    const incoming: GraphEdge[] = [];
    for (const [src, idx] of this.#files) {
      if (src === path) continue;
      for (const e of this.#fileEdges(src, idx)) {
        if (e.dst !== path) continue;
        incoming.push({ src: e.src, dst: e.dst, kind: e.kind, anchor: e.anchor });
      }
    }
    return incoming;
  }

  headings(path: string): HeadingRow[] {
    return this.#files.get(path)?.headings ?? [];
  }

  /// Indexed documents with their outlines, for the search surfaces.
  documents(): Array<{ path: string; headings: HeadingRow[] }> {
    return [...this.#files.entries()].map(([path, idx]) => ({
      path,
      headings: idx.headings,
    }));
  }

  /// Distinct @@Name tokens across the corpus, for the mention picker.
  mentionNames(): string[] {
    const names = new Set<string>();
    for (const idx of this.#files.values()) {
      for (const name of idx.mentions) names.add(name);
    }
    return [...names].sort();
  }
}
