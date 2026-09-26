// Synthetic graph for the standalone graph-tuner playground.
//
// Mirrors what GraphCanvas.svelte actually consumes in production (the
// RenderedNode / RenderedEdge shapes), NOT the raw server GraphView.
// GraphPanel maps `media`->file, `directory`->folder and drops `date`
// before handing the graph to GraphCanvas, so this generator emits the
// post-map kinds directly: file (doc / source / binary / media by
// extension, plus `contact`), tag, mention, language, folder (incl. the
// id:"" workspace root); edges are link / tag / mention / contains /
// language.
//
// The filesystem hierarchy is fixed and legible (so the spine reads the
// same every reload); the seed only varies the link / tag / mention
// wiring, so two force tunings can be compared against an identical
// shape. Emitting real folder nodes + `contains` edges is the whole
// point: the hierarchy forces (hierarchyYSpacing / hierarchyYStrength /
// parentXStrength) can only be tuned against a graph that has a spine.

import type { GraphViewEdge, GraphViewNode } from "../api/types";
import { basename, parentDir } from "../state/format";

// The exact subset GraphCanvas accepts. Structurally identical to its
// internal RenderedNode / RenderedEdge, so these arrays drop straight
// into the GraphCanvas props with no cast.
export type TunerNode = Extract<
  GraphViewNode,
  { kind: "file" | "tag" | "mention" | "language" | "folder" }
>;
export type TunerEdge = GraphViewEdge & {
  kind: "link" | "tag" | "mention" | "contains" | "language" | "group";
};
export type TunerGraph = { nodes: TunerNode[]; edges: TunerEdge[] };

export type GraphSpec = {
  /// Varies the link / tag / mention wiring (the tree stays fixed).
  seed: number;
  /// Probability a given document references each other document
  /// (outgoing wiki links).
  linkDensity: number;
  /// Average tags attached per document.
  tagsPerDoc: number;
  /// Average mentions attached per document.
  mentionsPerDoc: number;
};

export const defaultSpec: GraphSpec = {
  seed: 1,
  linkDensity: 0.05,
  tagsPerDoc: 1.4,
  mentionsPerDoc: 0.5,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- fixed workspace tree ---------------------------------------------

const WORKSPACE_LABEL = "my-notes";

/// Directories, shallowest first. Paths are workspace-relative; the
/// generator derives ids + `contains` edges from them.
const DIRS = ["notes", "notes/daily", "projects", "projects/chan", "assets", ".Drafts"];

/// Files by path. `contact: true` sets node_kind so classifyFile routes
/// them to the contact bucket; `missing: true` marks a ghost (broken
/// wiki-link target) so the dashed-ghost styling is exercised.
type FileSpec = { path: string; contact?: boolean; missing?: boolean };
const FILES: FileSpec[] = [
  // root-level docs
  { path: "README.md" },
  { path: "TODO.md" },
  // notes/
  { path: "notes/ideas.md" },
  { path: "notes/reading.md" },
  { path: "notes/alice.md", contact: true },
  { path: "notes/bob.md", contact: true },
  // notes/daily/
  { path: "notes/daily/2026-06-01.md" },
  { path: "notes/daily/2026-06-02.md" },
  { path: "notes/daily/2026-06-03.md" },
  // projects/
  { path: "projects/roadmap.md" },
  // projects/chan/ (source + binary + doc)
  { path: "projects/chan/design.md" },
  { path: "projects/chan/main.rs" },
  { path: "projects/chan/lib.rs" },
  { path: "projects/chan/app.ts" },
  { path: "projects/chan/notes.txt" },
  { path: "projects/chan/data.bin" },
  // assets/ (media)
  { path: "assets/logo.png" },
  { path: "assets/diagram.png" },
  { path: "assets/report.pdf" },
  // .Drafts/ (renders with the drafts tint; id directory:.Drafts)
  { path: ".Drafts/draft-1.md" },
  { path: ".Drafts/draft-2.md" },
  // ghost target of a broken wiki link (indexed-then-vanished)
  { path: "notes/archived.md", missing: true },
];

const TAG_NAMES = ["idea", "todo", "research", "wip", "personal", "ship"];
const MENTION_NAMES = ["alice", "bob", "carol", "dave"];

/// Language nodes + the file extensions they own. Language nodes are
/// non-hierarchical (depth -1), so they float on the center force and
/// exercise the `language` edge kind + colour.
const LANGUAGES: { name: string; label: string; exts: string[] }[] = [
  { name: "Rust", label: "Rust", exts: [".rs"] },
  { name: "TypeScript", label: "TypeScript", exts: [".ts"] },
  { name: "Markdown", label: "Markdown", exts: [".md"] },
];

const dirId = (path: string) => `directory:${path}`;
const fileId = (path: string) => `file:${path}`;
const parentDirOf = (path: string): string => {
  const dir = parentDir(path);
  return dir === "" ? "" : dirId(dir);
};
const isDoc = (path: string) => /\.(md|txt)$/i.test(path);

export function makeTunerGraph(spec: GraphSpec = defaultSpec): TunerGraph {
  const rng = mulberry32(spec.seed);
  const nodes: TunerNode[] = [];
  const edges: TunerEdge[] = [];

  // Workspace root (folder id ""): the structural anchor.
  nodes.push({
    kind: "folder",
    id: "",
    label: WORKSPACE_LABEL,
    path: "",
    files: FILES.filter((f) => !f.missing).length,
    code: 0,
  });

  // Directory nodes + their containment edge from the parent.
  for (const path of DIRS) {
    nodes.push({
      kind: "folder",
      id: dirId(path),
      label: basename(path),
      path,
      files: FILES.filter((f) => f.path.startsWith(`${path}/`) && !f.missing).length,
      code: 0,
    });
    edges.push({ source: parentDirOf(path), target: dirId(path), kind: "contains" });
  }

  // File nodes + their containment edge from the parent directory.
  // Ghost (missing) files are link targets only, with no containment edge,
  // matching the backend (it drops the node+edge, we keep a dashed one).
  const docIds: string[] = [];
  for (const f of FILES) {
    nodes.push(
      f.missing
        ? { kind: "file", id: fileId(f.path), label: basename(f.path), path: f.path, missing: true }
        : f.contact
          ? { kind: "file", id: fileId(f.path), label: basename(f.path), path: f.path, node_kind: "contact" }
          : { kind: "file", id: fileId(f.path), label: basename(f.path), path: f.path },
    );
    if (f.missing) continue;
    edges.push({ source: parentDirOf(f.path), target: fileId(f.path), kind: "contains" });
    if (isDoc(f.path)) docIds.push(fileId(f.path));
  }

  // Tag nodes.
  const tagIds = TAG_NAMES.map((name) => {
    const id = `tag:${name}`;
    nodes.push({ kind: "tag", id, label: `#${name}` });
    return id;
  });

  // Mention nodes.
  const mentionIds = MENTION_NAMES.map((name) => {
    const id = `mention:${name}`;
    nodes.push({ kind: "mention", id, label: `@${name}` });
    return id;
  });

  // Language nodes + language edges to every file of a matching ext.
  for (const lang of LANGUAGES) {
    const owned = FILES.filter(
      (f) => !f.missing && lang.exts.some((e) => f.path.toLowerCase().endsWith(e)),
    );
    if (owned.length === 0) continue;
    const id = `language:${lang.name}`;
    nodes.push({
      kind: "language",
      id,
      label: lang.label,
      language: lang.name,
      files: owned.length,
      code: owned.length * 40,
    });
    for (const f of owned) {
      edges.push({ source: id, target: fileId(f.path), kind: "language" });
    }
  }

  // Doc -> doc wiki links (seeded), plus a few always-on anchor links so
  // the graph never reads as disconnected, and one broken link to the
  // ghost file.
  const seen = new Set<string>();
  const pushLink = (source: string, target: string, broken = false): void => {
    if (source === target) return;
    const k = `${source}|${target}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(broken ? { source, target, kind: "link", broken } : { source, target, kind: "link" });
  };
  for (const source of docIds) {
    for (const target of docIds) {
      if (rng() < spec.linkDensity) pushLink(source, target);
    }
  }
  // Anchor links so the doc cluster is always connected.
  pushLink(fileId("README.md"), fileId("notes/ideas.md"));
  pushLink(fileId("README.md"), fileId("projects/roadmap.md"));
  pushLink(fileId("notes/ideas.md"), fileId("notes/reading.md"));
  pushLink(fileId("projects/roadmap.md"), fileId("projects/chan/design.md"));
  // Doc -> image embeds.
  pushLink(fileId("projects/chan/design.md"), fileId("assets/diagram.png"));
  pushLink(fileId("README.md"), fileId("assets/logo.png"));
  // Broken wiki link to the ghost file.
  pushLink(fileId("notes/ideas.md"), fileId("notes/archived.md"), true);

  // Doc -> tag / mention attachments (seeded, Poisson-ish per doc).
  const attach = (source: string, pool: string[], avg: number, kind: "tag" | "mention"): void => {
    if (pool.length === 0) return;
    const n = Math.max(0, Math.min(pool.length, Math.round(avg + (rng() - 0.5) * 2)));
    const picks = new Set<number>();
    while (picks.size < n) picks.add(Math.floor(rng() * pool.length));
    for (const i of picks) edges.push({ source, target: pool[i], kind });
  };
  for (const source of docIds) {
    attach(source, tagIds, spec.tagsPerDoc, "tag");
    attach(source, mentionIds, spec.mentionsPerDoc, "mention");
  }

  return { nodes, edges };
}
