// Wiki bubble: file picker for the `[[query` trigger, plus heading
// picker for `[[target#headingFilter`.
//
// Mode switch happens automatically inside setQuery: a `#` in the
// query splits it into target + headingFilter and switches the bubble
// to heading mode, fetching /api/headings/{target} once per target
// (in-memory filter on subsequent typing). When the user backspaces
// past the `#` the bubble drops back to file mode.
//
// File mode: /api/link-targets for the query (debounced), top
// file/heading results. File hits commit `[[target]]`; heading hits
// commit `[[target#anchor]]`.
// Heading mode: filtered headings list, commit replaces `[[query`
// with `[[target#anchor]]` where anchor is the slug returned by the
// server (so the on-disk link survives a heading rename without
// chasing the source text).
// Block mode: parses `^id` markers out of the target file body via
// wikiBlocks.parseBlocks; commit either reuses an existing anchor or
// CAS-writes a fresh one onto the picked paragraph.
//
// Errors render in the status footer; the list stays empty so nothing
// commits. Stale fetches drop via reqSeq.

import type { EditorView } from "@codemirror/view";
import { openBubbleShell } from "../bubble";
import type { BubbleHandle } from "./types";
import { createCaretAnchor } from "./anchor";
import { api } from "../../api/client";
import type { LinkTarget, TreeEntry } from "../../api/types";
import { indexStatus, tree } from "../../state/store.svelte";
import { windowCaps } from "../../state/windowCaps";
import { decodePercent, encodeRelPath, relativizePath, wikiLinkToMarkdown } from "../links";
import { parseInternalLink } from "../widgets/wikilink";
import {
  filterBlocks,
  insertBlockAnchor,
  makeBlockId,
  parseBlocks,
  type ParsedBlock,
} from "../extensions/wikiBlocks";
import {
  completionEmptyState,
  indexInProgress,
  renderBubbleEmptyState,
} from "./empty_state";

export interface WikiBubbleOpts {
  view: EditorView;
  triggerStart: number;
  triggerEnd: number;
  initialQuery: string;
  /// Reserved path scope from the host. File mode currently uses
  /// /api/link-targets globally so title/heading matches are visible.
  prefix: string | null;
  /// "wrap" (default): commit inserts `[[path]]`. Used when the user
  /// typed `[[` from scratch.
  /// "raw": commit inserts just `path`. Used when the caret is inside
  /// an existing `[label](path)` URL portion (the brackets stay).
  /// "code": like "raw" but the inserted path is percent-encoded so it
  /// survives inline-code link detection. Used inside `` `code` `` links.
  templateMode?: "wrap" | "raw" | "code";
  /// Path of the file being edited (workspace-rooted POSIX, no leading
  /// slash), or null when there is no source file (chat bubble, unsaved
  /// draft). Used to relativize the inserted link target so notes stay
  /// portable across project layouts. Null falls back to a workspace-
  /// rooted target.
  fromPath?: string | null;
  /// Cmd+Enter handler. Called with the currently-selected hit's
  /// target (or the trigger's parsed target if no hit is selected).
  /// Returns the navigation surface to the host (FileEditorTab calls
  /// openInActivePane). Optional; when omitted, Cmd+Enter is a no-op.
  onOpenLink?: (target: string, anchor: string | null) => void;
  onDismiss: () => void;
}

const SEARCH_LIMIT = 5;
const HEADING_LIMIT = 8;
const BLOCK_LIMIT = 8;
// Cap on client-synthesized workspace-PATH candidates merged in beside
// the /api/link-targets hits. Keeps a path query (e.g. `[[docs/`) from
// flooding the list while still surfacing the matches that matter.
const PATH_LIMIT = 8;

/// Build workspace-PATH completion candidates from the file tree.
/// `[[` completes BOTH names (/api/link-targets) AND
/// workspace paths. Paths are done CLIENT-SIDE here off the existing
/// /api/files tree listing - no backend route change.
///
/// A candidate is a FILE whose full rel_path either starts with the
/// query (rank 1; discoverable from the first segment, e.g. `[[docs`
/// surfaces `docs/...`) or, once the query is an explicit path (has a
/// `/`), contains it (rank 2). Directories are skipped: a file's row
/// already shows its full path, so the user drills in by typing more
/// of the path rather than committing an unresolvable directory link.
function computePathHits(q: string, entries: TreeEntry[]): LinkTarget[] {
  const query = q.toLowerCase();
  if (query === "") return [];
  const hasSlash = query.includes("/");
  const scored: Array<{ rank: number; entry: TreeEntry }> = [];
  for (const entry of entries) {
    if (entry.is_dir) continue;
    const p = entry.path.toLowerCase();
    let rank: number;
    if (p.startsWith(query)) rank = 1;
    else if (hasSlash && p.includes(query)) rank = 2;
    else continue;
    scored.push({ rank, entry });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored.slice(0, PATH_LIMIT).map(({ entry }) => ({
    kind: "Path" as const,
    path: entry.path,
    title: null,
    heading: null,
    anchor: null,
    level: null,
    mtime: entry.mtime ?? null,
  }));
}
const FETCH_DEBOUNCE_MS = 60;
// Poll interval for the index-completion watch (see startIndexWatch).
const INDEX_WATCH_MS = 200;

/// Matches a COMPLETE wiki link `[[...]]` anywhere in the doc. Used to
/// pick a file's link style: a file that already contains one keeps
/// emitting wiki links; every other file emits relative markdown. The
/// in-progress `[[query` trigger has no closing `]]`, so it never
/// matches and a fresh file stays in markdown mode while authoring.
const WIKI_LINK_RE = /\[\[[^[\]\n]+\]\]/;

interface HeadingHit {
  level: number;
  text: string;
  anchor: string;
}

/// A sentinel hit, prepended in raw `[label](url)` mode, that OPENS the link
/// already in the URL slot rather than searching for a replacement. Without it
/// the URL-slot autocomplete only lists /api/link-targets search results, so
/// the link the user is sitting on can never be opened from the bubble.
interface SelfHit {
  kind: "Self";
  /// Canonical resolved target (workspace-rooted), passed to onOpenLink.
  target: string;
  anchor: string | null;
  /// The literal URL-slot text, shown in the row.
  url: string;
}

function isSelfHit(hit: unknown): hit is SelfHit {
  return (hit as { kind?: string } | null)?.kind === "Self";
}

interface WikiBubbleHandle extends BubbleHandle {
  setTriggerEnd(end: number): void;
}

type Mode =
  | { kind: "file" }
  | { kind: "heading"; target: string; filter: string }
  | { kind: "block"; target: string; filter: string };

/// Split the query into target + anchor-filter. Whichever separator
/// (`#` for heading, `^` for block) appears FIRST wins. `target^id`
/// switches to block mode; `target#text` to heading mode. The user
/// can backspace past the separator to drop back to file mode.
function classifyQuery(q: string): Mode {
  const headIdx = q.indexOf("#");
  const blockIdx = q.indexOf("^");
  const idx =
    blockIdx < 0 ? headIdx : headIdx < 0 ? blockIdx : Math.min(blockIdx, headIdx);
  if (idx < 0) return { kind: "file" };
  const target = q.slice(0, idx);
  const filter = q.slice(idx + 1);
  if (q[idx] === "^") return { kind: "block", target, filter };
  return { kind: "heading", target, filter };
}

/// In "raw" mode the trigger query is an existing link URL (a relative
/// or workspace path like `../../team-x/bootstrap.md`), not something
/// the user typed to search. `link_targets` ranks on basename/title,
/// so searching the verbatim path matches nothing and the picker dead-
/// ends on "No matches" - which is what a plain click on a relative-
/// markdown link pill produced before this. Reduce the URL to its last
/// path segment (anchor/query stripped, percent-decoded) so the linked
/// file surfaces as a hit: the user can re-pick it (Enter) or open it
/// (Cmd+Enter), matching the click-the-pill intent.
function rawSearchTerm(q: string): string {
  const noAnchor = q.split(/[#?]/)[0] ?? q;
  const seg =
    noAnchor.split("/").filter((s) => s !== "" && s !== "." && s !== "..").pop() ?? "";
  return decodePercent(seg);
}

export function openWikiBubble(opts: WikiBubbleOpts): WikiBubbleHandle {
  // Anchor at the opening `[[` (triggerStart) so the bubble lines up
  // with where the user started the link. Visually this reads better
  // than anchoring at the live caret, which would slide the bubble
  // sideways as the query grows and leave it floating off-axis from
  // the link being authored. positionPopover already clamps the
  // bubble inside the viewport when the trigger sits near the right
  // edge, so the only cost is the long-query wrap case (the bubble
  // can overlap the wrapped text); short queries are the common path.
  const anchorPos = (): number => opts.triggerStart;
  const anchor = createCaretAnchor(opts.view, anchorPos());
  const shell = openBubbleShell({
    host: anchor.el,
    className: "md-wiki-bubble cm-bubble",
  });

  let query = opts.initialQuery;
  let triggerEnd = opts.triggerEnd;
  // "raw" (a markdown `[label](url)` / `![alt](url)` URL slot) and "code"
  // (an inline `` `code` `` file link) both fill an existing slot instead
  // of wrapping a fresh construct: file mode only, basename search, and no
  // `#`/`^` authoring separators (a `#`/`^` here is part of the slot's
  // on-disk URL/anchor). They differ only at commit: "code" percent-
  // encodes the inserted path so it survives inline-code link detection.
  const slotMode = opts.templateMode === "raw" || opts.templateMode === "code";
  let mode: Mode = slotMode ? { kind: "file" } : classifyQuery(query);
  // File-mode results from /api/link-targets.
  let fileHits: LinkTarget[] = [];
  // Client-synthesized workspace-PATH candidates (see computePathHits),
  // merged into the file-mode list. `allEntries` caches the workspace
  // file tree for the bubble's lifetime so we fetch it at most once per
  // `[[` session; `treePromise` dedupes concurrent loads.
  let pathHits: LinkTarget[] = [];
  let allEntries: TreeEntry[] | null = null;
  let treePromise: Promise<void> | null = null;
  // Heading-mode all-headings cache (keyed by target so target switch
  // re-fetches only when needed) + filtered display list.
  let headingTarget: string | null = null;
  let headingAll: HeadingHit[] = [];
  let headingHits: HeadingHit[] = [];
  // Block-mode cache: parsed blocks + the file's mtime (needed for the
  // CAS write when committing a block that doesn't yet have an `^id`).
  let blockTarget: string | null = null;
  let blockAll: ParsedBlock[] = [];
  let blockOriginalText = "";
  let blockMtime: number | null = null;
  let blockMtimeNs: string | null = null;
  let blockAuthorityVersion: number | null = null;
  let blockHits: ParsedBlock[] = [];
  let selectedIndex = 0;
  let reqSeq = 0;
  let debounceTimer: number | undefined;
  let indexWatch: number | undefined;
  let alive = true;

  // Per-file link style, snapshotted when the bubble opens. A file that
  // already uses wiki links keeps the `[[...]]` form on commit so its
  // style stays consistent; every other file (the default now) commits
  // relative markdown `[stem](./path#anchor)`.
  const fileUsesWikiLinks = WIKI_LINK_RE.test(opts.view.state.doc.toString());

  const list = document.createElement("div");
  list.className = "md-bubble-list";
  shell.wrap.appendChild(list);
  const status = document.createElement("div");
  status.className = "md-bubble-status";
  shell.wrap.appendChild(status);

  /// In raw `[label](url)` mode, the literal URL slot resolved to an openable
  /// internal target -- the "OPEN <url>" sentinel. Null in wrap mode, when
  /// there is no open handler, or when the slot is external / anchor-only /
  /// unresolvable (parseInternalLink returns null for `http`/`mailto`/`#...`).
  function selfHit(): SelfHit | null {
    if (!opts.onOpenLink) return null;
    if (!slotMode || mode.kind !== "file") return null;
    const literal = opts.view.state.doc.sliceString(opts.triggerStart, triggerEnd);
    const parsed = parseInternalLink(literal, "", opts.fromPath ?? null);
    if (!parsed) return null;
    return {
      kind: "Self",
      target: parsed.target,
      anchor: parsed.anchor ? parsed.anchor : null,
      url: literal,
    };
  }

  function activeHits(): Array<LinkTarget | HeadingHit | ParsedBlock | SelfHit> {
    if (mode.kind === "heading") return headingHits;
    if (mode.kind === "block") return blockHits;
    // File mode: the raw-slot Self row first (so cmd+enter / ↵ opens the link
    // the caret sits on), then /api/link-targets hits (names / titles /
    // headings), then the client-side PATH candidates, deduped against any file
    // row for the same path so a file matched by both name and path lists once.
    const namedPaths = new Set(
      fileHits.filter((h) => h.kind !== "Heading").map((h) => h.path),
    );
    const extras = pathHits.filter((p) => !namedPaths.has(p.path));
    const self = selfHit();
    return self ? [self, ...fileHits, ...extras] : [...fileHits, ...extras];
  }

  function render(): void {
    list.innerHTML = "";
    list.classList.remove("md-bubble-empty-state");
    const hits = activeHits();
    if (hits.length === 0) {
      if (mode.kind === "file") {
        if (!windowCaps.workspace) {
          // No index exists behind this window, so the index-aware empty
          // states ("Indexing...", "0 documents") would be lies; a plain
          // no-match line is the truth.
          status.textContent = "No matching paths";
          status.classList.remove("md-bubble-status-empty");
          shell.reposition();
          return;
        }
        const empty = completionEmptyState(query, indexStatus.value);
        renderBubbleEmptyState(list, empty);
        status.textContent = "";
        status.classList.add("md-bubble-status-empty");
        // The empty state reads the shared index status at render time,
        // but the bubble only re-renders on a keystroke or a fetch
        // result. When a watcher reindex finishes while the user sits on
        // the "Indexing..." state, nothing re-runs the fetch, so the
        // bubble would otherwise pin "Indexing... 0 documents" until the
        // next keystroke. Watch the shared status and re-fetch on
        // completion so results replace the stale empty state.
        if (empty.kind === "indexing") startIndexWatch();
      } else if (mode.kind === "heading") {
        status.textContent = headingTarget === mode.target
          ? "No matching headings"
          : "Loading headings...";
        status.classList.remove("md-bubble-status-empty");
      } else {
        status.textContent = blockTarget === mode.target
          ? "No matching blocks"
          : "Loading blocks...";
        status.classList.remove("md-bubble-status-empty");
      }
      shell.reposition();
      return;
    }
    status.classList.remove("md-bubble-status-empty");
    const openHint = opts.onOpenLink ? " - ⌘↵ open" : "";
    if (mode.kind === "heading") {
      status.textContent = `${hits.length} heading${hits.length === 1 ? "" : "s"} in ${mode.target} - ↵ insert${openHint}`;
    } else if (mode.kind === "block") {
      status.textContent = `${hits.length} block${hits.length === 1 ? "" : "s"} in ${mode.target} - ↵ insert${openHint}`;
    } else {
      // Advertise the heading / block modes (type `#` or `^` after the
      // target) while authoring a fresh `[[` link. Suppressed in raw
      // mode, where those separators are part of the URL being edited.
      const modeHint = slotMode ? "" : " - # heading - ^ block";
      status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"} - ↵ insert${openHint}${modeHint}`;
    }
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]!;
      const row = document.createElement("div");
      row.className = "md-bubble-row";
      if (i === selectedIndex) row.classList.add("md-bubble-row-selected");
      if (mode.kind === "heading") {
        const h = hit as HeadingHit;
        const level = document.createElement("span");
        level.className = "md-bubble-row-level";
        level.textContent = `H${h.level}`;
        const text = document.createElement("span");
        text.textContent = h.text;
        row.appendChild(level);
        row.appendChild(text);
      } else if (mode.kind === "block") {
        const b = hit as ParsedBlock;
        const tag = document.createElement("span");
        tag.className = "md-bubble-row-level";
        tag.textContent = b.existingAnchor ? "ID" : "BLK";
        const text = document.createElement("span");
        // First line of the block, ellipsised if very long. Anchor
        // suffix is stripped from the visible text since the row tag
        // already signals it.
        const firstLine = b.text.split("\n")[0] ?? "";
        text.textContent = firstLine.replace(/\s*\^[A-Za-z0-9-]{4,}\s*$/, "");
        row.appendChild(tag);
        row.appendChild(text);
      } else if (isSelfHit(hit)) {
        // "OPEN <url>" row: opens the link already in the slot.
        const tag = document.createElement("span");
        tag.className = "md-bubble-row-level";
        tag.textContent = "OPEN";
        const text = document.createElement("span");
        text.textContent = hit.url;
        row.appendChild(tag);
        row.appendChild(text);
      } else {
        const t = hit as LinkTarget;
        if (t.kind === "Heading") {
          const level = document.createElement("span");
          level.className = "md-bubble-row-level";
          level.textContent = t.level ? `H${t.level}` : "H";
          const text = document.createElement("span");
          text.textContent = t.heading ?? t.path;
          const path = document.createElement("span");
          path.className = "md-bubble-row-sub";
          path.textContent = ` ${t.path}`;
          row.appendChild(level);
          row.appendChild(text);
          row.appendChild(path);
        } else if (t.kind === "Path") {
          // Path match: lead with the full workspace path (what the user
          // is completing), tagged so it reads as a path candidate next
          // to the name/title-matched "File" rows. Same "level tag +
          // text" shape as heading / block rows for visual consistency.
          const tag = document.createElement("span");
          tag.className = "md-bubble-row-level";
          tag.textContent = "PATH";
          const text = document.createElement("span");
          text.textContent = t.path;
          row.appendChild(tag);
          row.appendChild(text);
        } else {
          const title = t.title?.trim();
          row.textContent = title && title !== t.path ? `${title} - ${t.path}` : t.path;
        }
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        commit(hit);
      });
      list.appendChild(row);
    }
    shell.reposition();
  }

  function fetchFile(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    // Without a workspace there is no name/title index behind the picker:
    // the PATH lane over loaded browser entries is the whole completion
    // surface, and probing the absent route would only paint errors.
    if (!windowCaps.workspace) {
      fileHits = [];
      render();
      return;
    }
    const seq = ++reqSeq;
    debounceTimer = window.setTimeout(() => {
      const term = slotMode ? rawSearchTerm(query) : query;
      api
        .linkTargets(term, SEARCH_LIMIT)
        .then((results) => {
          if (!alive || seq !== reqSeq || mode.kind !== "file") return;
          fileHits = results;
          // Clamp against the FULL list (a prepended Self row + path extras),
          // not just fileHits, or the selection can land out of range.
          if (selectedIndex >= activeHits().length) selectedIndex = 0;
          render();
        })
        .catch((err) => {
          if (!alive || seq !== reqSeq) return;
          fileHits = [];
          status.textContent = `Search failed: ${err.message ?? err}`;
        });
    }, FETCH_DEBOUNCE_MS);
  }

  /// Lazily fetch + cache the workspace file tree (recursive listing via
  /// GET /api/files, the same route the file browser uses). Resolves
  /// immediately on a cache hit; dedupes concurrent loads. On failure we
  /// cache an empty tree so path completion is simply absent rather than
  /// retrying every keystroke.
  function ensureTreeLoaded(): Promise<void> {
    // A standalone window must never request the recursive whole-machine
    // listing; the loaded browser entries (the sparse per-directory tree
    // the File Browser already fetched) are the path-completion source.
    if (!windowCaps.workspace) {
      allEntries = tree.entries.slice();
      return Promise.resolve();
    }
    if (allEntries !== null) return Promise.resolve();
    if (treePromise) return treePromise;
    treePromise = api
      .list()
      .then((entries) => {
        if (alive) allEntries = entries;
      })
      .catch(() => {
        if (alive) allEntries = [];
      });
    return treePromise;
  }

  /// Recompute the merged file-mode list's PATH half for the current
  /// query, then re-render. Cheap (in-memory filter over the cached
  /// tree); the only async cost is the one-time tree fetch.
  function fetchPaths(): void {
    void ensureTreeLoaded().then(() => {
      if (!alive || mode.kind !== "file") return;
      pathHits = computePathHits(query, allEntries ?? []);
      render();
    });
  }

  function fetchHeadings(target: string): void {
    // Heading search reads the graph; without a workspace the picker
    // shows no heading rows rather than probing an absent route.
    if (!windowCaps.workspace) {
      headingAll = [];
      headingHits = [];
      headingTarget = target;
      render();
      return;
    }
    if (headingTarget === target) {
      // Cache hit; just re-filter.
      filterHeadings();
      return;
    }
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    const seq = ++reqSeq;
    headingAll = [];
    headingHits = [];
    headingTarget = null;
    render();
    api
      .headings(target)
      .then((results) => {
        if (!alive || seq !== reqSeq) return;
        if (mode.kind !== "heading" || mode.target !== target) return;
        headingTarget = target;
        headingAll = results as HeadingHit[];
        filterHeadings();
      })
      .catch((err) => {
        if (!alive || seq !== reqSeq) return;
        headingAll = [];
        headingHits = [];
        status.textContent = `Headings failed: ${err.message ?? err}`;
      });
  }

  function filterHeadings(): void {
    if (mode.kind !== "heading") return;
    const f = mode.filter.toLowerCase();
    headingHits = (f.length === 0
      ? headingAll
      : headingAll.filter((h) => h.text.toLowerCase().includes(f))
    ).slice(0, HEADING_LIMIT);
    if (selectedIndex >= headingHits.length) selectedIndex = 0;
    render();
  }

  function fetchBlocks(target: string): void {
    if (blockTarget === target) {
      filterBlocksLocal();
      return;
    }
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    const seq = ++reqSeq;
    blockAll = [];
    blockHits = [];
    blockTarget = null;
    blockOriginalText = "";
    blockMtime = null;
    blockMtimeNs = null;
    blockAuthorityVersion = null;
    render();
    api
      .read(target)
      .then((res) => {
        if (!alive || seq !== reqSeq) return;
        if (mode.kind !== "block" || mode.target !== target) return;
        blockTarget = target;
        blockOriginalText = res.content;
        blockMtime = res.mtime;
        blockMtimeNs = res.mtime_ns ?? null;
        blockAuthorityVersion = res.authority_version ?? null;
        blockAll = parseBlocks(res.content);
        filterBlocksLocal();
      })
      .catch((err) => {
        if (!alive || seq !== reqSeq) return;
        blockAll = [];
        blockHits = [];
        status.textContent = `Blocks failed: ${err.message ?? err}`;
      });
  }

  function filterBlocksLocal(): void {
    if (mode.kind !== "block") return;
    blockHits = filterBlocks(blockAll, mode.filter, BLOCK_LIMIT);
    if (selectedIndex >= blockHits.length) selectedIndex = 0;
    render();
  }

  /// Heading + block fetches need an EXACT rel_path (api.headings /
  /// api.read match the stored path verbatim), but the user types a
  /// basename then the separator (`[[Welcome#`). Map that typed target
  /// to the matching file from the last file-mode results so `#`/`^`
  /// reach a real file instead of dead-ending on "No matching
  /// headings". Falls through unchanged when the target already names a
  /// path (has a `/`) or nothing matched.
  function resolveAnchorTarget(typed: string): string {
    if (!typed || typed.includes("/")) return typed;
    const stem = (p: string): string =>
      (p.split("/").pop() ?? p).replace(/\.md$/i, "");
    const lower = typed.toLowerCase();
    const hit = fileHits.find(
      (h) =>
        h.kind !== "Heading" &&
        (h.path.toLowerCase() === lower || stem(h.path).toLowerCase() === lower),
    );
    return hit ? hit.path : typed;
  }

  function refetchForMode(): void {
    if (mode.kind === "file") {
      fetchFile();
      fetchPaths();
    } else if (mode.kind === "heading") {
      fetchHeadings(mode.target);
    } else {
      fetchBlocks(mode.target);
    }
  }

  /// Re-run the active mode's fetch once the index finishes building.
  /// Only started while the bubble is showing the "Indexing..." empty
  /// state; the global poller flips indexStatus to idle when the
  /// reindex completes, but nothing else re-runs our fetch, so without
  /// this the bubble stays pinned on "Indexing...". One-shot: it tears
  /// itself down on the first non-indexing tick and re-fetches.
  function startIndexWatch(): void {
    if (indexWatch !== undefined) return;
    indexWatch = window.setInterval(() => {
      if (!alive) {
        stopIndexWatch();
        return;
      }
      if (indexInProgress(indexStatus.value)) return;
      stopIndexWatch();
      refetchForMode();
    }, INDEX_WATCH_MS);
  }

  function stopIndexWatch(): void {
    if (indexWatch !== undefined) {
      clearInterval(indexWatch);
      indexWatch = undefined;
    }
  }

  function commit(hit: LinkTarget | HeadingHit | ParsedBlock | SelfHit): void {
    if (isSelfHit(hit)) {
      // The Self row OPENS the link already in the slot instead of rewriting
      // it. Mandatory guard: a SelfHit carries no `.path`, so falling through
      // to the file-mode branch would call fileLinkInsert(undefined, ...) and
      // corrupt the document.
      if (opts.onOpenLink) opts.onOpenLink(hit.target, hit.anchor);
      dismiss();
      return;
    }
    const raw = slotMode;
    if (mode.kind === "block") {
      // Block commit may need a fresh `^id` written to the target file.
      // Run async, then dispatch the link insert. The bubble stays
      // open during the write; show a transient status.
      const block = hit as ParsedBlock;
      void commitBlock(block, raw);
      return;
    }
    let insert: string;
    if (mode.kind === "heading") {
      // The typed target IS a real workspace path here: /api/headings
      // does an exact rel_path match, so a heading hit can only exist
      // when the target names an indexed file (the user typed the path
      // through to its `#`). So we relativize it exactly like a
      // file-mode hit and emit relative markdown `[stem](./path.md#slug)`
      // (or keep wiki form in a wiki-mode file). The graph + search
      // already resolve a `#slug` anchor (workspace split_anchor), so
      // the link round-trips on disk.
      const h = hit as HeadingHit;
      insert = fileLinkInsert(mode.target, h.anchor, raw);
    } else {
      const lt = hit as LinkTarget;
      const anchor = lt.kind === "Heading" ? (lt.anchor ?? null) : null;
      insert = fileLinkInsert(lt.path, anchor, raw);
    }
    opts.view.dispatch({
      changes: { from: opts.triggerStart, to: triggerEnd, insert },
      selection: { anchor: opts.triggerStart + insert.length },
    });
    dismiss();
  }

  /// Format an on-disk file link for a resolved (path, anchor). `path`
  /// is a workspace-rooted POSIX path (no leading slash). Three forms:
  ///   slot mode (`raw`) -> bare relativized path filling an existing slot
  ///                     (the surrounding `[label](...)` / backticks stay).
  ///                     "code" mode percent-encodes it so an inline-code
  ///                     link survives detection (which rejects a space);
  ///                     a markdown URL slot keeps the verbatim path.
  ///   wiki-mode file -> `[[path#anchor]]`, preserving the file's
  ///                     existing wiki-link style.
  ///   default        -> relative markdown `[stem](./path#anchor)`.
  function fileLinkInsert(
    path: string,
    anchor: string | null,
    raw: boolean,
  ): string {
    if (raw) {
      const rel = opts.fromPath ? relativizePath(path, opts.fromPath) : path;
      // Inline-code links carry no markdown delimiters around the slot, so
      // a literal space would break re-detection - percent-encode the path
      // in "code" mode (a markdown URL slot keeps its existing raw form).
      const slot = opts.templateMode === "code" ? encodeRelPath(rel) : rel;
      return anchor ? `${slot}#${anchor}` : slot;
    }
    if (fileUsesWikiLinks) {
      const ref = anchor ? `${path}#${anchor}` : path;
      return `[[${ref}]]`;
    }
    return wikiLinkToMarkdown(
      path,
      undefined,
      anchor ?? undefined,
      opts.fromPath ?? undefined,
    );
  }

  async function commitBlock(
    block: ParsedBlock,
    raw: boolean,
  ): Promise<void> {
    if (mode.kind !== "block" || !blockTarget) return;
    const target = mode.target;
    let anchorId: string;
    if (block.existingAnchor) {
      // Strip leading `^`: we store the anchor as `^id` in
      // ParsedBlock but the link form is `target^id` (no double ^).
      anchorId = block.existingAnchor.replace(/^\^/, "");
    } else {
      // Generate a fresh id, write to the target file via CAS, then
      // insert the link. If the write fails (mtime conflict, network),
      // surface the error and leave the bubble open.
      anchorId = makeBlockId();
      const newContent = insertBlockAnchor(blockOriginalText, block, anchorId);
      status.textContent = "Adding anchor...";
      try {
        const res = await api.write(
          target,
          newContent,
          blockMtimeNs,
          blockMtime,
          blockAuthorityVersion,
        );
        if (!alive) return;
        blockOriginalText = newContent;
        blockMtime = res.mtime;
        blockMtimeNs = res.mtime_ns ?? null;
        blockAuthorityVersion = res.authority_version ?? null;
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : String(err);
        status.textContent = `Anchor write failed: ${msg}`;
        return;
      }
    }
    // Emit the block anchor as a `#^id` fragment so the on-disk link is
    // relative markdown `[stem](./path.md#^id)` (or wiki form in a
    // wiki-mode file). The backend split_anchor keeps the `^id` anchor
    // for a `.md` target, so the link resolves; the old `[[target^id]]`
    // wiki form never resolved (split_anchor only cuts on `#`, leaving
    // `target^id` as an unresolvable path). `target` is the exact stored
    // rel_path: api.read needs an exact path to have loaded the blocks.
    const insert = fileLinkInsert(target, `^${anchorId}`, raw);
    opts.view.dispatch({
      changes: { from: opts.triggerStart, to: triggerEnd, insert },
      selection: { anchor: opts.triggerStart + insert.length },
    });
    dismiss();
  }

  function openSelected(): void {
    if (!opts.onOpenLink) return;
    const hits = activeHits();
    const hit = hits[selectedIndex];
    if (isSelfHit(hit)) {
      opts.onOpenLink(hit.target, hit.anchor);
      dismiss();
      return;
    }
    let target: string;
    let anchor: string | null = null;
    if (mode.kind === "heading") {
      target = mode.target;
      if (hit) anchor = (hit as HeadingHit).anchor;
    } else if (mode.kind === "block") {
      target = mode.target;
      if (hit) {
        const b = hit as ParsedBlock;
        if (b.existingAnchor) anchor = b.existingAnchor; // includes leading ^
        // No anchor write happens on Cmd+Enter; opening doesn't
        // mutate the target file. The host just navigates to the
        // file (anchor scroll TBD).
      }
    } else if (hit) {
      const linkTarget = hit as LinkTarget;
      target = linkTarget.path;
      if (linkTarget.kind === "Heading") anchor = linkTarget.anchor ?? null;
    } else {
      target = query;
    }
    opts.onOpenLink(target, anchor);
    dismiss();
  }

  function dismiss(): void {
    if (!alive) return;
    alive = false;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    stopIndexWatch();
    shell.dismiss();
    anchor.dismiss();
    opts.onDismiss();
  }

  // Initial fetch for whichever mode the opening query parses to.
  refetchForMode();
  render();

  return {
    handleKey(event: KeyboardEvent): boolean {
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      const hits = activeHits();
      if (event.key === "Enter") {
        // Cmd/Ctrl+Enter -> open the selected hit (or trigger target)
        // instead of committing a replace. The host wires this to
        // openInActivePane via onOpenLink.
        if (event.metaKey || event.ctrlKey) {
          if (opts.onOpenLink) {
            openSelected();
            return true;
          }
          return false;
        }
        const hit = hits[selectedIndex];
        if (hit) {
          commit(hit);
          return true;
        }
        return false;
      }
      if (event.key === "ArrowDown") {
        if (hits.length === 0) return false;
        selectedIndex = (selectedIndex + 1) % hits.length;
        render();
        return true;
      }
      if (event.key === "ArrowUp") {
        if (hits.length === 0) return false;
        selectedIndex = (selectedIndex - 1 + hits.length) % hits.length;
        render();
        return true;
      }
      return false;
    },
    setQuery(q: string): void {
      // Re-anchor on every spec update. Anchor pos is the trigger's
      // opening `[[`, which only moves when an upstream edit shifts
      // the whole line; recomputing keeps the bubble glued to its
      // marker through those shifts.
      anchor.update(opts.view, anchorPos());
      shell.reposition();
      if (q === query) return;
      query = q;
      const newMode: Mode = slotMode ? { kind: "file" } : classifyQuery(q);
      // Resolve a basename target (`Welcome`) to its real rel_path
      // (`Welcome.md`) so the heading/block fetch finds the file.
      if (newMode.kind === "heading" || newMode.kind === "block") {
        newMode.target = resolveAnchorTarget(newMode.target);
      }
      const modeChanged = newMode.kind !== mode.kind;
      const targetChanged =
        newMode.kind === "heading" &&
        mode.kind === "heading" &&
        newMode.target !== mode.target;
      const blockTargetChanged =
        newMode.kind === "block" &&
        mode.kind === "block" &&
        newMode.target !== mode.target;
      mode = newMode;
      selectedIndex = 0;
      if (modeChanged || targetChanged || blockTargetChanged) {
        refetchForMode();
      } else if (mode.kind === "heading") {
        // Same target, filter changed: local re-filter only.
        filterHeadings();
      } else if (mode.kind === "block") {
        filterBlocksLocal();
      } else {
        fetchFile();
        fetchPaths();
      }
    },
    setTriggerEnd(end: number): void {
      triggerEnd = end;
    },
    reposition(): void {
      anchor.update(opts.view, anchorPos());
      shell.reposition();
    },
    dismiss,
  };
}
