<script lang="ts">
  // Search palette. Open with Cmd/Ctrl+K (or the toolbar button),
  // type, see ranked hits across the workspace: chunks (BM25 + dense
  // from /api/search/content) plus client-side tag and image hits
  // computed off the loaded graph and tree. Click to open the
  // inspector on the right; double-click / Enter routes to the
  // editor (or graph, for a tag).
  //
  // Search-only: the panel has no second tab.

  import { onDestroy, tick } from "svelte";
  import { untrack } from "svelte";
  import {
    ArrowLeft,
    ArrowRight,
    Maximize2,
    Minimize2,
    RotateCw,
    X,
  } from "lucide-svelte";
  import {
    overlayMaximized,
    setOverlayMaximized,
  } from "../state/pageWidth.svelte";
  import {
    ApiError,
    api,
    withTokenQuery,
    workspaceIsRecovering,
  } from "../api/client";
  import type { ContentHit, ReportFileStats } from "../api/types";
  import { collapseContentHitsByFile } from "../search/results";
  import { isEditableText, isImage } from "../state/fileTypes";
  import {
    ensureGraphLoaded,
    graphData,
  } from "../state/graphData.svelte";
  import { openInActivePane } from "../state/tabs.svelte";
  import {
    indexStatus,
    loadTreeDir,
    openFsGraphForFile,
    openGraphForMention,
    openGraphForTag,
    paneWidths,
    persistPaneWidths,
    revealPathInBrowser,
    searchPanel,
    tree,
  } from "../state/store.svelte";
  import { chordFor } from "../state/shortcuts";
  import Bubble from "./Bubble.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";
  import Inspector from "./Inspector.svelte";
  import InspectorBody, { type InspectorSelection } from "./InspectorBody.svelte";
  import KindChip from "./KindChip.svelte";
  import OverlayShell from "./OverlayShell.svelte";

  /// Unified row type. Chunk hits come from the server (BM25 +
  /// dense over file content); tag, image, file, and contact hits
  /// are computed client-side from the already-loaded graph and
  /// tree (filename / label substring matches). The discriminant
  /// on `kind` lets the row renderer pick the right chip + preview
  /// shape and lets the inspector dispatcher know what selection
  /// to construct.
  type SearchRow =
    | { kind: "chunk"; hit: ContentHit; key: string }
    | { kind: "image"; path: string; key: string }
    | { kind: "file"; path: string; key: string }
    // Path autocomplete: a filesystem entry surfaced when the query LOOKS
    // like a path (has a "/" or starts with "./"). Lists the typed parent dir
    // directly via api.list - NOT the lazy `tree.entries` - so deep / unindexed
    // paths still resolve (the "I typed a path and got nothing" case). A file
    // opens; a directory drills (re-seeds the query to its contents).
    | { kind: "path"; path: string; isDir: boolean; key: string }
    | {
        kind: "language_file";
        path: string;
        language: string;
        code: number;
        key: string;
      }
    | { kind: "contact"; path: string; key: string }
    | {
        kind: "tag";
        nodeId: string;
        label: string;
        documents: number;
        key: string;
      }
    | {
        kind: "mention";
        nodeId: string;
        label: string;
        documents: number;
        key: string;
      };

  let inputEl: HTMLInputElement | undefined = $state();
  let hitsEl: HTMLUListElement | undefined = $state();
  /// Query is module-level (lives on `searchPanel.query`) so the
  /// URL hash can round-trip it: a copy-pasted chan URL with
  /// `search=foo` reopens the panel preloaded with that term.
  let chunkHits = $state<ContentHit[]>([]);
  let languageHits = $state<SearchRow[]>([]);
  let pathHits = $state<SearchRow[]>([]);
  let loading = $state(false);
  let active = $state(0);
  let error = $state<string | null>(null);
  let searchRecovering = $state(false);

  // While the index is still building (cold boot on a large workspace) an
  // empty result set means "not indexed yet", not "nothing here". Surface that
  // so a zero-hit query reads as a transient state, not a dead end. A query
  // during the build returns whatever is indexed so far; a transient failure
  // still lands in the error branch above rather than crashing the panel.
  const indexBuilding = $derived(
    indexStatus.value?.state === "building" ||
      indexStatus.value?.state === "reindexing",
  );
  const searchNotReady = $derived(
    searchRecovering || indexStatus.value?.state === "recovering",
  );

  /// Debounce token. Bumped on every input change; any in-flight
  /// promise that resolves with a stale token discards its result.
  let queryToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let hitsResizeObs: ResizeObserver | null = null;
  const reportCache = new Map<string, ReportFileStats | null>();

  // Reset transient state when the panel reopens so a stale set
  // of hits from the previous session doesn't flash before the
  // first new query lands.
  //
  // Selection prefill: if the user had real text selected when they
  // hit the search shortcut, seed the input with it and run the
  // first search immediately. Capture the selection BEFORE focusing
  // the input - focus collapses the selection, so reading it inside
  // the queueMicrotask would always come back empty. Gate keeps the
  // prefill quiet for the common cases where the selection isn't
  // useful (long paragraph, multi-line, focus inside another input).
  $effect(() => {
    if (!searchPanel.open) return;
    // Only react to the open transition; tracking the query here
    // would fire on every keystroke and re-select the input,
    // making typing impossible. `untrack` reads the value without
    // subscribing.
    untrack(() => {
      // Three open paths converge here:
      //   (a) URL hash restore - searchPanel.query was set by
      //       applyOverlaysFromHash before the panel went open.
      //       Keep it as-is and run a search.
      //   (b) Text-selection seed - query was empty, the user
      //       had real text selected when they opened Search. Adopt
      //       it and run a search.
      //   (c) Fresh empty open - wait for the user to type.
      const restored = searchPanel.query.trim();
      const seed = restored ? null : extractSearchSeed();
      if (seed) searchPanel.query = seed;
      chunkHits = [];
      languageHits = [];
      active = 0;
      error = null;
      searchRecovering = false;
      // Make sure the graph is loaded so tag hits work on the
      // first query of the session.
      void ensureGraphLoaded();
      // Wait a Svelte tick before focusing so the OverlayShell child
      // block has mounted and `inputEl` is bound. A bare
      // `queueMicrotask` runs before Svelte flushes the
      // open-transition DOM updates, leaving `inputEl` undefined and
      // the focus call a silent no-op.
      void tick().then(() => {
        inputEl?.focus();
        if (seed || restored) inputEl?.select();
      });
      if (restored || seed) scheduleSearch();
    });
  });

  /// Caps for the selection-prefill gate. ≤8 words because BM25
  /// loses ranking signal past that and a longer selection is
  /// almost always an accidental paragraph copy. 200 chars is a
  /// belt-and-braces safety net for the case where someone typed
  /// one giant word.
  const SEED_MAX_WORDS = 8;
  const SEED_MAX_CHARS = 200;

  function extractSearchSeed(): string | null {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    const raw = sel?.toString() ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    if (trimmed.length > SEED_MAX_CHARS) return null;
    if (/[\r\n]/.test(trimmed)) return null;
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (words.length > SEED_MAX_WORDS) return null;
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    if (focused) {
      const tag = focused.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return null;
    }
    return trimmed;
  }

  function close(): void {
    searchPanel.open = false;
  }

  function scheduleSearch(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = searchPanel.query.trim();
    if (!q) {
      chunkHits = [];
      languageHits = [];
      pathHits = [];
      loading = false;
      searchRecovering = false;
      return;
    }
    const limit = 25;
    queryToken += 1;
    const myToken = queryToken;
    loading = true;
    debounceTimer = setTimeout(async () => {
      // Path autocomplete runs alongside content search (best-effort, its own
      // staleness guard via myToken), so a path-like query still surfaces
      // matches even when the content index has nothing for it.
      void refreshPathHits(q, myToken);
      try {
        const language = parseLanguageQuery(q);
        if (language) {
          chunkHits = [];
          const hits = await searchLanguage(language);
          if (myToken !== queryToken) return; // stale
          languageHits = hits;
          active = 0;
          error = null;
          searchRecovering = false;
          return;
        }
        const res = await api.searchContent(q, { limit });
        if (myToken !== queryToken) return; // stale
        chunkHits = collapseContentHitsByFile(res.hits);
        languageHits = [];
        active = 0;
        error = null;
        searchRecovering = workspaceIsRecovering(res.readiness);
      } catch (e) {
        if (myToken !== queryToken) return;
        error = (e as Error).message;
        chunkHits = [];
        languageHits = [];
        searchRecovering = false;
      } finally {
        if (myToken === queryToken) loading = false;
      }
    }, 200);
  }

  const LANGUAGE_LIMIT = 25;
  const PATH_LIMIT = 25;

  /// Treat the query as a path when it carries a "/" or a leading "./" - the
  /// user is signalling "I'm typing a path", so we offer filesystem
  /// autocomplete. A bare word stays a pure content/tag/file search.
  function isPathLike(q: string): boolean {
    return q.startsWith("/") || q.startsWith("./") || q.includes("/");
  }

  /// Populate `pathHits` from the typed parent directory. Lists via api.list
  /// DIRECTLY (not the lazy `tree.entries`), so a deep / unindexed path still
  /// resolves; entries are prefix-filtered by the full typed path. `token`
  /// guards against out-of-order responses (same counter as the content search).
  async function refreshPathHits(q: string, token: number): Promise<void> {
    if (!isPathLike(q)) {
      if (token === queryToken) pathHits = [];
      return;
    }
    // Drop a single leading "./"; api.list keys off workspace-relative paths.
    const norm = q.replace(/^\.\//, "");
    const slash = norm.lastIndexOf("/");
    const parent = slash >= 0 ? norm.slice(0, slash) : "";
    try {
      const entries = await api.list(parent || null);
      if (token !== queryToken) return;
      const needle = norm.toLowerCase();
      pathHits = entries
        .filter((e) => e.path.toLowerCase().startsWith(needle))
        .slice(0, PATH_LIMIT)
        .map((e) => ({
          kind: "path" as const,
          path: e.path,
          isDir: e.is_dir,
          key: `path:${e.path}`,
        }));
    } catch {
      if (token === queryToken) pathHits = [];
    }
  }

  function parseLanguageQuery(q: string): string | null {
    const m = q.match(/^language\s*:\s*(.+)$/i);
    const value = m?.[1]?.trim();
    return value ? value.toLowerCase() : null;
  }

  async function reportForPath(path: string): Promise<ReportFileStats | null> {
    if (reportCache.has(path)) return reportCache.get(path) ?? null;
    try {
      const stats = await api.reportFile(path);
      reportCache.set(path, stats);
      return stats;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        reportCache.set(path, null);
        return null;
      }
      throw e;
    }
  }

  async function searchLanguage(language: string): Promise<SearchRow[]> {
    await loadSearchTree();
    const files = tree.entries.filter((e) => !e.is_dir);
    const out: SearchRow[] = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
      while (next < files.length && out.length < LANGUAGE_LIMIT) {
        const entry = files[next++];
        if (!entry) continue;
        const stats = await reportForPath(entry.path);
        if (!stats || stats.language.toLowerCase() !== language) continue;
        out.push({
          kind: "language_file",
          path: entry.path,
          language: stats.language,
          code: stats.code,
          key: `language:${stats.language}:${entry.path}`,
        });
      }
    });
    await Promise.all(workers);
    out.sort((a, b) => {
      if (a.kind !== "language_file" || b.kind !== "language_file") return 0;
      return a.path.localeCompare(b.path);
    });
    return out.slice(0, LANGUAGE_LIMIT);
  }

  async function loadSearchTree(): Promise<void> {
    // The file tree is normally loaded on demand as directories open.
    // `language:<name>` is a workspace-wide query, so hydrate directory
    // listings before scanning per-file report rows.
    for (let i = 0; i < 1000; i += 1) {
      const pending = tree.entries
        .filter((e) => e.is_dir && !tree.loadedDirs[e.path] && !tree.loadingDirs[e.path])
        .map((e) => e.path);
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map((path) => loadTreeDir(path)));
    }
  }


  /// Per-kind caps so a query like "n" doesn't drown the chunk
  /// hits under hundreds of directory / image / file / contact rows.
  /// Chunks come from the server already capped at 25.
  const TAG_LIMIT = 8;
  const MENTION_LIMIT = 8;
  const IMAGE_LIMIT = 8;
  const FILE_LIMIT = 8;
  const CONTACT_LIMIT = 8;

  /// Image hits: filenames matching the typed query, drawn from
  /// the in-memory tree. Substring match is case-insensitive and
  /// hits anywhere in the path so "kitten" finds
  /// "trips/2024/kitten.jpg" as well as "kitten.jpg" at the root.
  const imageRows = $derived.by<SearchRow[]>(() => {
    const q = searchPanel.query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchRow[] = [];
    for (const e of tree.entries) {
      if (e.is_dir) continue;
      if (!isImage(e.path)) continue;
      if (!e.path.toLowerCase().includes(q)) continue;
      out.push({ kind: "image", path: e.path, key: `image:${e.path}` });
      if (out.length >= IMAGE_LIMIT) break;
    }
    return out;
  });

  /// Contact hits: tree entries the server tagged as `chan.kind:
  /// contact` whose path matches the typed query. Surfaced as a
  /// distinct row kind so a search for "alex" lands on the contact
  /// file in addition to any markdown that mentions them. Substring
  /// match across the full path (not just basename) so contacts
  /// nested in subdirectories still surface.
  const contactRows = $derived.by<SearchRow[]>(() => {
    const q = searchPanel.query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchRow[] = [];
    for (const e of tree.entries) {
      if (e.is_dir) continue;
      if (e.kind !== "contact") continue;
      if (!e.path.toLowerCase().includes(q)) continue;
      out.push({ kind: "contact", path: e.path, key: `contact:${e.path}` });
      if (out.length >= CONTACT_LIMIT) break;
    }
    return out;
  });

  /// Markdown / text file hits: filename matches separate from the
  /// BM25 content chunks above. A file that matches by NAME (the
  /// user typed part of its title) is a different signal from a
  /// file that matches by content, and surfacing both lets the user
  /// pick whichever they were after. Contact-kind files are
  /// excluded - they get their own row kind above. Files that also
  /// appear in chunk hits are deduped in the `rows` combiner so the
  /// same path doesn't render twice.
  const markdownFileRows = $derived.by<SearchRow[]>(() => {
    const q = searchPanel.query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchRow[] = [];
    for (const e of tree.entries) {
      if (e.is_dir) continue;
      if (!isEditableText(e.path)) continue;
      if (e.kind === "contact") continue;
      if (!e.path.toLowerCase().includes(q)) continue;
      out.push({ kind: "file", path: e.path, key: `file:${e.path}` });
      if (out.length >= FILE_LIMIT) break;
    }
    return out;
  });

  /// Helper: format a contact entry's display name from its path.
  /// Strips the .md extension and leaves whatever directory structure
  /// the user has (e.g. `Contacts/Alex Park.md` -> `Alex Park`).
  /// Mirrors what FileInfoBody does for the contact name pill.
  function contactDisplayName(path: string): string {
    const base = basename(path);
    return base.replace(/\.(md|txt)$/i, "");
  }


  /// Tag hits: tag-kind nodes whose label contains the typed query.
  /// Each tag's doc count is its total tag-edge count across the
  /// workspace; a tag with zero refs is dropped. Surfacing the count
  /// lets the user pick the more active tag when several near-matches
  /// share a prefix.
  const tagRows = $derived.by<SearchRow[]>(() => {
    const q = searchPanel.query.trim().toLowerCase();
    if (!q) return [];
    const view = graphData.view;
    if (!view) return [];
    const docCounts = new Map<string, number>();
    for (const e of view.edges) {
      if (e.kind !== "tag") continue;
      docCounts.set(e.target, (docCounts.get(e.target) ?? 0) + 1);
    }
    const out: SearchRow[] = [];
    for (const n of view.nodes) {
      if (n.kind !== "tag") continue;
      if (!n.label.toLowerCase().includes(q)) continue;
      const refs = docCounts.get(n.id) ?? 0;
      // Drop tags with no referencing documents.
      if (refs === 0) continue;
      out.push({
        kind: "tag",
        nodeId: n.id,
        label: n.label,
        documents: refs,
        key: `tag:${n.id}`,
      });
      if (out.length >= TAG_LIMIT) break;
    }
    // Most-referenced first so prominent tags rank above one-off
    // hashtags that happen to share a prefix.
    out.sort((a, b) =>
      a.kind === "tag" && b.kind === "tag" ? b.documents - a.documents : 0,
    );
    return out;
  });

  /// Mention hits: mention-kind nodes (`@@Name`) whose label contains
  /// the typed query. Same shape as `tagRows` - the index already
  /// emits standalone Mention nodes plus a `file -> @@Name` edge per
  /// referencing document, so the doc count is the mention-edge count.
  /// A mention with no referencing documents is dropped. Selecting a
  /// row opens the mention lens (a focused graph around the handle).
  const mentionRows = $derived.by<SearchRow[]>(() => {
    const q = searchPanel.query.trim().toLowerCase();
    if (!q) return [];
    const view = graphData.view;
    if (!view) return [];
    const docCounts = new Map<string, number>();
    for (const e of view.edges) {
      if (e.kind !== "mention") continue;
      docCounts.set(e.target, (docCounts.get(e.target) ?? 0) + 1);
    }
    const out: SearchRow[] = [];
    for (const n of view.nodes) {
      if (n.kind !== "mention") continue;
      if (!n.label.toLowerCase().includes(q)) continue;
      const refs = docCounts.get(n.id) ?? 0;
      // Drop mentions with no referencing documents.
      if (refs === 0) continue;
      out.push({
        kind: "mention",
        nodeId: n.id,
        label: n.label,
        documents: refs,
        key: `mention:${n.id}`,
      });
      if (out.length >= MENTION_LIMIT) break;
    }
    // Most-referenced first so prominent handles rank above one-off
    // mentions that happen to share a prefix.
    out.sort((a, b) =>
      a.kind === "mention" && b.kind === "mention"
        ? b.documents - a.documents
        : 0,
    );
    return out;
  });

  /// Final ordered row list: tags first (compact, high signal),
  /// then contacts (people get top billing among file-name matches),
  /// images, markdown filename matches, and finally content chunks
  /// (the long tail). Each row has a stable key for the {#each}.
  /// Markdown filename matches are deduped against chunk hits so a
  /// file that surfaces under both shows once.
  const rows = $derived.by<SearchRow[]>(() => {
    const out: SearchRow[] = [];
    // Path matches first: the user typed a path, so surface filesystem hits
    // above the content / tag long tail.
    out.push(...pathHits);
    const chunkPaths = new Set<string>();
    for (const h of chunkHits) chunkPaths.add(h.path);
    out.push(...tagRows);
    out.push(...mentionRows);
    out.push(...languageHits);
    for (const r of contactRows) out.push(r);
    for (const r of imageRows) out.push(r);
    for (const r of markdownFileRows) {
      if (r.kind !== "file") continue;
      if (chunkPaths.has(r.path)) continue;
      out.push(r);
    }
    for (const h of chunkHits) {
      out.push({ kind: "chunk", hit: h, key: `chunk:${h.path}#${h.chunk_id}` });
    }
    return out;
  });

  const rowCounts = $derived.by(() => {
    const counts = {
      chunk: 0,
      image: 0,
      tag: 0,
      mention: 0,
      contact: 0,
      file: 0,
      language: 0,
      path: 0,
    };
    for (const row of rows) {
      if (row.kind === "chunk") counts.chunk += 1;
      else if (row.kind === "image") counts.image += 1;
      else if (row.kind === "tag") counts.tag += 1;
      else if (row.kind === "mention") counts.mention += 1;
      else if (row.kind === "contact") counts.contact += 1;
      else if (row.kind === "file") counts.file += 1;
      else if (row.kind === "language_file") counts.language += 1;
      else if (row.kind === "path") counts.path += 1;
    }
    return counts;
  });

  /// Selection driving the inspector. Recomputed from the active
  /// row index so arrow keys keep the inspector in sync without an
  /// explicit click.
  const selection = $derived.by<InspectorSelection>(() => {
    const r = rows[active];
    if (!r) return null;
    if (r.kind === "chunk") return { kind: "file", path: r.hit.path };
    if (r.kind === "image") return { kind: "file", path: r.path };
    if (r.kind === "file") return { kind: "file", path: r.path };
    if (r.kind === "language_file") return { kind: "file", path: r.path };
    if (r.kind === "contact") return { kind: "file", path: r.path };
    // A path-file gets the file inspector; a path-dir has no file report, so
    // no inspector selection (avoids a spurious reportFile 404).
    if (r.kind === "path") return r.isDir ? null : { kind: "file", path: r.path };
    if (r.kind === "mention") return { kind: "mention", nodeId: r.nodeId, label: r.label };
    return { kind: "tag", nodeId: r.nodeId, label: r.label };
  });
  const activeKey = $derived(rows[active]?.key ?? null);

  function scrollActiveIntoView(): void {
    if (!searchPanel.open || !hitsEl || !activeKey) return;
    requestAnimationFrame(() => {
      const el = hitsEl?.querySelector<HTMLElement>('li[data-active="true"]');
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  $effect(() => {
    if (!hitsEl) return;
    hitsResizeObs?.disconnect();
    hitsResizeObs = new ResizeObserver(scrollActiveIntoView);
    hitsResizeObs.observe(hitsEl);
    return () => {
      hitsResizeObs?.disconnect();
      hitsResizeObs = null;
    };
  });

  $effect(() => {
    void activeKey;
    void searchPanel.open;
    scrollActiveIntoView();
  });

  onDestroy(() => {
    hitsResizeObs?.disconnect();
  });

  /// Primary action for a row: open the underlying entity in the
  /// editor (file / image stays in the inspector, since images
  /// don't open in the editor and the inspector preview is the
  /// useful destination) or jump to the graph (tag). Always
  /// closes the search overlay.
  async function activate(r: SearchRow): Promise<void> {
    if (r.kind === "chunk") {
      close();
      await openInActivePane(r.hit.path);
    } else if (r.kind === "file" || r.kind === "language_file" || r.kind === "contact") {
      // Filename / contact matches open the underlying file in the
      // editor exactly like a chunk hit would - the path IS the
      // payload, no chunk anchor to honour.
      close();
      await openInActivePane(r.path);
    } else if (r.kind === "image") {
      // Images can't be opened in the editor; treat the row click
      // as "select" only. The inspector pane already shows the
      // preview thanks to the active-row selection effect, so no
      // further action is needed here.
    } else if (r.kind === "path") {
      if (r.isDir) {
        // Drill into the directory: re-seed the query to its contents and
        // keep the panel open so the next segment autocompletes.
        searchPanel.query = r.path.endsWith("/") ? r.path : `${r.path}/`;
        active = 0;
        scheduleSearch();
        inputEl?.focus();
      } else {
        close();
        await openInActivePane(r.path);
      }
    } else if (r.kind === "mention") {
      // Mention hits route to a mention-scoped graph (the focused
      // lens around the `@@Name` meta-node with edges to every
      // referencing file), mirroring the tag-row behaviour.
      close();
      openGraphForMention(r.nodeId, r.label);
    } else {
      // Tag hits route to a tag-scoped graph (depth-hop
      // neighbourhood around the tag) rather than workspace scope.
      close();
      openGraphForTag(r.nodeId, r.label);
    }
  }

  function selectRow(i: number): void {
    if (i < 0 || i >= rows.length) return;
    active = i;
    if (!searchPanel.inspectorOpen) searchPanel.inspectorOpen = true;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, Math.max(0, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === "Enter") {
      const r = rows[active];
      if (r) {
        e.preventDefault();
        void activate(r);
      }
    }
  }

  /// Escape `<` / `>` / `&` in the BM25 snippet, then unescape the
  /// markup we trust (the `<b>...</b>` highlight pair tantivy emits)
  /// into <mark> so the active match stands out.
  function renderSnippet(s: string): string {
    const escaped = s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped
      .replace(/&lt;b&gt;/g, "<mark>")
      .replace(/&lt;\/b&gt;/g, "</mark>");
  }

  function basename(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
  }

  /// Hamburger menu state. Mirrors the file browser / graph
  /// overlays: a single (≡) on the left, plus the same items
  /// available via right-click anywhere in the search body.
  let menu: HamburgerMenu | undefined = $state();
  let menuOpen = $state(false);
  const POPOVER_HEIGHT = 80;
  const POPOVER_WIDTH = 240;

  function toggleInspector(): void {
    searchPanel.inspectorOpen = !searchPanel.inspectorOpen;
    menu?.close();
  }

  function doToggleOverlayMaximized(): void {
    setOverlayMaximized(!overlayMaximized.on);
    menu?.close();
  }

  function reloadSearch(): void {
    menu?.close();
    queryToken += 1;
    if (searchPanel.query.trim()) {
      scheduleSearch();
    } else {
      chunkHits = [];
      languageHits = [];
      active = 0;
      loading = false;
    }
  }

  function onSearchContextMenu(e: MouseEvent): void {
    // Bail if the right-click landed on the input - let the browser
    // show its native context menu (paste, spell, etc.) there.
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea")) return;
    e.preventDefault();
    menu?.openAtCursor(e.clientX, e.clientY);
  }
</script>

<OverlayShell
  id="search"
  open={searchPanel.open}
  onClose={close}
  onBackdropContextMenu={onSearchContextMenu}
>
  <div class="search" oncontextmenu={onSearchContextMenu} role="presentation">
    <header>
      <button
        type="button"
        class="chrome-btn"
        onclick={doToggleOverlayMaximized}
        title={overlayMaximized.on ? "Restore size" : "Maximize"}
        aria-label={overlayMaximized.on ? "Restore size" : "Maximize"}
      >
        {#if overlayMaximized.on}
          <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <Maximize2 size={14} strokeWidth={1.75} aria-hidden="true" />
        {/if}
      </button>
      <HamburgerMenu
        bind:this={menu}
        bind:open={menuOpen}
        width={POPOVER_WIDTH}
        height={POPOVER_HEIGHT}
      >
        {@render menuItems()}
      </HamburgerMenu>
      <button
        type="button"
        class="chrome-btn close"
        onclick={close}
        title="Close"
        aria-label="Close"
      >
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </header>
    <div class="search-body">
      <div class="results">
      <ul class="hits" bind:this={hitsEl}>
        {#each rows as r, i (r.key)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            data-active={i === active ? "true" : undefined}
            onmousedown={(e) => {
              e.preventDefault();
              selectRow(i);
            }}
            ondblclick={() => void activate(r)}
            onmouseenter={() => (active = i)}
          >
            <Bubble active={i === active}>
              {#if r.kind === "chunk"}
                <div class="row1">
                  <KindChip kind="document" compact />
                  <span class="path">{r.hit.path}</span>
                  {#if r.hit.heading}<span class="heading"> - {r.hit.heading}</span>{/if}
                </div>
                <div class="snippet">{@html renderSnippet(r.hit.snippet)}</div>
              {:else if r.kind === "image"}
                <!-- Image-name match. Thumbnail floats to the right
                     of the path so the bubble stays the same height
                     as doc / file rows; the image loads through
                     `withTokenQuery` because the browser's `<img>`
                     can't carry an auth header. The capped height
                     keeps portrait + landscape both sitting cleanly
                     in the row without making the bubble taller
                     than the neighbouring kinds. -->
                <div class="row1 image-row">
                  <KindChip kind="media" compact />
                  <span class="path">{r.path}</span>
                  <span class="image-thumb">
                    <img
                      src={withTokenQuery(`/api/files/${encodeURIComponent(r.path).replace(/%2F/g, "/")}`)}
                      alt={basename(r.path)}
                      loading="lazy"
                    />
                  </span>
                </div>
              {:else if r.kind === "contact"}
                <!-- Contact-name match. Displays the contact's name
                     (basename with the .md/.txt suffix stripped) and
                     the underlying workspace path below it. Same row
                     shape as image / file so the bubbles read alike
                     once preview content fills the body. -->
                <div class="row1">
                  <KindChip kind="contact" compact />
                  <span class="path">{contactDisplayName(r.path)}</span>
                </div>
                <div class="preview muted mono">{r.path}</div>
              {:else if r.kind === "language_file"}
                <div class="row1">
                  <KindChip kind="document" compact dim />
                  <span class="path">{r.path}</span>
                  <span class="score">{r.language}</span>
                </div>
                <div class="preview muted">{r.code.toLocaleString()} SLOC</div>
              {:else if r.kind === "path"}
                <!-- Path autocomplete row: a directory (drills on open) or a
                     file (opens). The trailing "/" + "directory" label mark a
                     dir; a file shows its basename like a filename match. -->
                <div class="row1">
                  <KindChip kind="document" compact dim />
                  <span class="path">{r.path}{r.isDir ? "/" : ""}</span>
                </div>
                <div class="preview muted">{r.isDir ? "directory" : basename(r.path)}</div>
              {:else if r.kind === "file"}
                <!-- Markdown / text filename match (deduped against
                     chunk hits in the rows combiner). The preview
                     line carries the basename so the user can scan
                     filenames quickly when the path is long; the
                     full path stays in row1 for disambiguation. No
                     trailing metadata: the doc score below is a
                     relevance signal worth showing; bytes / mtime
                     aren't, and would just clutter the row. `dim`
                     marks this as the same kind as a content hit
                     but with less emphasis (filename match, not
                     content match). -->
                <div class="row1">
                  <KindChip kind="document" compact dim />
                  <span class="path">{r.path}</span>
                </div>
                <div class="preview muted">{basename(r.path)}</div>
              {:else if r.kind === "mention"}
                <!-- `@@mention` hit. Same compact row shape as the tag
                     hit: the handle label + a doc count. Selecting it
                     opens the mention lens (focused graph). The label
                     already carries the `@@` sigil from the index. -->
                <div class="row1">
                  <KindChip kind="mention" compact />
                  <span class="path">{r.label}</span>
                  <span class="score">{r.documents} doc{r.documents === 1 ? "" : "s"}</span>
                </div>
              {:else}
                <div class="row1">
                  <KindChip kind="tag" compact />
                  <span class="path">{r.label}</span>
                  <span class="score">{r.documents} doc{r.documents === 1 ? "" : "s"}</span>
                </div>
              {/if}
            </Bubble>
          </li>
        {/each}
      </ul>
      <!-- Input row first, then the status line beneath it. The
           status reads as a footer hint anchored to the bottom of
           the panel ("type to search - ↵ open - ↑↓ select" /
           "12 hits (5 doc - 2 image - ...)" / "no matches") so the
           cursor and the kbd hint live next to each other instead
           of with the results list above. -->
      <div class="head">
        <input
          bind:this={inputEl}
          bind:value={searchPanel.query}
          oninput={scheduleSearch}
          onkeydown={onKeyDown}
          placeholder={`search content, tags, images${chordFor("app.search.toggle") ? " (" + chordFor("app.search.toggle") + ")" : ""}`}
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div class="status-line">
        {#if loading}
          <span>searching...</span>
        {:else if error}
          <span class="err">{error}</span>
        {:else if searchNotReady}
          <span class="muted">workspace recovering - content search not ready</span>
        {:else if searchPanel.query.trim() && rows.length === 0}
          {#if indexBuilding}
            <span class="muted">still indexing - results will fill in</span>
          {:else}
            <span>no matches</span>
          {/if}
        {:else if rows.length > 0}
          <span>
            {rows.length} hit{rows.length === 1 ? "" : "s"}
            {#if rowCounts.tag + rowCounts.mention + rowCounts.image + rowCounts.contact + rowCounts.file + rowCounts.language + rowCounts.path > 0}
              ({rowCounts.chunk} doc - {rowCounts.image} image - {rowCounts.tag} tag
              {#if rowCounts.mention > 0} - {rowCounts.mention} mention{/if}
              {#if rowCounts.contact > 0} - {rowCounts.contact} contact{/if}
              {#if rowCounts.file > 0} - {rowCounts.file} file{/if}
              {#if rowCounts.language > 0} - {rowCounts.language} language{/if}
              {#if rowCounts.path > 0} - {rowCounts.path} path{/if})
            {/if}
          </span>
        {:else}
          <span class="muted">type to search - ↵ open - ↑↓ select</span>
        {/if}
      </div>
      </div>
      {#if searchPanel.inspectorOpen}
        <Inspector
          title="Details"
          bind:width={paneWidths.search}
          onResize={persistPaneWidths}
          onClose={() => (searchPanel.inspectorOpen = false)}
        >
          <InspectorBody
            selection={selection}
            onClose={() => (searchPanel.inspectorOpen = false)}
            onNavigate={(p) => {
              close();
              void openInActivePane(p);
            }}
            onOpen={() => {
              const sel = selection;
              if (sel?.kind === "file") {
                close();
                void openInActivePane(sel.path);
              }
            }}
            onReveal={() => {
              const sel = selection;
              if (sel?.kind === "file") {
                revealPathInBrowser(sel.path, { inspectorOpen: true });
                close();
              }
            }}
            onSetAsScope={() => {
              const sel = selection;
              if (sel?.kind === "tag") {
                close();
                openGraphForTag(sel.nodeId, sel.label);
              } else if (sel?.kind === "mention") {
                // Mention rows open the mention lens (focused graph
                // around the `@@Name` meta-node), mirroring the tag arm.
                close();
                openGraphForMention(sel.nodeId, sel.label);
              } else if (sel?.kind === "file") {
                close();
                openFsGraphForFile(sel.path);
              }
            }}
          />
        </Inspector>
      {/if}
    </div>
  </div>
</OverlayShell>

{#snippet menuItems()}
  <!-- Section order matches the rest of the right-click menus: view
       toggles, then the Reload footer. No content/navigation actions
       (search is read-only) and no Settings entry. -->
  <li>
    <button role="menuitem" onclick={toggleInspector}>
      {#if searchPanel.inspectorOpen}
        <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
      {:else}
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      {/if}
      <span class="menu-row-label">
        {searchPanel.inspectorOpen ? "Hide Details" : "Show Details"}
      </span>
      <span class="menu-row-chord"></span>
    </button>
  </li>
  <li class="sep" role="separator"></li>
  <li>
    <button role="menuitem" onclick={reloadSearch}>
      <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" />
      <span class="menu-row-label">Reload</span>
      <span class="menu-row-chord"></span>
    </button>
  </li>
{/snippet}

<style>
  .search {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .search-body {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .results {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  /* Top bar mirrors the file-browser header. Title left, action
     buttons right; inspector toggle lives here so it sits next to
     the close-overlay chrome and is one click away regardless of
     where the user is in the result list. */
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-card);
    font-weight: 600;
    font-size: 15px;
    color: var(--text-heading);
    flex-shrink: 0;
  }
  /* The hamburger gets margin-left: auto so it pins to the right
     edge, just before the close-button chrome; the maximize button
     stays at the far left. */
  header :global(.hamburger-trigger) { margin-left: auto; }
  /* Window-manager chrome: maximize/restore lives at the far left
     of the header, close at the far right. Matches the
     scope-history button style so all overlay headers wear the
     same skin. */
  .chrome-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 24px;
    padding: 0;
    background: var(--bg);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
    flex-shrink: 0;
  }
  .chrome-btn:hover {
    color: var(--text);
    border-color: var(--btn-hover);
  }
  /* Input row anchored at the bottom of the results column; status
     and results stack above it. Top border (was bottom) so the
     input reads as separated from the content above it. */
  .head {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
  }
  .head input {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    outline: none;
  }
  .head input:focus { border-color: var(--link); }
  .status-line {
    padding: 4px 10px;
    font-size: 13px;
    color: var(--text-secondary);
    border-top: 1px solid var(--border);
  }
  .status-line .err { color: #d33; }
  .status-line .muted { opacity: 0.7; }
  .hits {
    list-style: none;
    margin: 0;
    padding: 6px 10px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hits li {
    cursor: pointer;
    display: flex;
    /* Stretch the bubble's flex-start alignment to fill the row so
       result cards extend across the panel width (the 85% cap on
       the bubble component is for chat use). */
    align-self: stretch;
  }
  .hits li :global(.bubble) {
    max-width: none;
    width: 100%;
  }
  .row1 {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 14px;
  }
  .path { font-weight: 600; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .heading { color: var(--text-secondary); }
  .score {
    margin-left: auto;
    color: var(--text-secondary);
    font-family: ui-monospace, monospace;
    font-size: 13px;
  }
  .snippet {
    margin-top: 2px;
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  :global(.snippet mark) {
    background: var(--smart-bg);
    color: inherit;
    padding: 0 2px;
    border-radius: 2px;
  }

  /* Generic preview lives below the row1 in image / file / contact
     rows; matches the chunk snippet's spacing rhythm so all bubbles
     have the same vertical cadence. `.muted` is the secondary-text
     variant used by file + contact rows; image rows replace the
     text preview with a thumbnail (see `.image-preview` below). */
  .preview {
    margin-top: 4px;
    font-size: 13px;
    color: var(--text);
    line-height: 1.4;
  }
  .preview.muted { color: var(--text-secondary); }
  .preview.mono { font-family: ui-monospace, monospace; font-size: 12px; }
  /* Image thumbnail floats to the right of the path so the bubble
     keeps the same one-line height as doc / file / contact rows.
     `margin-left: auto` pins it past the score column; the fixed
     height + object-fit:contain keeps portrait + landscape sitting
     cleanly inside the same vertical box. A subtle border + radius
     lets transparent PNGs / SVGs read as cards instead of bleeding
     into the bubble body. */
  .image-row { align-items: center; }
  .image-thumb {
    margin-left: auto;
    flex-shrink: 0;
    line-height: 0;
  }
  .image-thumb img {
    height: 36px;
    max-width: 80px;
    object-fit: contain;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
    display: block;
  }

  /* Body stretch: the Bubble component leaves the body at content
     width so right-aligned chat user bubbles stay tight. In the
     search list we want every body to fill the row so the panel
     reads as a uniform column of cards regardless of how much
     content the kind brings. The min-height matches a two-line
     row (row1 + preview/snippet) so single-line kinds (image,
     tag) sit at the same height as doc / file / contact and the
     scroll rhythm stays even. Center the row1 in single-line
     bodies so a lone path doesn't read as top-anchored against
     a taller doc neighbour. */
  .hits li :global(.bubble) {
    align-items: stretch;
  }
  .hits li :global(.bubble .body) {
    width: 100%;
    box-sizing: border-box;
    min-height: 58px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
  }
</style>
