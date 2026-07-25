<script lang="ts">
  // Graph view overlay: Cytoscape.js renderer over chan's GraphView
  // payload. fcose handles force-directed layout; pan / zoom / node
  // drag / hover / selection all come from Cytoscape's built-ins.
  //
  // Scope (top-bar dropdown) workspaces a BFS over the full graph that
  // produces a visible-id set; the per-edge-kind chips compose with
  // it. Both filters are applied as a `display: none` toggle on the
  // existing Cytoscape elements, so layout positions are stable
  // across filter changes.
  //
  // Pinning: in file / group / git_repo / dir scope, the seed file
  // nodes are repositioned to the canvas center (or fanned around
  // it for multi-seed) and locked, then a gentle fcose pass relaxes
  // neighbours. Workspace / global scope leaves all nodes free.

  import { api } from "../api/client";
  import { isWorkspaceRootMissingError } from "../api/errors";
  import type {
    FsGraphEdge,
    FsGraphNode,
    FsGraphResponse,
    GraphView,
    GraphViewEdge,
    GraphViewNode,
    LanguageGraphResponse,
  } from "../api/types";
  import {
    openBrowserInActivePane,
    openGraphInActivePane,
    openInActivePane,
    type GraphTab,
  } from "../state/tabs.svelte";
  import {
    browserSelection,
    fbSelectSingle,
    graphReloadSignal,
    indexStatus,
    openGraphForContact,
    openGraphForLanguage,
    openGraphForMention,
    openGraphForTag,
    paneWidths,
    persistPaneWidths,
    persistTreeExpanded,
    schedulePersistStateToHash,
    scheduleSessionSave,
    surfaceThemeOverride,
    tree,
    treeExpanded,
  } from "../state/store.svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import {
    fbWatchRegister,
    fbWatchReconcile,
    fbWatchDispose,
  } from "../state/fbWatch.svelte";
  import { type ScopeOption } from "../state/scope.svelte";
  import ResizeHandle from "./ResizeHandle.svelte";
  import { clampMenu } from "./menuClamp";
  import { portal } from "./portal";
  import { tabMenu, openTabMenu, closeTabMenu } from "../state/tabMenu.svelte";
  import {
    AtSign,
    Code2,
    FileText,
    Folder,
    HardDrive,
    Hash,
    X,
  } from "lucide-svelte";
  import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
  import Inspector from "./Inspector.svelte";
  import InspectorBody, { type InspectorSelection } from "./InspectorBody.svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import KindChip from "./KindChip.svelte";
  import {
    classifyFile as classifyFileKind,
    classifyEntry,
    isOpenableTextKind,
    type FileKind,
  } from "../state/kinds";
  import { chordFor } from "../state/shortcuts";
  import { FS_GRAPH_DEPTH_MAX, graphDepthCap, relativeDepth } from "../graph/depth";
  import { pullMetaNeighbours } from "../graph/lensClosure";
  import { ancestorsExpanded } from "../graph/pathVisibility";

  let {
    tab,
    active = false,
    onClose,
  }: {
    tab: GraphTab;
    active?: boolean;
    onClose?: () => void;
  } = $props();

  // The graph is always a first-class TAB (Pane mounts GraphPanel only
  // with a `graph`-kind tab). The pre-migration overlay variant is gone,
  // so the scope/state come straight from the tab. With keep-alive
  // (round 2) every graph tab in the pane stays mounted and hidden via
  // the visibility contract, so `visible` now tracks the `active` prop
  // (was a constant `true` when only the active tab was ever mounted).
  // The load + depth-probe + watcher effects gate on it: a hidden graph
  // does no background fetch/paint and reloads once on re-activation if
  // it missed an in-scope edit while hidden.
  const graphState = $derived(tab);
  const visible = $derived(active);

  /// The scope-selector dropdown is gone; "Graph from here", inspector
  /// reveal, and file-browser navigation are the canonical scope-setting
  /// paths. The graph tab carries its own `scopeId`, so `currentScope`
  /// resolves straight from it via `synthesizeScope` - no global,
  /// pane-derived option list (the retired `availableGraphScopes`). The
  /// rest of the panel branches on `currentScope.kind` (filesystemMode,
  /// seedIds, BFS shape, etc.).
  const currentScope = $derived<ScopeOption | null>(
    synthesizeScope(graphState.scopeId),
  );

  /// Graph tabs carry six live scopeId prefixes today: workspace,
  /// `file:` / `dir:` (path lens), `tag:` (tag lens, centered on
  /// the tag node), `contact:` (contact lens --
  /// bidirectional BFS from the contact file picks up backlinks),
  /// and `language:` (language lens -- 1-hop neighbours).
  /// The wiped scope kinds (global, group, git_repo) are never
  /// produced for a graph, so this resolver only covers the live
  /// entry points; the dead kind-branches that used to handle the
  /// others were removed with the scope-concept wipe.
  function synthesizeScope(scopeId: string): ScopeOption | null {
    if (scopeId === "workspace") return { id: "workspace", kind: "workspace", label: "workspace" };
    if (scopeId.startsWith("file:")) {
      const path = scopeId.slice("file:".length);
      if (!path) return null;
      return { id: scopeId, kind: "file", label: path, path };
    }
    if (scopeId.startsWith("dir:")) {
      const path = scopeId.slice("dir:".length);
      if (!path) return null;
      return { id: scopeId, kind: "dir", label: path, path };
    }
    if (scopeId.startsWith("tag:")) {
      const nodeId = scopeId.slice("tag:".length);
      if (!nodeId) return null;
      // Strip the leading `#` for the label: the scope header renders it
      // as `#${label}`, so the raw `#search` nodeId would double-hash.
      return { id: scopeId, kind: "tag", label: nodeId.replace(/^#/, ""), nodeId };
    }
    if (scopeId.startsWith("mention:")) {
      const nodeId = scopeId.slice("mention:".length);
      if (!nodeId) return null;
      // Strip the leading `@@` for the label: the scope header renders it
      // as `@@${label}`, so the raw `@@Lead` nodeId would double-sigil.
      return { id: scopeId, kind: "mention", label: nodeId.replace(/^@@/, ""), nodeId };
    }
    if (scopeId.startsWith("contact:")) {
      const relPath = scopeId.slice("contact:".length);
      if (!relPath) return null;
      // Label peels to the file basename so the scope header reads
      // as the contact name; the full path stays on `relPath` for
      // the BFS seed.
      const slash = relPath.lastIndexOf("/");
      const label = slash < 0 ? relPath : relPath.slice(slash + 1);
      return { id: scopeId, kind: "contact", label, relPath };
    }
    if (scopeId.startsWith("language:")) {
      const language = scopeId.slice("language:".length);
      if (!language) return null;
      return { id: scopeId, kind: "language", label: language, language };
    }
    return null;
  }

  /// Ancestor breadcrumb for the current scope. Each
  /// entry is one clickable hop in the path from the workspace root down
  /// to the current scope's root. Click an ancestor → mutate
  /// `graphState.scopeId` in place (no new tab). The chain renders
  /// only for path-based scopes (`workspace` / `dir:` / `file:`); tag /
  /// git_repo / global scopes return an empty list so the breadcrumb
  /// band is hidden for those modes.
  ///
  /// The list always starts with the workspace root so the user can hop
  /// back up to workspace scope from anywhere. The final entry is the
  /// CURRENT scope, rendered as the active step (not clickable).
  type Crumb = { label: string; scopeId: string; current: boolean };
  const scopeAncestors = $derived.by<Crumb[]>(() => {
    if (!currentScope) return [];
    if (currentScope.kind === "workspace") {
      return [{ label: "workspace", scopeId: "workspace", current: true }];
    }
    if (currentScope.kind !== "file" && currentScope.kind !== "dir") {
      return [];
    }
    const path = currentScope.path;
    if (!path) {
      return [{ label: "workspace", scopeId: "workspace", current: true }];
    }
    const out: Crumb[] = [{ label: "workspace", scopeId: "workspace", current: false }];
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const sub = segments.slice(0, i + 1).join("/");
      const isLast = i === segments.length - 1;
      // Intermediate hops are always directory scopes; the leaf
      // mirrors the current scope's kind so a file-scoped graph
      // ends on `file:`, a dir-scoped one on `dir:`.
      const scopeId =
        isLast && currentScope.kind === "file"
          ? `file:${sub}`
          : `dir:${sub}`;
      out.push({ label: segments[i], scopeId, current: isLast });
    }
    return out;
  });

  /// Re-scope the current graph in place. Mirrors the existing
  /// semantic-mode `onSetAsScope` handler: depth resets to 1 so a
  /// freshly-scoped graph starts tight; selection clears so the
  /// inspector lands on the new scope's body. Used by the
  /// breadcrumb's click handler.
  function rescopeFromHere(scopeId: string): void {
    if (scopeId === graphState.scopeId) return;
    graphState.scopeId = scopeId;
    graphState.depth = 1;
    graphState.pendingSelectId = null;
    selectedId = null;
  }

  /// "Graph from here" on a selected file or folder node. Re-scopes IN
  /// PLACE (the graph tab/overlay the user is in) rather than spawning a
  /// new tab, with the node itself pinned + re-selected so the inspector
  /// stays on it.
  ///
  /// The re-root target differs by kind, matching the canonical
  /// `openFsGraphFor{File,Directory}` helpers:
  ///   - FILE: a file cannot be an fs-graph scope root, so re-root to its
  ///     PARENT folder (workspace root when the file is top-level) and select
  ///     the file inside that cohort.
  ///   - DIRECTORY: re-root to the DIRECTORY ITSELF (workspace root for
  ///     the empty/root path) so its subtree comes into view and the
  ///     directory node stays selected. Applying the file (parent) rule
  ///     to directories would make re-rooting a no-op whenever the
  ///     clicked folder's parent already IS the current scope (scopeId
  ///     unchanged -> no reload), leaving the unconsumed pendingSelectId
  ///     and a blank inspector.
  /// Double-click a graph node. For a directory node in filesystem mode
  /// this expands/collapses it in place (File Browser parity): expanding
  /// reveals the directory's next degree (find -d 1), collapsing hides its
  /// subtree, with no graph reload. Rescope ("graph from here") stays on
  /// the inspector, right-click, and chord, not the double-click. The
  /// preceding tap already set the selection, so this reads it directly.
  function onGraphDoubleClick(): void {
    if (
      filesystemMode &&
      selectedFsNode &&
      isFsDirectory(selectedFsNode) &&
      selectedFsNode.path
    ) {
      void toggleDirExpand(selectedFsNode.path);
      return;
    }
    // In semantic mode the directory spine ships in the
    // already-loaded /api/graph payload, so a directory double-click
    // toggles its children purely client-side - no fs-graph fetch, no
    // mode flip. The fresh from-here graph is semantic, so this is
    // what makes double-click-to-expand work there without first
    // running "Graph from here" on the root. The directory node is a
    // `folder`-kind RenderedNode whose `path` is the bare workspace-
    // relative directory path (the expanded set is keyed by path).
    if (selectedNode && selectedNode.kind === "folder") {
      toggleSemanticDirExpand(selectedNode.path);
    }
  }

  /// Toggle a directory's expansion in semantic mode. Unlike the
  /// filesystem-mode `toggleDirExpand`, the whole spine is already
  /// loaded by the graphStream fetch, so expanding just flips the
  /// `expanded` flag and `scopedNodeIds` re-derives the visible set;
  /// there is no per-directory degree to fetch.
  function toggleSemanticDirExpand(path: string): void {
    if (graphState.expanded[path]) {
      delete graphState.expanded[path];
    } else {
      const before = new Set(visibleNodeIds);
      graphState.expanded[path] = true;
      void requestExpansionFitAfterUpdate(path, before);
    }
  }

  /// Workspace-relative parent directory of a path ("" for a top-level
  /// entry).
  function parentDirOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }

  function renderedDirectoryId(path: string): string {
    return filesystemMode ? path : directoryNodeId(path);
  }

  async function requestExpansionFitAfterUpdate(
    path: string,
    before: Set<string>,
  ): Promise<void> {
    await tick();
    const ids = new Set<string>([renderedDirectoryId(path)]);
    if (path) ids.add(renderedDirectoryId(parentDirOf(path)));
    for (const id of visibleNodeIds) {
      if (!before.has(id)) ids.add(id);
    }
    expansionFitRequest = { nonce: ++expansionFitNonce, ids: [...ids] };
  }

  /// True once at least one child of `dir` is in the loaded spine, so a
  /// re-expand can show it without another fetch.
  function dirChildrenLoaded(dir: string): boolean {
    return fsNodes.some((n) => n.path !== dir && parentDirOf(n.path) === dir);
  }

  /// Merge a single-directory fs-graph batch into the accumulated spine
  /// and re-project the rendered node / edge sets.
  function mergeFsResponse(fs: FsGraphResponse): void {
    const nodeById = new Map(fsNodes.map((n) => [n.id, n]));
    for (const n of fs.nodes) nodeById.set(n.id, n);
    fsNodes = [...nodeById.values()];
    const ekey = (e: FsGraphEdge): string =>
      `${e.source} ${e.target} ${e.kind}`;
    const edgeByKey = new Map(fsEdgesRaw.map((e) => [ekey(e), e]));
    for (const e of fs.edges) edgeByKey.set(ekey(e), e);
    fsEdgesRaw = [...edgeByKey.values()];
    const merged: FsGraphResponse = {
      root: fs.root,
      scope: fs.scope,
      path: fs.path,
      depth: fs.depth,
      nodes: fsNodes,
      edges: fsEdgesRaw,
      truncated: fsTruncated,
    };
    nodes = mapFsNodes(merged);
    edges = mapFsEdges(merged);
  }

  /// Per-batch node budget for cursor-paged fs-graph delivery. Within the
  /// server's [16, 256] clamp; small enough that appending a batch plus a
  /// low-alpha layout pass stays within a frame, large enough to keep the
  /// round-trip count down on a big workspace.
  const GRAPH_BATCH_NODES = 128;

  /// Yield to the next animation frame between batches so the editor, file
  /// browser, terminal, and other graphs stay interactive while a large
  /// spine fills in.
  function yieldToFrame(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /// Fetch one directory's next degree (find -d 1), cursor-paged so a very
  /// wide directory fills in gradually. Drops the result if a full reload
  /// superseded it mid-flight.
  async function fetchDirChildren(dir: string): Promise<void> {
    const seq = graphLoadSeq;
    let cursor: string | undefined;
    let fs: FsGraphResponse;
    try {
      do {
        fs = await api.fsGraph({
          scope: "directory",
          path: dir,
          depth: 1,
          limit: GRAPH_BATCH_NODES,
          cursor,
        });
        if (seq !== graphLoadSeq) return;
        fsTruncated = fsTruncated || fs.truncated;
        mergeFsResponse(fs);
        cursor = fs.cursor ?? undefined;
        if (!fs.done && cursor) {
          await yieldToFrame();
          if (seq !== graphLoadSeq) return;
        }
      } while (!fs.done && cursor);
    } catch {
      // Best-effort; leave the directory as-is if a batch fails.
    }
  }

  /// Directory paths in the currently-loaded graph. Filesystem mode
  /// emits `directory`-kind fs-graph nodes; semantic mode emits
  /// `folder`-kind RenderedNodes (the /api/graph directory spine).
  /// Both carry the bare workspace-relative path on `path`, which is
  /// how the `expanded` set is keyed.
  function loadedDirectoryPaths(): string[] {
    if (filesystemMode) {
      return fsNodes.flatMap((n) =>
        n.kind === "directory" && n.path ? [n.path] : [],
      );
    }
    return nodes.flatMap((n) =>
      n.kind === "folder" && n.path ? [n.path] : [],
    );
  }

  /// Re-establish the expanded set so the depth slider expands
  /// the directory tree FROM THE CURRENTLY SELECTED directory downward
  /// by `depth` levels. Selecting the workspace root and cranking the
  /// slider to its max reveals the whole workspace; selecting a
  /// directory two levels deep expands only that subtree. The selected
  /// directory's ancestors stay expanded so the revealed subtree stays
  /// attached to the spine. When nothing (or a non-directory) is
  /// selected the seed falls back to the scope root, keeping the
  /// "find -d N from the scope root" behaviour. Authoritative:
  /// the slider overrides individual expand / collapse toggles.
  function seedExpandedFromSelected(depth: number): void {
    const scopeRoot = currentScope?.kind === "dir" ? currentScope.path : "";
    // The slider seeds from the selected directory when one is
    // selected; otherwise from the scope root. A selected file (or
    // non-directory node) seeds from the scope root, not the file's
    // parent, so cranking the slider over a file behaves like "expand
    // the whole scope" rather than a surprise re-root.
    const selectedDirPath =
      filesystemMode && selectedFsNode && isFsDirectory(selectedFsNode)
        ? selectedFsNode.path
        : !filesystemMode && selectedNode?.kind === "folder"
          ? selectedNode.path
          : null;
    const seedRoot = selectedDirPath ?? scopeRoot;
    const next: Record<string, boolean> = { "": true };
    if (scopeRoot) next[scopeRoot] = true;
    // Keep every ancestor directory between the scope root and the
    // seed root expanded so the seeded subtree is reachable from the
    // spine (otherwise the ancestor-expanded gate would hide it).
    if (seedRoot && seedRoot !== scopeRoot) {
      const rel =
        scopeRoot && seedRoot.startsWith(`${scopeRoot}/`)
          ? seedRoot.slice(scopeRoot.length + 1)
          : seedRoot;
      const parts = rel.split("/");
      let prefix = scopeRoot;
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        next[prefix] = true;
      }
    }
    if (seedRoot) next[seedRoot] = true;
    // Expand every directory within `depth` levels below the seed
    // root. relativeDepth(seedRoot, dir) === 1 is a direct child;
    // a directory at relative depth d expands its own children when
    // d < depth (find -d N semantics).
    for (const dir of loadedDirectoryPaths()) {
      const rel = relativeDepth(seedRoot, dir);
      if (rel >= 1 && rel < depth) next[dir] = true;
    }
    graphState.expanded = next;
  }

  /// Fetch children for any expanded directory whose degree isn't loaded
  /// (a reload replaced the spine, or a restored snapshot opened a
  /// directory beyond the fetched depth).
  async function reconcileExpandedChildren(): Promise<void> {
    const expanded = graphState.expanded;
    for (const dir of Object.keys(expanded)) {
      if (!expanded[dir] || dir === "") continue;
      if (!dirChildrenLoaded(dir)) await fetchDirChildren(dir);
    }
  }

  /// Toggle a directory node's expansion (double-click). Expanding fetches
  /// its next degree if not already loaded; collapsing hides its subtree.
  async function toggleDirExpand(path: string): Promise<void> {
    if (!path) return;
    if (graphState.expanded[path]) {
      delete graphState.expanded[path];
    } else {
      const before = new Set(visibleNodeIds);
      graphState.expanded[path] = true;
      if (!dirChildrenLoaded(path)) await fetchDirChildren(path);
      await requestExpansionFitAfterUpdate(path, before);
    }
  }

  /// "Graph from here" spawns a NEW graph tab seeded at the clicked node
  /// (the nav contract: a from-here graph is always its own tab, never an
  /// in-place re-root of the current one). The new tab opens in semantic
  /// mode -- a directory scope pulls the `contains` spine plus every layer
  /// (link / backlink / hashtag / contact / language) and supports
  /// double-click / depth-slider expansion, so the from-here graph stays
  /// rich. `pendingSelectId` lands the new graph already selected on the
  /// node. Like the language / tag / contact lenses (their `openGraphFor*`
  /// helpers), this spawns a new tab; only the breadcrumb
  /// (`rescopeFromHere`) re-scopes in place.
  function graphFromHere(path: string, isDir: boolean): void {
    let scopeId: string;
    if (isDir) {
      scopeId = path ? `dir:${path}` : "workspace";
    } else {
      const slash = path.lastIndexOf("/");
      const parent = slash > 0 ? path.slice(0, slash) : "";
      scopeId = parent ? `dir:${parent}` : "workspace";
    }
    openGraphInActivePane({
      mode: "semantic",
      scopeId,
      depth: 1,
      pendingSelectId: path,
    });
  }

  function close(): void {
    onClose?.();
  }

  // ---- types -------------------------------------------------------------

  // The graph view renders documents (files), images (also file
  // nodes, split by extension at element-build time), tags, and
  // mentions. Dates are still filtered out at load: chan-workspace's
  // graph index has stopped emitting date edges (issue #17), but
  // older indexes may still contain them.
  /// `group` is a synthetic edge kind: cytoscape-only, never emitted
  /// by chan-workspace's graph index. It exists to fan `group` edges
  /// from a synthetic hub node (id `SCOPE_HUB_ID`) to the files in a
  /// multi-file `group` scope -- but no graph scope kind produces a
  /// group scope, so that synthesis is unreachable; the edge-kind +
  /// hub machinery is dead and awaits a follow-up cleanup.
  type RenderedEdgeKind = "link" | "tag" | "mention" | "contains" | "language" | "group";
  /// Stable id for the synthetic scope hub node. Prefixed with `__`
  /// so it can't collide with a real file path.
  const SCOPE_HUB_ID = "__scope_hub__";
  type RenderedEdge = GraphViewEdge & { kind: RenderedEdgeKind };
  type RenderedNode = Extract<
    GraphViewNode,
    { kind: "file" | "tag" | "mention" | "language" | "folder" }
  >;
  /// Chip toggles. `link`, `tag`, `mention` are edge-kind filters
  /// (the visual element they govern is the edge plus any node only
  /// reachable through edges of that kind). `img` and `folder` are
  /// node filters: flipping them off hides every file node whose
  /// path classifies as image / directory, along with any edge
  /// touching one.
  /// `link` is intentionally absent from the user-facing
  /// FilterKind -- link edges always render (visibility is
  /// implicit via endpoint visibility). The `link` slot on
  /// `GraphFilters` (store.svelte.ts) stays for URL-hash
  /// back-compat but isn't consumed here.
  /// `markdown` + `source` FileBucket toggles, default ON. The
  /// SPA-side `classifyFile` helper dispatches file nodes into
  /// the markdown / source / binary buckets client-side:
  /// `GraphNodeView::File` doesn't carry the `bucket` field
  /// (`ReportFileStats` does), so classification happens here
  /// rather than in a chan-server emit.
  type FilterKind =
    | "tag"
    | "mention"
    | "language"
    | "img"
    | "folder"
    | "markdown"
    | "source";

  // ---- state -------------------------------------------------------------

  let nodes: RenderedNode[] = $state([]);
  let edges: RenderedEdge[] = $state([]);
  let fsNodes: FsGraphNode[] = $state([]);
  /// Raw fs-graph edges accumulated alongside `fsNodes`, so a
  /// single-directory expand can merge into the spine and re-project the
  /// rendered edge set without losing already-loaded degrees.
  let fsEdgesRaw: FsGraphEdge[] = $state([]);
  let fsTruncated = $state(false);
  /// Trackers for the expanded-set reseed: the depth + scope the current
  /// expanded set was established for. A depth-slider move or a rescope
  /// re-establishes the set (find -d N); mount / watcher reloads keep it.
  /// `null` until the first load seeds a fresh instance (no snapshot).
  let appliedDepth: number | null = null;
  let appliedScopeKey: string | null = null;
  let workspaceDepthProbe: FsGraphResponse | null = $state(null);
  let workspaceDepthProbeLoading = $state(false);
  /// Directory-scope depth probe. The depth slider's cap is the
  /// max relative depth REACHABLE under the scope, which we can only
  /// learn by walking deeper than the currently-loaded slice. At depth
  /// 1 the loaded fs-graph only contains depth-1 nodes, so a cap derived
  /// from it collapses to 1 and the clamp effect snaps the slider back
  /// the moment the user drags it. The workspace scope already solves this
  /// with `workspaceDepthProbe` (a full-depth walk of the root); this is the
  /// same probe for an arbitrary directory scope, keyed by the scope
  /// path so it re-probes when the scope changes.
  let dirDepthProbe: FsGraphResponse | null = $state(null);
  let dirDepthProbeLoading = $state(false);
  let dirDepthProbePath: string | null = $state(null);
  let languageMaxDepth = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);
  let watchReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let seenGraphReloadNonce = graphReloadSignal.nonce;
  let graphLoadAbort: AbortController | null = null;
  let graphLoadSeq = 0;
  // Keep-alive load gating (round 2). PLAIN locals, never rendered:
  // they are read/written only inside the load + watcher effects, so
  // they cannot trip Svelte's state_unsafe_mutation guard (that fires
  // on mutating $state inside a $derived). `hasLoadedOnce` makes the
  // first load LAZY on first activation rather than on mount (the
  // each-block mounts every graph tab at session restore; mount-gating
  // would fire N loads at once). `graphDirty` records that a hidden
  // graph missed an in-scope watcher edit, so it reloads exactly once
  // when next shown. `lastLoadedKey` lets the visible-load decision
  // tell a real scope/depth/mode change from an idempotent re-fire.
  let hasLoadedOnce = false;
  let graphDirty = false;
  let lastLoadedKey: string | null = null;
  // GraphCanvas `open` must LATCH true once the graph has been shown,
  // never track `active` directly: GraphCanvas.start() resets the
  // pan/zoom transform and stop() discards the sim + node arrays, so
  // open={active} would kill pan/zoom/selection on every tab switch.
  // This IS $state (it feeds the `open` prop, so it must be reactive)
  // and is written only inside the effect below -- not a $derived -- so
  // it stays clear of the state_unsafe_mutation guard. The companion
  // `paused={!active}` prop suspends the canvas rAF loop while hidden
  // so a latched-but-inactive graph does zero background paint.
  let canvasEverShown = $state(false);
  $effect(() => {
    if (active) canvasEverShown = true;
  });

  // ---- per-instance scoped /ws subscriptions ------------------------------
  //
  // The Graph is a watcher-scope instance just like a File Browser
  // surface (subscribe to that directory's watcher, reuse the
  // FB pub/sub). It registers in the shared `fbTreeInstances` registry
  // and subscribes to the directory scopes it currently displays; as the
  // depth slider loads the next degree the new directory nodes appear in
  // the rendered set and the reconcile effect subscribes them, and as
  // depth decreases (or the scope narrows / the panel closes) the dropped
  // directories are unsubscribed, with the LAST instance to release a dir
  // tearing the server watcher down. This shares the exact refcounted
  // mechanism File Browser workspaces via `fbWatch`; the actual redraw still
  // runs through the existing `graphReloadSignal` reload path.
  const graphInstanceId = $derived(tab ? `graph-tab-${tab.id}` : "graph-overlay");

  /// Directory scopes the currently-loaded graph displays. In
  /// filesystem mode this is the set of `directory` fs-graph nodes; in
  /// the semantic/workspace view it is the scope directory plus the parent
  /// directories of the rendered file nodes. Root (`""`) is excluded
  /// (always implicitly watched). Recomputes as nodes / depth / scope
  /// change so the reconcile effect tracks the visible degree.
  const displayedDirs = $derived.by<string[]>(() => {
    const dirs = new Set<string>();
    for (const n of fsNodes) {
      if (n.kind === "directory" && n.path) dirs.add(n.path);
    }
    if (currentScope?.kind === "dir" && currentScope.path) dirs.add(currentScope.path);
    // Semantic file nodes don't carry a directory node; add their parent
    // dirs so a save inside a shown document's folder reaches this graph.
    for (const n of nodes) {
      if (n.kind !== "file") continue;
      const slash = n.path.lastIndexOf("/");
      if (slash > 0) dirs.add(n.path.slice(0, slash));
    }
    dirs.delete("");
    return [...dirs];
  });

  $effect(() => {
    const id = graphInstanceId;
    untrack(() => fbWatchRegister(id));
    return () => untrack(() => fbWatchDispose(id));
  });

  $effect(() => {
    if (!visible) return;
    const id = graphInstanceId;
    const dirs = displayedDirs;
    untrack(() => fbWatchReconcile(id, dirs));
  });

  /// Chip toggles live on `graphState.filters` (module state) so
  /// they round-trip through the URL hash. Local proxy aliases keep
  /// the existing read sites compact.
  const show = $derived(graphState.filters);
  const filesystemMode = $derived(
    graphState.mode === "filesystem" &&
      (currentScope?.kind === "file" ||
        currentScope?.kind === "dir" ||
        currentScope?.kind === "workspace"),
  );
  const languageMode = $derived(graphState.mode === "language");

  /// `indexStatus` is the workspace-global indexer state. While the index is
  /// still building/reindexing, or the workspace is recovering, the semantic
  /// graph may be INCOMPLETE -
  /// link targets that simply aren't indexed yet surface as dead-end
  /// ("missing") nodes. Surface an "indexing" cue so an in-flight graph
  /// isn't trusted as complete; once the index is idle, any remaining
  /// dead-end is a real broken link. (`hiddenMissingIds` below pulls
  /// those dead-ends back while indexing; a per-parent-dir pulse is a
  /// deferred refinement.)
  const workspaceRecovering = $derived(
    indexStatus.value?.state === "recovering",
  );
  const indexBuilding = $derived(
    indexStatus.value?.state === "building" ||
      indexStatus.value?.state === "reindexing" ||
      workspaceRecovering,
  );

  /// Copy for the canvas empty-state (not loading, no error, zero nodes).
  /// Filesystem mode is structural: it reads the on-disk tree, not the
  /// index, so it keeps its scope message regardless of index state. The
  /// markdown and language graphs are both index-derived, so a zero-node
  /// result WHILE the index is still building means "not ready yet", not
  /// "nothing here"; `indexBuilding` shows the temporarily-unavailable
  /// copy. An idle zero-node markdown graph most often means the semantic
  /// index has not populated yet, so it stays optimistic ("data being
  /// indexed, hang tight..."); language mode keeps its genuine-empty
  /// scope message.
  const emptyStateMessage = $derived(
    filesystemMode
      ? "no filesystem graph nodes for this scope"
      : workspaceRecovering
        ? "graph unavailable while the workspace recovers"
        : indexBuilding
          ? "graph temporarily unavailable while indexing the workspace"
          : languageMode
            ? "no language graph nodes for this workspace yet"
            : "data being indexed, hang tight...",
  );

  /// Shallow-scope cue: when the scope's
  /// `depthCap` is 1 (single-file graph with no further forward
  /// hops; tag scope with only direct neighbours; etc.) the
  /// slider can't meaningfully be dragged. Surface that via a
  /// `[max]` suffix + disable the slider so the user can see at
  /// a glance there's nothing more to reveal. Gates: only fires
  /// outside language mode (which has its own depth=0 "max"
  /// affordance) + only when the slider would otherwise be
  /// enabled (depthDisabled is the workspace/global guard).
  const depthShallow = $derived.by(() => {
    if (languageMode) return false;
    // Workspace scope takes the shallow check too: with the
    // workspace depth probe feeding a meaningful `depthCap`, a
    // workspace whose deepest dir sits at depth 1 reads as
    // legitimately shallow and the `[max]` cue + disabled state
    // mirrors the dir-scope shape.
    if (!currentScope) return false;
    return depthCap <= 1;
  });

  const depthCap = $derived.by(() => {
    if (languageMode) return Math.max(1, languageMaxDepth);
    if (loading && currentScope?.kind === "dir" && nodes.length === 0) {
      return DEPTH_MAX;
    }
    // For a directory scope the loaded fs-graph only reaches the
    // current depth, so deriving the cap from it pins the slider at the
    // loaded depth (it cannot grow to reveal a deeper layer). Prefer the
    // full-depth `dirDepthProbe` (mirrors what the workspace scope already
    // does) so the cap is the directory's REACHABLE depth. Until the
    // probe lands, keep DEPTH at least at the loaded slice's depth so
    // the slider never snaps below what's already on screen.
    if (filesystemMode && currentScope?.kind === "dir") {
      const probeCap = graphDepthCap({
        scope: currentScope,
        nodes,
        fsGraph: dirDepthProbe ?? { nodes: fsNodes, truncated: fsTruncated },
        hardMax: DEPTH_MAX,
        fsMax: FS_GRAPH_DEPTH_MAX,
      });
      return Math.max(probeCap, graphState.depth);
    }
    return graphDepthCap({
      scope: currentScope,
      nodes,
      fsGraph: filesystemMode
        ? { nodes: fsNodes, truncated: fsTruncated }
        : currentScope?.kind === "workspace"
          ? workspaceDepthProbe
          : null,
      hardMax: DEPTH_MAX,
      fsMax: FS_GRAPH_DEPTH_MAX,
    });
  });

  // Currently inspected node, surfaced in the side details panel.
  // Tap a node to set this; tap empty space to clear it. Nodes never
  // auto-open on click; the panel's Open button is the only path to
  // opening a file from here.
  let selectedId = $state<string | null>(null);
  let expansionFitNonce = 0;
  let expansionFitRequest = $state<{ nonce: number; ids: string[] } | null>(null);

  /// Tab right-click bubble state. Open when the
  /// shared tab-menu state addresses THIS tab; positioned via the
  /// stored anchor through `clampMenu` so the bubble stays on-
  /// screen even when the tab sits near the viewport edge.
  const tabMenuOpen = $derived(tab !== undefined && tabMenu.openForTabId === tab.id);
  const tabMenuPos = $derived.by(() => {
    const a = tabMenu.anchor;
    if (!a) return { x: 0, y: 0 };
    return { x: Math.round(a.left), y: Math.round(a.bottom + 4) };
  });

  function onTabMenuKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && tabMenuOpen) {
      e.preventDefault();
      closeTabMenu();
    }
  }

  /// Dismiss when the click lands outside the bubble AND outside
  /// the tab strip (the tab row's own click handler toggles the
  /// state; without this guard the global handler races the row
  /// handler and closes the menu before the row can re-open it).
  function onTabMenuPointerDown(e: PointerEvent): void {
    if (!tabMenuOpen) return;
    const t = e.target as Node | null;
    if (!t) return;
    const bubble = document.querySelector(".tab-menu-bubble");
    if (bubble && bubble.contains(t)) return;
    const trigger = (t as Element).closest?.(".tab");
    if (trigger) return;
    closeTabMenu();
  }
  /// Cap matches the slider's `max` attribute below. Lifting it past
  /// 5 gave room for sparse workspaces where the seed file's neighborhood
  /// fans out wider than the previous limit allowed; 10 is well
  /// short of the diameter of any realistic workspace.
  const DEPTH_MAX = 10;

  /// Files split into "doc", "img", or "contact" by the same rules
  /// the GraphCanvas renderer uses: image classification is
  /// extension-based, contact comes from the wire `node_kind:
  /// "contact"` stamp the indexer applies to chan-workspace's
  /// `contacts()` set, everything else is a doc. Mirrored here
  /// because `hiddenImageIds` / `counts` / `inspectorSelection`
  /// need the kind upfront for chip filtering.
  /// File-class buckets (`doc` for markdown, `source` for
  /// code/config, `binary` for everything else not covered by
  /// img/contact) let the markdown + source filter chips route
  /// file nodes into their buckets. Mirrors
  /// `GraphCanvas.svelte`'s helper of the same name, plus
  /// `MARKDOWN_EXT_RE` + `SOURCE_EXT_RE`. The two helpers stay
  /// separate copies -- they're parallel SPA-side helpers with the
  /// same regex set; a future cleanup task could extract them
  /// into a shared module.
  const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
  const MARKDOWN_EXT_RE = /\.(md|txt)$/i;
  const SOURCE_EXT_RE =
    /\.(rs|py|ts|tsx|js|jsx|mjs|cjs|go|c|cc|cpp|cxx|h|hh|hpp|java|kt|swift|rb|php|cs|sh|bash|zsh|fish|pl|lua|toml|yaml|yml|json|jsonc|ini|conf|cfg|env|xml|html|htm|css|scss|sass|less|vue|svelte|sql|graphql|gql|proto|elm|ex|exs|erl|hs|lhs|ml|mli|fs|fsx|clj|cljs|cljc|edn|jl|nim|d|dart|zig|odin|v|vhd|vhdl|sv|verilog|asm|s|f|f90|f95|tex|R|r)$/i;

  function classifyFile(
    path: string,
    nodeKind: "contact" | undefined,
  ): "doc" | "img" | "contact" | "source" | "binary" {
    if (MEDIA_EXT_RE.test(path)) return "img";
    if (nodeKind === "contact") return "contact";
    if (MARKDOWN_EXT_RE.test(path)) return "doc";
    if (SOURCE_EXT_RE.test(path)) return "source";
    return "binary";
  }

  /// Watcher-triggered reload for visible graphs. With keep-alive the
  /// graph no longer reloads on tab activation; this forces a fresh
  /// /api/graph fetch when an in-scope edit arrives and keeps the
  /// depth probe aligned at workspace scope.
  async function reloadGraph(): Promise<void> {
    closeTabMenu();
    if (currentScope?.kind === "workspace") {
      workspaceDepthProbe = null;
      await loadWorkspaceDepthProbe();
    }
    lastLoadedKey = loadKey;
    graphDirty = false;
    await load();
  }

  function closeFromMenu(): void {
    closeTabMenu();
    close();
  }

  async function loadWorkspaceDepthProbe(): Promise<void> {
    if (workspaceDepthProbeLoading) return;
    workspaceDepthProbeLoading = true;
    try {
      workspaceDepthProbe = await api.fsGraph({
        scope: "directory",
        path: "",
        depth: FS_GRAPH_DEPTH_MAX,
      });
    } catch {
      workspaceDepthProbe = null;
    } finally {
      workspaceDepthProbeLoading = false;
    }
  }

  /// Probe a directory scope at the full fs-graph depth so the
  /// slider cap reflects the deepest layer the user could reveal, not
  /// just the layer currently loaded. Keyed by `path`; a stale probe
  /// for a different directory is discarded by the caller's guard.
  async function loadDirDepthProbe(path: string): Promise<void> {
    if (dirDepthProbeLoading) return;
    dirDepthProbeLoading = true;
    dirDepthProbePath = path;
    try {
      const probe = await api.fsGraph({
        scope: "directory",
        path,
        depth: FS_GRAPH_DEPTH_MAX,
      });
      // Drop the result if the scope moved on while we were fetching.
      if (dirDepthProbePath === path) dirDepthProbe = probe;
    } catch {
      if (dirDepthProbePath === path) dirDepthProbe = null;
    } finally {
      dirDepthProbeLoading = false;
    }
  }

  function onGraphContextMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    // Let the browser's native UI fire on real form controls.
    if (t?.closest("select, input")) return;
    e.preventDefault();
    // Right-click ANYWHERE on the graph canvas / background opens the
    // graph tab menu at the cursor, mirroring the editor's right-click-
    // anywhere. The tab-strip trigger anchors to its button rect; here we
    // anchor a zero-size rect at the pointer so tabMenuPos drops the bubble
    // under the cursor.
    openTabMenu(tab.id, {
      left: e.clientX,
      top: e.clientY,
      right: e.clientX,
      bottom: e.clientY,
    });
  }

  // ---- derived: scope-filtered render set --------------------------------
  //
  // Two filters compose to decide what's drawn:
  //
  //   (1) the SCOPE picker in the header (file / group / workspace).
  //       For file and group, BFS out from the seed paths up to
  //       graphState.depth hops. Workspace = no filter.
  //   (2) the per-edge-kind chips (link / tag). Edges whose kind
  //       is filtered out are dropped, and any non-file node
  //       attached only via filtered edges drops too.
  //
  // (1) runs first so the BFS sees the full graph (depth = "graph
  // hops away"). (2) is a render-time filter that can change without
  // re-walking the graph.

  /// Set of node ids included by the current scope. `null` means
  /// "no scope filter" -- workspace scope (current behaviour) or the
  /// global scope (placeholder; once cross-workspace indexing lands
  /// it'll need its own logic, but treating it as "no filter"
  /// today returns the same set as workspace since chan only knows
  /// about one workspace at a time).
  /// The directory-spine expanded set, stored on the graph tab so it
  /// serializes into the tab's hash / session state (File Browser tab
  /// parity) and survives a window reload. A directory is present when its
  /// children should show; the scope root ("") is always expanded.
  const expandedDirs = $derived(graphState.expanded ?? { "": true });

  /// Pull every in-scope node's directory spine up to the workspace
  /// root. `contains` edges point parent -> child (directory -> file
  /// and directory -> subdirectory), so a node's ancestors sit
  /// UPSTREAM of it: add the `source` of every contains edge whose
  /// `target` is already in scope, iterating to a fixed point. The
  /// contains subgraph is a forest (one parent per node) so this
  /// settles in O(depth) passes.
  ///
  /// The tag / contact / language lenses BFS only along semantic
  /// edges (tag / mention / language), so their file nodes used to
  /// render with no edge up to a directory ("edgeless files"). The
  /// spine already ships in the unified /api/graph payload (the
  /// filesystem layer emits the contains edges to root); this just
  /// re-includes it in the lens's visible set so every file lands on
  /// its spine, matching the workspace / file-scope shape. Folder-
  /// filter hiding is still handled later by `hiddenFolderIds`.
  function pullContainsSpine(visited: Set<string>): void {
    let pulled = true;
    while (pulled) {
      pulled = false;
      for (const e of edges) {
        if (
          e.kind === "contains" &&
          visited.has(e.target) &&
          !visited.has(e.source)
        ) {
          visited.add(e.source);
          pulled = true;
        }
      }
    }
  }

  const scopedNodeIds = $derived.by<Set<string> | null>(() => {
    if (!currentScope) return null;
    // Semantic-mode workspace + dir scope renders the
    // FULL rich graph (files + tags + mentions + languages + the
    // directory spine), with the directory tree expanded / collapsed
    // by the same `graphState.expanded` set the filesystem mode uses.
    // A file / folder node renders only when every ancestor directory
    // up to the scope root is expanded (File Browser tree parity);
    // double-click a directory node to toggle its children, or drag
    // the depth slider to seed the expanded set from the selected
    // directory downward (`seedExpandedFromSelected`). Tag / mention /
    // language meta-nodes always pass through (they get culled
    // naturally by the edges filter if no visible file references
    // them); the workspace-root anchor is unconditional so the spine
    // always has a root to hang off. A flat
    // `relativeDepth(root, path) <= depth` filter would (1) not
    // be expandable / collapsible per-node and (2) force "Graph from
    // here" on a directory into the directories-only filesystem mode
    // to get expansion, dropping every non-directory layer. File scope
    // keeps the hop-based BFS below; "Graph from here" on a single
    // file is the right surface for hop semantics.
    if (
      !filesystemMode &&
      (currentScope.kind === "workspace" || currentScope.kind === "dir")
    ) {
      const rootPath =
        currentScope.kind === "workspace" ? "" : currentScope.path;
      const expanded = expandedDirs;
      const visible = new Set<string>();
      for (const n of nodes) {
        if (n.kind === "tag" || n.kind === "mention" || n.kind === "language") {
          visible.add(n.id);
          continue;
        }
        if (n.kind === "folder" && (n.id === "" || n.path === "")) {
          // Workspace root anchor is always visible regardless of
          // scope so the spine has a root to hang off.
          visible.add(n.id);
          continue;
        }
        // file / folder remain after the meta-node continue + the
        // workspace-root short-circuit above. RenderedNode doesn't
        // model media as a separate kind - media files come through
        // as `kind: "file"` and the canvas re-classifies them via
        // `classifyFile`. Their `.path` works the same way, so the
        // ancestor-expanded gate covers files and subdirectories
        // alike.
        if (ancestorsExpanded(rootPath, n.path, expanded)) visible.add(n.id);
      }
      return visible;
    }
    // Filesystem mode: the directory spine is shown / hidden by the
    // expanded set (double-click a directory to reveal its next degree;
    // File Browser parity). A node renders only when every ancestor
    // directory up to the scope root is expanded; the depth slider seeds
    // that set to depth N. File scope is a focused single-file view with
    // no tree to expand, so it keeps the full unfiltered spine. The
    // per-kind chip filters still apply downstream in visibleNodeIds /
    // visibleEdges.
    if (filesystemMode) {
      if (currentScope.kind === "file") return null;
      const fsRoot = currentScope.kind === "dir" ? currentScope.path : "";
      const expanded = expandedDirs;
      const visible = new Set<string>();
      for (const n of nodes) {
        if (n.kind !== "file" && n.kind !== "folder") {
          visible.add(n.id);
          continue;
        }
        if (ancestorsExpanded(fsRoot, n.path, expanded)) visible.add(n.id);
      }
      return visible;
    }
    // Tag scope: seed with the tag node itself; BFS expands across
    // every doc that references it (depth 1) and further along
    // those docs' edges (depth 2+). No path resolution needed --
    // the node id IS the seed.
    //
    // The backend emits tag edges as `source: <file>, target:
    // <tagId>` (file -> tag). A forward-only BFS from the tag id
    // would never traverse the incoming file->tag edges and the
    // lens renders empty. The BFS is BIDIRECTIONAL (same shape
    // as the contact arm below) so depth=1 captures every doc
    // that references the tag (the backlinks the lens exists to
    // show) and deeper depths walk those docs' outgoing edges
    // further out.
    if (currentScope.kind === "tag") {
      const seedIds = new Set<string>([currentScope.nodeId]);
      const visited = new Set(seedIds);
      let frontier = new Set(seedIds);
      for (let i = 0; i < graphState.depth; i++) {
        const next = new Set<string>();
        for (const e of edges) {
          if (frontier.has(e.source) && !visited.has(e.target)) {
            next.add(e.target);
            visited.add(e.target);
          }
          if (frontier.has(e.target) && !visited.has(e.source)) {
            next.add(e.source);
            visited.add(e.source);
          }
        }
        if (next.size === 0) break;
        frontier = next;
      }
      // Pull each surfaced document's other @@mention / #tag / language
      // meta-edges into scope so it renders its full first-order semantic
      // edge set, not just the seed edge (bounded: only meta-nodes join).
      pullMetaNeighbours(visited, nodes, edges);
      // Re-anchor every file the lens surfaced to its directory
      // spine so no file renders edgeless.
      pullContainsSpine(visited);
      return visited;
    }
    // Mention lens: same shape as the tag arm above. The backend emits
    // mention edges as `source: <file>, target: <@@Name>` (file ->
    // mention), so a forward-only BFS from the mention id would never
    // traverse the incoming file->mention edges and the lens renders
    // empty. The BFS is BIDIRECTIONAL so depth=1 captures every doc
    // that references the handle (the backlinks the lens exists to
    // show) and deeper depths walk those docs' outgoing edges further.
    if (currentScope.kind === "mention") {
      const seedIds = new Set<string>([currentScope.nodeId]);
      const visited = new Set(seedIds);
      let frontier = new Set(seedIds);
      for (let i = 0; i < graphState.depth; i++) {
        const next = new Set<string>();
        for (const e of edges) {
          if (frontier.has(e.source) && !visited.has(e.target)) {
            next.add(e.target);
            visited.add(e.target);
          }
          if (frontier.has(e.target) && !visited.has(e.source)) {
            next.add(e.source);
            visited.add(e.source);
          }
        }
        if (next.size === 0) break;
        frontier = next;
      }
      // Pull each surfaced document's other @@mention / #tag / language
      // meta-edges into scope so it renders its full first-order semantic
      // edge set, not just the seed edge (bounded: only meta-nodes join).
      pullMetaNeighbours(visited, nodes, edges);
      // Re-anchor every file the lens surfaced to its directory
      // spine so no file renders edgeless.
      pullContainsSpine(visited);
      return visited;
    }
    // Contact lens. Seed is the contact file node (located by
    // its rel_path); BFS expands BIDIRECTIONALLY so the
    // resulting subgraph captures every doc that REFERENCES the
    // contact (incoming mention/link edges = backlinks) plus
    // everything the contact's own file links out to (outgoing
    // edges).
    // Forward-only BFS would lose the backlink half of the lens.
    if (currentScope.kind === "contact") {
      const relPath = currentScope.relPath;
      const seedIds = new Set<string>();
      for (const n of nodes) {
        if (n.kind === "file" && n.path === relPath) seedIds.add(n.id);
      }
      if (seedIds.size === 0) return seedIds;
      const visited = new Set(seedIds);
      let frontier = new Set(seedIds);
      for (let i = 0; i < graphState.depth; i++) {
        const next = new Set<string>();
        for (const e of edges) {
          if (frontier.has(e.source) && !visited.has(e.target)) {
            next.add(e.target);
            visited.add(e.target);
          }
          if (frontier.has(e.target) && !visited.has(e.source)) {
            next.add(e.source);
            visited.add(e.source);
          }
        }
        if (next.size === 0) break;
        frontier = next;
      }
      // Pull each surfaced document's other @@mention / #tag / language
      // meta-edges into scope so it renders its full first-order semantic
      // edge set, not just the seed edge (bounded: only meta-nodes join).
      pullMetaNeighbours(visited, nodes, edges);
      // Re-anchor every file the lens surfaced to its directory
      // spine so no file renders edgeless.
      pullContainsSpine(visited);
      return visited;
    }
    // Language lens. Seed is the language
    // bubble (node id `language:<lang>`); the lens is always
    // 1-hop (depth doesn't apply to language) so
    // the visible set is the bubble plus every direct neighbour
    // -- which by construction is every file of that language
    // since the language node carries an edge to each.
    if (currentScope.kind === "language") {
      const seedId = `language:${currentScope.language}`;
      const visited = new Set<string>([seedId]);
      for (const e of edges) {
        if (e.source === seedId) visited.add(e.target);
        if (e.target === seedId) visited.add(e.source);
      }
      // Re-anchor every file of this language to its directory
      // spine so no file renders edgeless.
      pullContainsSpine(visited);
      return visited;
    }
    // Only file scope reaches here in semantic mode:
    //   - workspace + dir handled by the filesystem-depth branch above.
    //   - tag / contact / language lenses return earlier.
    //   - filesystem mode bails at the top of the derivation.
    // File scope keeps the forward-BFS shape: "Graph from here" on a
    // single file means "expand N hops along outgoing edges from this
    // file" -- the hop semantic the chord users built intuition around.
    const seedPaths: string[] =
      currentScope.kind === "file" ? [currentScope.path] : [];
    const seedIds = new Set<string>();
    for (const n of nodes) {
      if (n.kind === "file" && seedPaths.includes(n.path)) seedIds.add(n.id);
    }
    if (seedIds.size === 0) return seedIds;
    const visited = new Set(seedIds);
    let frontier = new Set(seedIds);
    // Forward-only BFS: the walk follows edges source -> target
    // only. Following edges in both directions
    // (`frontier.has(e.source)` OR `frontier.has(e.target)`) would
    // hide the "depth slider reveals forward nodes" semantic.
    // Restricting to outgoing edges only makes the slider
    // read as "expand from the root in the direction edges point"
    // -- markdown links emanate from the root doc; contains edges
    // emanate from the root directory toward its children; etc.
    for (let i = 0; i < graphState.depth; i++) {
      const next = new Set<string>();
      for (const e of edges) {
        if (frontier.has(e.source) && !visited.has(e.target)) {
          next.add(e.target);
          visited.add(e.target);
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }
    // Parent-edge invariant: every in-scope file
    // should hang off its parent directory so the user can click up
    // through the graph. The forward-only BFS above expands DOWN from
    // the seed; `pullContainsSpine` walks the contains-edge forest the
    // other way, UP to the workspace root. Folder-filter hiding is
    // handled later by `hiddenFolderIds`, so we always include the
    // chain here.
    pullContainsSpine(visited);
    return visited;
  });

  /// File-node ids the `img` filter currently hides. Pulled out so
  /// both visibleEdges (drop edges touching a hidden image) and
  /// visibleNodeIds (skip the node entirely) agree.
  const hiddenImageIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.img) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && classifyFile(n.path, n.node_kind) === "img") ids.add(n.id);
    }
    return ids;
  });

  /// Contact-kind file-node ids hidden when the contact chip is off.
  /// The chip is wired off the `mention` filter slot (which is now
  /// user-labeled "contact") so toggling it has the same shape as the
  /// img toggle: hide the nodes AND any edges touching them. Without
  /// the node hide, the user would just see the contact rectangles
  /// floating with their mention edges gone -- half a filter.
  const hiddenContactIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.mention) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && n.node_kind === "contact") ids.add(n.id);
    }
    return ids;
  });

  /// Directory ids on the file→root containment SPINE: every directory that is
  /// an ancestor (via `contains` edges) of an in-scope file. These anchor files
  /// to the graph, so the folder chip must NOT hide them -- hiding them is what
  /// rendered file nodes "loose". Computed only when the folder chip is off
  /// (when on, nothing is hidden so the spine is moot). Seeds from in-scope
  /// files and walks `contains` upward, mirroring `pullContainsSpine`'s "no file
  /// renders edgeless" invariant. Keyed off in-scope (not chip-visible) files
  /// deliberately: keeping a directory whose only files are chip-filtered is
  /// harmless declutter, whereas dropping a spine directory re-introduces loose
  /// files (the safe direction is to over-keep anchors).
  const spineFolderIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.folder) return ids;
    const onSpine = new Set<string>();
    for (const n of nodes) {
      if (
        n.kind === "file" &&
        (scopedNodeIds === null || scopedNodeIds.has(n.id))
      ) {
        onSpine.add(n.id);
      }
    }
    // `contains` = directory(source) -> child(target); pull each source whose
    // target is already on the spine until no more ancestors are reachable.
    let pulled = true;
    while (pulled) {
      pulled = false;
      for (const e of edges) {
        if (
          e.kind === "contains" &&
          onSpine.has(e.target) &&
          !onSpine.has(e.source)
        ) {
          onSpine.add(e.source);
          pulled = true;
        }
      }
    }
    for (const n of nodes) {
      if (n.kind === "folder" && onSpine.has(n.id)) ids.add(n.id);
    }
    return ids;
  });

  /// Directory node ids hidden when the folder chip is off -- directory-bubble
  /// CLUTTER only. Directories on the file→parent spine (`spineFolderIds`) stay
  /// visible so files keep their containment anchor; the folder chip declutters
  /// directory bubbles, it does not cut the spine. Only meaningful in filesystem
  /// mode where directory-kind nodes are emitted; in markdown / language modes
  /// there are no directory nodes so the set stays empty and the toggle is a
  /// no-op.
  const hiddenFolderIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.folder) return ids;
    for (const n of nodes) {
      if (n.kind === "folder" && !spineFolderIds.has(n.id)) ids.add(n.id);
    }
    return ids;
  });

  /// File nodes hidden when the markdown chip is OFF.
  /// Bucket = `classifyFile === "doc"` (.md / .txt per the
  /// SPA-side classifier). The `contact` discriminator is gated by
  /// the `mention` chip (existing hiddenContactIds) and image-class
  /// files by `img`; this hidden-set covers markdown specifically.
  const hiddenMarkdownIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.markdown) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && classifyFile(n.path, n.node_kind) === "doc") {
        ids.add(n.id);
      }
    }
    return ids;
  });

  /// File nodes hidden when the source chip is OFF.
  /// Bucket = `classifyFile === "source"` (recognised code / config
  /// extensions).
  const hiddenSourceIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.source) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && classifyFile(n.path, n.node_kind) === "source") {
        ids.add(n.id);
      }
    }
    return ids;
  });

  /// While the index is still building, a
  /// `missing` (dead-end / not-on-filesystem) node may simply be a link
  /// target that has not been indexed YET, not a genuinely broken link.
  /// Pull those nodes back (and the edges touching them) until the index
  /// settles, so the graph never presents not-yet-known data as a broken
  /// link. Once `indexBuilding` clears, the `missing` survivors are real
  /// broken links and render with the established dashed-ghost styling.
  /// (The status bar's "indexing" cue is the loading signal; a
  /// per-parent-dir pulse is a deferred refinement.)
  const hiddenMissingIds = $derived.by(() => {
    const ids = new Set<string>();
    if (!indexBuilding) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && n.missing) ids.add(n.id);
    }
    return ids;
  });

  function edgeVisibleByChip(kind: RenderedEdgeKind): boolean {
    // `contains` is the file→parent spine, NOT folder-chip clutter: it renders
    // whenever both endpoints are visible (the hiddenFolderIds gate keeps only
    // non-spine directory bubbles out). Gating it on show.folder dropped the
    // whole spine when the folder chip was off and made files render loose.
    if (kind === "contains") return true;
    if (kind === "group") return true;
    // Link edges always render -- a link filter doesn't make
    // sense because link visibility
    // is implicit (an edge renders iff both endpoints render under
    // the current node-type filters + depth). The `link` slot on
    // `GraphFilters` stays for wire-format / URL-hash back-compat
    // but is no longer consumed by the UI.
    if (kind === "link") return true;
    return show[kind];
  }

  const visibleEdges = $derived(
    edges.filter(
      (e) =>
        edgeVisibleByChip(e.kind) &&
        !hiddenImageIds.has(e.source) &&
        !hiddenImageIds.has(e.target) &&
        !hiddenContactIds.has(e.source) &&
        !hiddenContactIds.has(e.target) &&
        !hiddenFolderIds.has(e.source) &&
        !hiddenFolderIds.has(e.target) &&
        // Hide edges touching markdown / source
        // file nodes the user has filtered out. Symmetric with the
        // existing img / contact / folder gates.
        !hiddenMarkdownIds.has(e.source) &&
        !hiddenMarkdownIds.has(e.target) &&
        !hiddenSourceIds.has(e.source) &&
        !hiddenSourceIds.has(e.target) &&
        // Drop edges to dead-end nodes pulled back while indexing.
        !hiddenMissingIds.has(e.source) &&
        !hiddenMissingIds.has(e.target) &&
        (scopedNodeIds === null ||
          (scopedNodeIds.has(e.source) && scopedNodeIds.has(e.target))),
    ),
  );
  const visibleNodeIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const n of nodes) {
      if (scopedNodeIds !== null && !scopedNodeIds.has(n.id)) continue;
      if (hiddenFolderIds.has(n.id)) continue;
      // Skip file nodes that the markdown / source
      // chips have hidden. The img + contact gates still apply.
      if (
        n.kind === "file" &&
        !hiddenImageIds.has(n.id) &&
        !hiddenContactIds.has(n.id) &&
        !hiddenMarkdownIds.has(n.id) &&
        !hiddenSourceIds.has(n.id) &&
        // Pull back dead-end nodes while the index is building.
        !hiddenMissingIds.has(n.id)
      ) {
        ids.add(n.id);
      } else if (n.kind === "folder") {
        ids.add(n.id);
      }
    }
    for (const e of visibleEdges) {
      ids.add(e.source);
      ids.add(e.target);
    }
    return ids;
  });

  /// Chip counts.
  ///
  /// Counts are NODE counts, not edge counts. Tallying edges
  /// per kind would make the mention chip show mention-edge
  /// fan-in (thousands) across only a few dozen distinct contact
  /// nodes -- a ~40x over-tally.
  /// User reads the chip as "how many of THIS thing is in the
  /// graph", which is the node count. Edge counts are the
  /// rendered-edge population, which is a different concept and
  /// not what the chip needs to expose.
  ///
  /// The contact / mention chip count adds:
  ///   * `mention`-kind nodes (handle nodes the parser emits).
  ///   * Contact-discriminated FILE nodes (`node_kind === "contact"`)
  ///     since the mention chip toggle hides BOTH (see
  ///     `hiddenContactIds`).
  ///
  /// The img chip count covers media-class file nodes (the chip
  /// toggle hides those). The folder chip count covers folder-kind
  /// nodes (the chip toggle hides those). Markdown / source chips
  /// use the same node-tally semantics.
  const counts = $derived.by(() => {
    const c: Record<FilterKind, number> = {
      tag: 0,
      mention: 0,
      language: 0,
      img: 0,
      folder: 0,
      markdown: 0,
      source: 0,
    };
    for (const n of nodes) {
      if (n.kind === "tag") {
        c.tag++;
        continue;
      }
      if (n.kind === "mention") {
        c.mention++;
        continue;
      }
      if (n.kind === "language") {
        c.language++;
        continue;
      }
      if (n.kind === "folder") {
        c.folder++;
        continue;
      }
      if (n.kind !== "file") continue;
      const cls = classifyFile(n.path, n.node_kind);
      if (cls === "img") c.img++;
      else if (cls === "contact") c.mention++;
      else if (cls === "doc") c.markdown++;
      else if (cls === "source") c.source++;
    }
    return c;
  });

  // ---- side-panel derived state ------------------------------------------

  const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));

  const selectedNode = $derived<RenderedNode | null>(
    // `selectedId !== null` (not a truthy test): the workspace-root
    // node carries id="" in the workspace-scope merged view, and a
    // truthy test would silently null it out.
    selectedId !== null ? (nodeById.get(selectedId) ?? null) : null,
  );
  const fsNodeById = $derived(new Map(fsNodes.map((n) => [n.id, n])));
  const selectedFsNode = $derived<FsGraphNode | null>(
    // The workspace-root directory has id="" (empty path = workspace root), so
    // `selectedId` is checked with `!== null` rather than a truthy
    // test -- otherwise clicking the root node silently no-op's the
    // inspector.
    filesystemMode && selectedId !== null
      ? (fsNodeById.get(selectedId) ?? null)
      : null,
  );

  /// True when the graph claims the node is a real file but the
  /// server's resolver couldn't find it on disk -- i.e. a genuine
  /// broken-link / deleted-file ghost. The server is the source of
  /// truth: its resolver covers all on-disk files
  /// (markdown + non-markdown). An SPA-side fallback that also
  /// checked the lazy-loaded FB tree's `tree.entries` would flag
  /// every real file under an un-expanded subtree as a false
  /// ghost, so trust the server flag alone.
  const isFileGhost = $derived<boolean>(
    selectedNode != null &&
      selectedNode.kind === "file" &&
      selectedNode.missing === true,
  );
  let ghostIndexerHint = $state<string | null>(null);

  function indexerGhostHint(status: string | undefined, queueDepth: number | undefined): string | null {
    if (status === "settling") {
      const n = Math.max(0, Math.floor(queueDepth ?? 0));
      return `indexer is catching up (${n} event(s) pending)`;
    }
    if (status === "rebuilding") return "indexer is rebuilding (full pass)";
    return null;
  }

  $effect(() => {
    if (
      !visible ||
      !isFileGhost ||
      selectedNode?.kind !== "file" ||
      selectedNode.missing
    ) {
      ghostIndexerHint = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function poll(): Promise<void> {
      try {
        const health = await api.health();
        if (cancelled) return;
        ghostIndexerHint = indexerGhostHint(
          health.indexer?.status,
          health.indexer?.queue_depth,
        );
      } catch {
        if (!cancelled) ghostIndexerHint = null;
      }
    }
    void poll();
    timer = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  });

  /// Documents that reference the currently-selected tag or mention
  /// node, restricted to nodes drawn in the current subgraph. Passed
  /// to InspectorBody as `documentsOverride` so the inspector stays
  /// consistent with what the user can see on the canvas; without it
  /// TagInfoBody would fall back to the full-graph
  /// `documentsReferencing` lookup.
  const selectionDocumentsInScope = $derived.by(() => {
    if (
      !selectedNode ||
      (selectedNode.kind !== "tag" && selectedNode.kind !== "mention")
    ) {
      return undefined;
    }
    const out: Extract<RenderedNode, { kind: "file" }>[] = [];
    for (const e of edges) {
      if (e.target !== selectedNode.id) continue;
      const source = nodeById.get(e.source);
      if (source && source.kind === "file") out.push(source);
    }
    return out;
  });

  /// Try to resolve a mention/contact label to a real .md file on
  /// disk: scan tree.entries for a contact-kind entry whose basename
  /// (sans .md) includes the mention label case-insensitively. Loose
  /// match on purpose -- `alice` should hit `Contacts/Alice Chen.md`
  /// without requiring an exact server-side resolution table on the
  /// frontend. Returns the first match; null when nothing fits.
  function resolveContactToPath(label: string): string | null {
    const needle = label.replace(/^@@/, "").toLowerCase().trim();
    if (!needle) return null;
    for (const e of tree.entries) {
      if (e.is_dir || e.kind !== "contact") continue;
      const base = e.path.split("/").pop() ?? e.path;
      const stem = base.replace(/\.md$/i, "").toLowerCase();
      if (stem.includes(needle)) return e.path;
    }
    return null;
  }

  /// Path the currently-selected mention/contact node resolves to,
  /// or null when the mention is unresolved (no contact file on
  /// disk yet). Workspaces whether the inspector renders the "Open in
  /// this pane" and "Set as Scope" buttons for mention rows.
  const selectedContactPath = $derived<string | null>(
    selectedNode && selectedNode.kind === "mention"
      ? resolveContactToPath(selectedNode.label)
      : null,
  );

  /// Tab-world reveal: open a File Browser TAB at `path`, select it, and
  /// expand its ancestor chain; for a directory expand the directory
  /// ITSELF too so the browser opens AT it ("enter the directory").
  /// Mirrors FileTree's `openSelectionInFileBrowser`.
  ///
  /// The graph is a tab, not an overlay, so the File Browser opens as a
  /// sibling tab and the graph persists -- there is no overlay to
  /// dismiss. This routes through the same tab-world primitive the File
  /// Browser's own "Open in File Browser" uses; an overlay-style
  /// `revealPathInBrowser(...)` + `close()` chain would run the
  /// directory fetch but open no visible browser tab, making Show
  /// Directory look like a no-op / graph re-layout.
  function revealPathInBrowserTab(path: string, isDir: boolean): void {
    const parts = path.split("/").filter(Boolean);
    // Directory: expand itself + ancestors. File: ancestors only (select
    // the file inside its already-expanded parent).
    const upto = isDir ? parts.length : parts.length - 1;
    const expanded: string[] = [];
    let acc = "";
    for (let i = 0; i < upto; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (acc) expanded.push(acc);
    }
    const isRoot = path === "";
    const tab = openBrowserInActivePane(isRoot ? {} : { select: path });
    tab.inspectorOpen = true;
    tab.showWorkspace = isRoot;
    tab.expanded = expanded.length > 0 ? expanded : undefined;
    fbSelectSingle(isRoot ? null : path);
    browserSelection.showWorkspace = isRoot;
    const map = treeExpanded.map;
    map[""] = true;
    for (const e of expanded) map[e] = true;
    persistTreeExpanded();
  }

  /// Graph "Open" for a node that resolves to a real workspace path.
  /// Mirrors the File Browser's open-selection: an editable text file
  /// (markdown note, contact, plain source / config) opens in the active
  /// editor pane through the same `openInActivePane` call
  /// `FileBrowserSurface` uses, so the two surfaces agree on what "Open"
  /// means. A binary / media / non-openable file keeps its prior
  /// behavior and reveals in a File Browser tab instead; the filesystem
  /// layer's `file`-kind nodes carry no text-vs-binary distinction, so
  /// the editable verdict comes from the tree entry's server kind (with
  /// a path-based fallback when the entry isn't in the current listing).
  /// Directory nodes never reach here: a directory "Open" routes through
  /// `onReveal` -> `revealPathInBrowserTab(path, true)`.
  function openFileOrReveal(path: string): void {
    const entry = tree.entries.find((e) => e.path === path);
    const kind = entry ? classifyEntry(entry) : classifyFileKind(path);
    if (isOpenableTextKind(kind)) {
      void openInActivePane(path);
    } else {
      revealPathInBrowserTab(path, false);
    }
  }

  function selectFromList(n: RenderedNode): void {
    // GraphCanvas reads `selectedId` reactively and applies the
    // selection ring + first-degree label reveal itself, so all
    // this surface has to do is mirror the id.
    selectedId = n.id;
    graphState.inspectorOpen = true;
  }

  /// Click on the scope-header row in the
  /// graph tab-menu opens the inspector for the current scope. Maps
  /// the scope kind to the matching node id in the current graph
  /// nodes list; workspace root + tag have stable ids, file/dir need a
  /// path-based lookup. No-op when the scope doesn't have a
  /// corresponding node in this view (e.g. global scope, or a file
  /// scope whose file isn't in the response).
  function openScopeHeaderInspector(): void {
    if (!currentScope) return;
    let nodeId: string | null = null;
    if (currentScope.kind === "workspace") {
      // Workspace root node carries id="" in the filesystem-merged layer.
      nodeId = "";
    } else if (currentScope.kind === "tag") {
      nodeId = currentScope.nodeId;
    } else if (currentScope.kind === "mention") {
      // Mention lens header opens the mention meta-node inspector;
      // the node id IS the scope's nodeId (`@@Name`), same as tag.
      nodeId = currentScope.nodeId;
    } else if (currentScope.kind === "file") {
      // File-kind nodes carry their path as the id when emitted
      // from the markdown layer + a synthesized id from the
      // filesystem layer. Lookup by path matches both shapes.
      const found = nodes.find(
        (n) => n.kind === "file" && n.path === currentScope.path,
      );
      if (found) nodeId = found.id;
    } else if (currentScope.kind === "dir") {
      // Directory nodes' ids carry a `directory:` prefix in the
      // merged layer; the SPA normalises `kind` to `folder` at
      // load. Match by path against folder-kind nodes.
      const found = nodes.find(
        (n) => n.kind === "folder" && n.path === currentScope.path,
      );
      if (found) nodeId = found.id;
    } else if (currentScope.kind === "contact") {
      // Contact lens header opens the
      // contact's underlying file-node inspector. Same shape as
      // the file branch above -- the seed for the contact lens IS
      // a file node located by rel_path.
      const found = nodes.find(
        (n) => n.kind === "file" && n.path === currentScope.relPath,
      );
      if (found) nodeId = found.id;
    } else if (currentScope.kind === "language") {
      // Language lens header opens the
      // language bubble inspector. Bubble node id is
      // `language:<lang>` by indexer convention.
      const found = nodes.find(
        (n) => n.kind === "language" && n.id === `language:${currentScope.language}`,
      );
      if (found) nodeId = found.id;
    }
    if (nodeId === null) return;
    selectedId = nodeId;
    graphState.inspectorOpen = true;
    closeTabMenu();
  }

  /// Click handler for link / backlink / tag-doc entries surfaced by
  /// the shared InspectorBody. The other surfaces (file browser,
  /// search) treat onNavigate as "open in the editor", but here the
  /// user is exploring the graph: route to a select-in-canvas instead
  /// so the inspector keeps following the user as they hop along
  /// references. The "Open" button (onOpen) is still
  /// the path to the editor.
  function selectByPath(path: string): void {
    const n = nodeById.get(path);
    if (n) selectFromList(n);
  }

  /// Build the dispatcher's selection from selectedNode. Returns null
  /// for ghost / missing file nodes: FileInfoBody looks up the entry
  /// in the file tree, and a missing path would render as an empty
  /// "click a file to inspect" placeholder, hiding the ghost. We
  /// render the ghost branch inline below instead.
  const inspectorSelection = $derived<InspectorSelection>(
    selectedNode === null
      ? null
      : selectedNode.kind === "file"
        ? isFileGhost
          ? null
          : { kind: "file", path: selectedNode.path }
        : selectedNode.kind === "tag" || selectedNode.kind === "mention"
          ? {
              kind: selectedNode.kind,
              nodeId: selectedNode.id,
              label: selectedNode.label,
            }
          : selectedNode.kind === "folder"
            ? {
                // Directory nodes route to
                // DirectoryInfoBody via the "directory" kind on
                // InspectorSelection. Backend emits `directory` for
                // the main /api/graph filesystem layer; GraphPanel
                // normalises that to `folder` for `RenderedNode`
                // (see `kind: "folder"` mappings at the data load
                // step). Both surfaces map to the same inspector.
                kind: "directory",
                path: selectedNode.path,
                label: selectedNode.label,
              }
            : selectedNode.kind === "language"
              ? {
                  // Language bubble inspector. Carries
                  // the canonical language id plus the file / code
                  // counts the bubble already holds so the body can
                  // render stats without a second fetch.
                  kind: "language",
                  language: selectedNode.language,
                  label: selectedNode.label,
                  files: selectedNode.files,
                  code: selectedNode.code,
                }
              : null,
  );

  // ---- presentation ------------------------------------------------------

  /// Cytoscape resolves --g-* via getComputedStyle at buildCytoscape
  /// time, so theme changes propagate next reload.
  const EDGE_COLORS: Record<RenderedEdgeKind, string> = {
    link: "var(--text-secondary)",
    tag: "var(--g-tag)",
    mention: "var(--warn-text)",
    contains: "var(--g-folder)",
    language: "var(--g-language)",
    // Group-scope edges read as the accent so they pop against the
    // document edges without looking like another link kind.
    group: "var(--accent)",
  };

  /// Per-chip dot color. Edge-kind chips reuse EDGE_COLORS; img is a
  /// node filter so it points at the image node color directly.
  const FILTER_COLORS: Record<FilterKind, string> = {
    tag: EDGE_COLORS.tag,
    mention: EDGE_COLORS.mention,
    language: EDGE_COLORS.language,
    img: "var(--g-img)",
    folder: "var(--g-folder)",
    // FileBucket chip swatch colours. Markdown
    // tracks `--g-doc` (orange); source
    // tracks `--g-source` (royalblue). Binary nodes have no chip;
    // the `--g-binary` slot still workspaces their canvas fill but the
    // user can't toggle them on/off.
    markdown: "var(--g-doc)",
    source: "var(--g-source)",
  };

  function isFsDirectory(node: FsGraphNode): boolean {
    return node.kind === "directory";
  }

  /// Mirror the server's directory node id (graph.rs::directory_node_id):
  /// a directory renders under `directory:<path>` in the semantic graph,
  /// where the bare path is the FILE node id. The fs-graph names every
  /// node by bare path, so seeding the fs spine under the semantic graph
  /// requires rewriting fs directory ids (and the dir endpoints of fs
  /// edges) to this form so a directory's fs-seeded node and its semantic
  /// node collapse onto one id. Root (path "") stays "" -- it aligns
  /// across both sources.
  function directoryNodeId(path: string): string {
    return path === "" ? "" : `directory:${path}`;
  }

  function stripDirectoryPrefix(id: string): string {
    if (id.startsWith("directory:")) return id.slice("directory:".length);
    if (id.startsWith("folder:")) return id.slice("folder:".length);
    return id;
  }

  // ---- canvas glue -------------------------------------------------------
  //
  // The graph is rendered by the GraphCanvas child component. This
  // panel owns the data fetch + the scope/depth derivations; the
  // canvas owns the d3-force simulation, painting, and pointer
  // interaction. Selection round-trips: GraphCanvas calls back into
  // `setSelected` on tap, and we re-emit `selectedId` so the
  // inspector + per-selection style updates fire as before.

  /// Files under a directory or repo-root prefix. Used by
  /// `focalIds` to seed the canvas with anchor nodes for dir /
  /// git_repo scopes.
  function filesUnder(prefix: string): string[] {
    const root = prefix.replace(/\/+$/, "");
    const withSlash = root + "/";
    return nodes
      .filter(
        (n) =>
          n.kind === "file" && (n.path === root || n.path.startsWith(withSlash)),
      )
      .map((n) => (n.kind === "file" ? n.path : ""))
      .filter((p) => p);
  }

  /// Node ids the canvas should pin at the world origin while the
  /// initial layout settles. Empty list = no anchor (workspace scope);
  /// the canvas falls back to a free force-directed layout.
  const focalIds = $derived.by<string[]>(() => {
    if (!currentScope) return [];
    if (currentScope.kind === "tag") return [currentScope.nodeId];
    // Mention lens pins the mention meta-node itself; the
    // bidirectional BFS splays its referencing files around it,
    // matching the tag lens.
    if (currentScope.kind === "mention") return [currentScope.nodeId];
    // Contact lens pins the contact's
    // file node so the canvas centres on it like a regular
    // file-scope graph would; the bidirectional BFS in
    // computeScopedNodeSet pulls in the backlinks around it.
    if (currentScope.kind === "contact") {
      const ids: string[] = [];
      for (const n of nodes) {
        if (n.kind === "file" && n.path === currentScope.relPath) ids.push(n.id);
      }
      return ids;
    }
    // Language lens pins the language
    // bubble itself; its 1-hop neighbours (every file of that
    // language) splay around it.
    if (currentScope.kind === "language") return [`language:${currentScope.language}`];
    let seedPaths: string[];
    if (currentScope.kind === "file") seedPaths = [currentScope.path];
    else if (currentScope.kind === "dir") seedPaths = filesUnder(currentScope.path);
    else return [];
    const ids: string[] = [];
    for (const n of nodes) {
      if (n.kind === "file" && seedPaths.includes(n.path)) ids.push(n.id);
    }
    return ids;
  });

  /// Fetch the graph view and stash the rendered-kind subset
  /// (files + tags + mentions). Date nodes / edges are dropped:
  /// chan-workspace's index has stopped emitting them (issue #17), but
  /// stale indexes may still contain them.
  function renderableGraphEdge(e: GraphViewEdge): RenderedEdge | null {
    if (
      e.kind === "link" ||
      e.kind === "tag" ||
      e.kind === "mention" ||
      e.kind === "contains" ||
      e.kind === "language"
    ) {
      return e as RenderedEdge;
    }
    return null;
  }

  function graphEdgeKey(e: GraphViewEdge): string {
    return `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.rank ?? ""}`;
  }

  /// Resolve a `pendingSelectId` (set by "Graph from here") to the real
  /// rendered node id. The select is a workspace PATH: for a file that
  /// path IS the node id, but a directory node's id is `directory:<path>`
  /// (graph.rs::directory_node_id), so a bare-path pending never matched
  /// and the originating directory was left unselected after the re-scope
  /// (the graph redrew but did not select the node). Match by id first,
  /// then fall back to a file/folder node whose `.path` equals the pend.
  function resolveSelectId(
    pending: string,
    byId: Map<string, RenderedNode>,
  ): string | null {
    if (byId.has(pending)) return pending;
    for (const n of byId.values()) {
      if ((n.kind === "file" || n.kind === "folder") && n.path === pending) {
        return n.id;
      }
    }
    return null;
  }

  async function load(): Promise<void> {
    const seq = ++graphLoadSeq;
    graphLoadAbort?.abort();
    const controller = new AbortController();
    graphLoadAbort = controller;
    loading = true;
    error = null;
    try {
      if (filesystemMode && currentScope) {
        languageMaxDepth = 0;
        const fsScope =
          currentScope.kind === "file" ? "file" : "directory";
        const fsPath =
          currentScope.kind === "dir" || currentScope.kind === "file"
            ? currentScope.path
            : "";
        // Cursor-paged delivery: reset the spine, then pull bounded
        // batches and append each so a large scope (e.g. /tmp/linux) fills
        // in gradually instead of arriving as one blocking payload, with a
        // frame yield between batches to keep every surface interactive.
        fsNodes = [];
        fsEdgesRaw = [];
        nodes = [];
        edges = [];
        let cursor: string | undefined;
        let fs: FsGraphResponse;
        do {
          fs = await api.fsGraph({
            scope: fsScope,
            path: fsPath,
            depth: graphState.depth,
            limit: GRAPH_BATCH_NODES,
            cursor,
          });
          if (seq !== graphLoadSeq) return;
          fsTruncated = fs.truncated;
          mergeFsResponse(fs);
          cursor = fs.cursor ?? undefined;
          if (!fs.done && cursor) {
            await yieldToFrame();
            if (seq !== graphLoadSeq) return;
          }
        } while (!fs.done && cursor);
        if (currentScope.kind !== "file") {
          // The expanded set is restored with the tab (or defaults to the
          // root for a fresh depth-1 graph), so the first load trusts it.
          // A later depth-slider move or rescope re-establishes the set
          // from the selected directory to depth N (authoritative;
          // overrides individual expand/collapse).
          const scopeKey = graphState.scopeId;
          if (appliedDepth === null) {
            appliedDepth = graphState.depth;
            appliedScopeKey = scopeKey;
          } else if (
            graphState.depth !== appliedDepth ||
            scopeKey !== appliedScopeKey
          ) {
            seedExpandedFromSelected(graphState.depth);
            appliedDepth = graphState.depth;
            appliedScopeKey = scopeKey;
          }
        }
        const pending = graphState.pendingSelectId;
        // Match the pending select by node id OR path: "Graph from here"
        // sets a workspace path, which equals the fs node id for files /
        // dirs today, but matching path too keeps the select robust and
        // mirrors the semantic branch's resolveSelectId.
        const pendingNode = pending
          ? fsNodes.find((n) => n.id === pending || n.path === pending)
          : undefined;
        if (pendingNode) {
          selectedId = pendingNode.id;
          graphState.inspectorOpen = true;
        } else if (!selectedId || !fsNodes.some((n) => n.id === selectedId)) {
          selectedId = fs.path;
        }
        graphState.pendingSelectId = null;
        void reconcileExpandedChildren();
        return;
      }
      fsNodes = [];
      fsTruncated = false;
      if (languageMode) {
        const g: LanguageGraphResponse = await api.languageGraph({
          depth: graphState.depth,
        });
        if (seq !== graphLoadSeq) return;
        languageMaxDepth = g.max_depth;
        nodes = mapLanguageNodes(g.nodes);
        edges = mapLanguageEdges(g.edges);
        selectedId = selectedId && g.nodes.some((n) => n.id === selectedId)
          ? selectedId
          : null;
        graphState.pendingSelectId = null;
        return;
      }
      languageMaxDepth = 0;
      const graphScope =
        currentScope?.kind === "file"
          ? { scope: "file" as const, path: currentScope.path }
          : currentScope?.kind === "dir"
            ? { scope: "directory" as const, path: currentScope.path }
            : { scope: "workspace" as const, path: "" };
      const renderedNodesById = new Map<string, RenderedNode>();
      const renderedEdgesByKey = new Map<string, RenderedEdge>();
      // The seeded fs spine lives in `renderedNodesById` / `nodes`, NOT
      // `fsNodes`: the semantic-mode inspector reads `selectedNode` /
      // `nodeById`, and `selectedFsNode` is gated on `filesystemMode`, so
      // leaving `fsNodes` empty in semantic mode keeps the inspector
      // correct (no fs-row fallback) while the spine still renders.
      fsNodes = [];
      fsTruncated = false;
      // Do NOT blank `nodes` / `edges` to `[]` here: the fs spine is
      // seeded into the maps and published below, so an index-settle
      // RE-load keeps the existing graph on screen instead of flashing
      // empty across the await. A one-frame empty on the very first load
      // (before the spine arrives) is fine.
      const publish = (): void => {
        if (seq !== graphLoadSeq) return;
        nodes = [...renderedNodesById.values()];
        edges = [...renderedEdgesByKey.values()];
        const pending = graphState.pendingSelectId;
        if (pending !== null) {
          const resolved = resolveSelectId(pending, renderedNodesById);
          if (resolved !== null) {
            selectedId = resolved;
            graphState.inspectorOpen = true;
            graphState.pendingSelectId = null;
          }
        }
      };
      // Seed the always-available filesystem `contains` spine FIRST so the
      // directory / file skeleton renders immediately, even before the
      // index has settled. The semantic stream then merges its richer
      // nodes (link / tag / mention / language) ON TOP of the same maps:
      // a file (bare-path id) or a directory (normalized to
      // `directory:<path>`) collides on id and the semantic node replaces
      // the fs-seeded one; everything else layers on. Only the
      // tree-bearing scopes seed a spine; the tag / mention / contact /
      // language lenses have no directory tree (and no fsGraph scope), so
      // they fall straight through to the stream as before.
      if (
        currentScope &&
        (currentScope.kind === "file" ||
          currentScope.kind === "dir" ||
          currentScope.kind === "workspace")
      ) {
        const fsScope =
          currentScope.kind === "file" ? "file" : "directory";
        const fsPath =
          currentScope.kind === "file" || currentScope.kind === "dir"
            ? currentScope.path
            : "";
        let cursor: string | undefined;
        let fs: FsGraphResponse | undefined;
        do {
          fs = await api.fsGraph({
            scope: fsScope,
            path: fsPath,
            depth: Math.max(graphState.depth, 1),
            limit: GRAPH_BATCH_NODES,
            cursor,
          });
          if (seq !== graphLoadSeq) return;
          // Directory ids that need the `directory:` prefix so the fs
          // spine collapses onto the semantic graph. File / ghost /
          // symlink-leaf endpoints keep their bare path.
          const fsDirIds = new Set<string>();
          for (const n of fs.nodes) {
            if (isFsDirectory(n)) fsDirIds.add(n.id);
          }
          const normalizeId = (id: string): string =>
            fsDirIds.has(id) ? directoryNodeId(id) : id;
          for (const mapped of mapFsNodes(fs)) {
            const id = normalizeId(mapped.id);
            renderedNodesById.set(id, { ...mapped, id });
          }
          for (const mapped of mapFsEdges(fs)) {
            const source = normalizeId(mapped.source);
            const target = normalizeId(mapped.target);
            const edge = { ...mapped, source, target };
            renderedEdgesByKey.set(graphEdgeKey(edge), edge);
          }
          publish();
          cursor = fs.cursor ?? undefined;
          if (!fs.done && cursor) {
            await yieldToFrame();
            if (seq !== graphLoadSeq) return;
          }
        } while (!fs.done && cursor);
      }
      await api.graphStream(
        {
          ...graphScope,
          depth: Math.max(graphState.depth, 1),
        },
        {
          signal: controller.signal,
          onNodes(batch) {
            for (const n of batch) {
              const mapped = mapGraphNode(n);
              if (mapped) renderedNodesById.set(mapped.id, mapped);
            }
            publish();
          },
          onEdges(batch) {
            for (const e of batch) {
              const mapped = renderableGraphEdge(e);
              if (mapped) renderedEdgesByKey.set(graphEdgeKey(e), mapped);
            }
            publish();
          },
        },
      );
      if (seq !== graphLoadSeq) return;
      publish();
      // Honour any selection openGraphAtNode pre-loaded into the
      // overlay state so the inspector opens on the right node.
      const pending = graphState.pendingSelectId;
      if (pending !== null && renderedNodesById.has(pending)) {
        selectedId = pending;
        graphState.inspectorOpen = true;
      } else if (pending !== null) {
        graphState.pendingSelectId = null;
      }
      // Re-seed the semantic-mode expanded set after the full
      // spine lands. The first load (or a window-restore) trusts the
      // serialized `expanded` set; a later depth-slider move or rescope
      // re-establishes it from the selected directory to depth N
      // (authoritative; overrides manual expand/collapse). Mirrors the
      // filesystem-mode reseed above. Workspace + dir scope only; the
      // tag / contact / language / file lenses don't use the expanded
      // set (their visible set is BFS-derived).
      if (
        currentScope &&
        (currentScope.kind === "workspace" || currentScope.kind === "dir")
      ) {
        const scopeKey = graphState.scopeId;
        if (appliedDepth === null) {
          appliedDepth = graphState.depth;
          appliedScopeKey = scopeKey;
        } else if (
          graphState.depth !== appliedDepth ||
          scopeKey !== appliedScopeKey
        ) {
          seedExpandedFromSelected(graphState.depth);
          appliedDepth = graphState.depth;
          appliedScopeKey = scopeKey;
        }
      }
    } catch (e) {
      if (seq === graphLoadSeq && (e as DOMException).name !== "AbortError") {
        if (isWorkspaceRootMissingError(e)) {
          // Do not leave the persisted/indexed graph dimly visible behind the
          // error after the source root is gone. The dirty editor owns its
          // buffer; a graph owns no unsaved state and converges to unavailable.
          fsNodes = [];
          fsEdgesRaw = [];
          nodes = [];
          edges = [];
          selectedId = null;
        }
        error = (e as Error).message;
      }
    } finally {
      if (seq === graphLoadSeq) {
        loading = false;
        graphLoadAbort = null;
      }
    }
  }

  function mapLanguageNodes(input: LanguageGraphResponse["nodes"]): RenderedNode[] {
    return input.map((n): RenderedNode => {
      if (n.kind === "directory") {
        return { ...n, kind: "folder" };
      }
      return n;
    });
  }

  function mapLanguageEdges(input: LanguageGraphResponse["edges"]): RenderedEdge[] {
    return input.map((e) => ({
      source: e.source,
      target: stripDirectoryPrefix(e.target),
      kind: "language",
    }));
  }

  function mapFsNodes(fs: FsGraphResponse): RenderedNode[] {
    return fs.nodes.map((n): RenderedNode => {
      // A symlink is a file-like leaf: render it as a file node so the
      // canvas classifies it by name (binary for an extension-less link,
      // doc for a `.md` link, etc.). Without this branch a "symlink" kind
      // fell through to the `mention` catch-all below and drew as a yellow
      // contact silhouette. The symlink relationship
      // still reads via its distinct edge (mapFsEdges maps "symlink" ->
      // a tag-kind edge); the inspector keeps the BINARY + target body
      // off the raw `selectedFsNode`, which is unaffected by this mapping.
      if (n.kind === "file" || n.kind === "symlink") {
        return {
          kind: "file",
          id: n.id,
          label: n.name || n.path || "(workspace)",
          path: n.path,
          missing: Boolean(n.broken),
        };
      }
      if (n.kind === "ghost") {
        return {
          kind: "file",
          id: n.id,
          label: n.name || n.target || n.id,
          path: n.path || n.id,
          missing: true,
        };
      }
      if (isFsDirectory(n)) {
        return {
          kind: "folder",
          id: n.id,
          label: `${n.name || "workspace"}/`,
          path: n.path,
          files: 0,
          code: 0,
        };
      }
      return {
        kind: "mention",
        id: n.id,
        label: `${n.name}${n.broken ? " (broken)" : ""}`,
      };
    });
  }

  function mapFsEdges(fs: FsGraphResponse): RenderedEdge[] {
    return fs.edges.map((e): RenderedEdge => ({
      source: e.source,
      target: e.target,
      kind:
        e.kind === "contains"
          ? "contains"
          : e.kind === "symlink"
            ? "tag"
            : "mention",
      broken:
        e.kind === "symlink" &&
        Boolean(fs.nodes.find((n) => n.id === e.target)?.broken),
    }));
  }

  function mapGraphNode(n: GraphViewNode): RenderedNode | null {
    if (n.kind === "file" || n.kind === "tag" || n.kind === "mention" || n.kind === "language") {
      return n as RenderedNode;
    }
    if (n.kind === "media") {
      return {
        kind: "file",
        id: n.id,
        label: n.label,
        path: n.path,
        missing: n.missing,
      };
    }
    if (n.kind === "directory") {
      return {
        kind: "folder",
        id: n.id,
        label: `${n.label || "workspace"}/`,
        path: n.path,
        files: n.files,
        code: n.code,
      };
    }
    return null;
  }

  /// The stable identity of "what graph to show": the scope id, the
  /// depth, and the mode. A reload is warranted only when ONE OF THESE
  /// changes. We track THIS key in the reload effect rather than letting
  /// the effect track `load()`'s internal reads, because `load()` reads
  /// the `currentScope` $derived, whose object identity is recomputed by
  /// `availableGraphScopes()` whenever the WORKSPACE LAYOUT changes (a
  /// new editor tab, a File Browser reveal). Tracking the object would
  /// make the inspector's "Open" / "Show File" actions reload the
  /// graph: they open a tab / reveal in the browser, the layout shifts,
  /// `currentScope` recomputes to an equal-but-new object, and the effect
  /// re-fired. The logical scope did NOT change, so anchoring on this
  /// value key keeps those actions from triggering a spurious reload.
  const loadKey = $derived(
    `${graphState.scopeId}|${graphState.depth}|${graphState.mode}`,
  );

  /// Keep-alive load gating. A graph tab is now kept mounted while
  /// hidden, so this effect can no longer treat "visible" as "just
  /// (re)mounted" -- it must decide per activation whether a fetch is
  /// actually warranted:
  ///   - HIDDEN: never fetch (the whole point -- no background load).
  ///     If the load key changed while hidden, mark dirty so the next
  ///     activation refetches once. (A hidden in-scope watcher edit
  ///     also sets graphDirty, in the watcher effect below.)
  ///   - VISIBLE: fetch only on the first activation (lazy, not mount),
  ///     on a real scope/depth/mode change, or when dirty. Then latch
  ///     hasLoadedOnce, record the key, and clear dirty.
  /// `load()` still runs untracked so its internal reads (the
  /// layout-churny `currentScope` object, filters, etc.) don't register
  /// as reload triggers; only `visible` + `loadKey` do.
  $effect(() => {
    // Read both triggers up front so the effect tracks exactly them.
    const show = visible;
    const key = loadKey;
    if (!show) {
      // Hidden: defer. A key change becomes a one-shot reload on the
      // next activation rather than a background fetch.
      if (hasLoadedOnce && key !== lastLoadedKey) graphDirty = true;
      return;
    }
    const keyChanged = key !== lastLoadedKey;
    if (!hasLoadedOnce || keyChanged || graphDirty) {
      hasLoadedOnce = true;
      lastLoadedKey = key;
      graphDirty = false;
      untrack(() => void load());
    }
  });

  $effect(() => {
    if (!visible) workspaceDepthProbe = null;
  });

  $effect(() => {
    if (!visible) return;
    if (currentScope?.kind !== "workspace") return;
    if (workspaceDepthProbe || workspaceDepthProbeLoading) return;
    void loadWorkspaceDepthProbe();
  });

  /// Keep the directory depth probe in sync with the dir scope.
  /// Reset when the panel hides or the scope is not a directory; (re)run
  /// it whenever the scope path changes so the slider cap tracks the new
  /// directory's reachable depth.
  $effect(() => {
    if (!visible || currentScope?.kind !== "dir") {
      dirDepthProbe = null;
      dirDepthProbePath = null;
      return;
    }
    const path = currentScope.path;
    if (dirDepthProbeLoading) return;
    if (dirDepthProbePath === path && dirDepthProbe) return;
    untrack(() => void loadDirDepthProbe(path));
  });

  $effect(() => {
    if (languageMode) return;
    const max = depthCap;
    if (graphState.depth < 1) {
      graphState.depth = 1;
    } else if (graphState.depth > max) {
      graphState.depth = max;
    }
  });

  /// Does a watcher event touching `paths` warrant reloading THIS graph?
  /// Pre-fix the graph reloaded on every workspace edit, even files not
  /// in the open graph (any change to any file in the workspace
  /// triggered a graph reload). We reload only when the
  /// change is in scope:
  ///   - workspace scope spans the whole tree -> always.
  ///   - dir / file scope -> a path inside the subtree (covers a NEW
  ///     file not yet a node) or a path currently rendered as a node.
  ///   - tag / contact / language lens -> only when the changed path is a
  ///     file currently VISIBLE in the lens (its edges may have changed).
  /// Unknown paths (empty) reload to stay safe.
  function changeAffectsScope(paths: string[]): boolean {
    if (paths.length === 0) return true;
    const scope = currentScope;
    if (!scope) return true;
    if (scope.kind === "workspace") return true;
    const visibleIds = scopedNodeIds;
    for (const p of paths) {
      if (
        scope.kind === "dir" &&
        (p === scope.path || p.startsWith(`${scope.path}/`))
      ) {
        return true;
      }
      if (scope.kind === "file" && p === scope.path) return true;
      for (const n of nodes) {
        if (
          (n.kind === "file" || n.kind === "folder") &&
          n.path === p &&
          (visibleIds === null || visibleIds.has(n.id))
        ) {
          return true;
        }
      }
    }
    return false;
  }

  $effect(() => {
    const nonce = graphReloadSignal.nonce;
    if (nonce === seenGraphReloadNonce) return;
    seenGraphReloadNonce = nonce;
    // Path-filter FIRST: an out-of-scope edit is ignored on every graph,
    // visible or hidden (it changes nothing this scope renders). `untrack`
    // so reading the scope / node sets here doesn't make the effect
    // re-fire on load.
    if (!untrack(() => changeAffectsScope(graphReloadSignal.paths))) return;
    if (!visible) {
      // Hidden + in-scope edit: don't reload in the background (the
      // keep-alive win). Remember it so the next activation refetches
      // once. The visible graph still live-reloads, per @@Alex.
      graphDirty = true;
      return;
    }
    // Visible + in-scope: debounce-reload as before. Sync lastLoadedKey
    // so the load effect doesn't treat this fresh data as stale on the
    // next re-fire, and clear dirty since we're refetching now.
    if (watchReloadTimer) clearTimeout(watchReloadTimer);
    watchReloadTimer = setTimeout(() => {
      watchReloadTimer = null;
      if (visible) {
        if (currentScope?.kind === "workspace") {
          workspaceDepthProbe = null;
          void loadWorkspaceDepthProbe();
        }
        lastLoadedKey = loadKey;
        graphDirty = false;
        void load();
      }
    }, 250);
  });

  /// Layer the index-derived graph in once indexing finishes. The load
  /// effect above tracks only `visible` + `loadKey`, and the watcher path
  /// only fires on real file edits -- neither covers the initial index of
  /// PRE-EXISTING files. A semantic-mode graph opened mid-index shows the
  /// always-available fs spine immediately (seeded in `load()`), so `nodes`
  /// is non-empty, but the link / tag / mention / language edges only
  /// arrive once the index settles. Fire `reloadGraph()` on the
  /// `indexBuilding` true→false edge so those layer on. Guards: edge-only
  /// via `prevIndexBuilding` (no reload loop); `visible`-only (don't wake a
  /// backgrounded tab); semantic-mode only (filesystem mode is structural,
  /// language mode is its own surface). NOT gated on `nodes.length === 0`:
  /// the fs spine keeps `nodes` populated, so the old empty-only guard
  /// would never fire the re-layer. Distinct trigger from the
  /// graphReloadSignal watcher (a save's reindex), so no double-load.
  /// `visible` / mode are read untracked so only `indexBuilding` re-fires
  /// this effect.
  let prevIndexBuilding = false;
  $effect(() => {
    const building = indexBuilding;
    const wasBuilding = prevIndexBuilding;
    prevIndexBuilding = building;
    if (!wasBuilding || building) return; // not a true -> false edge
    untrack(() => {
      if (visible && !filesystemMode && !languageMode) void reloadGraph();
    });
  });

  /// Persist the live selection so it survives a window reload (the
  /// selected node used to be lost on reload). The serializer already writes
  /// `gn`/`gnl` from graphState.selectedNodeId/Label, and restore reads
  /// them back into selectedNodeId + pendingSelectId - the missing link
  /// was the TRIGGER: App.svelte's layout-persist effect tracks the graph
  /// tab's scope/depth/filters/inspector but NOT its selection, so a pure
  /// select change never reached the hash. Mirror selectedId (the live,
  /// component-local source of truth, written by clicks AND the
  /// programmatic re-scope / load-resolution paths) into the tab fields
  /// and kick both persists (each debounces internally).
  let lastSyncedSelect: string | null = null;
  $effect(() => {
    const id = selectedId;
    // A restore (gn -> pendingSelectId) or re-scope resolves through
    // load(); skip until it settles so we neither clobber the restored
    // selection with the initial null nor persist a transient mid-resolve
    // value. setSelected clears pendingSelectId, so user clicks pass.
    if (graphState.pendingSelectId !== null) return;
    if (id === lastSyncedSelect) return;
    lastSyncedSelect = id;
    graphState.selectedNodeId = id;
    graphState.selectedNodeLabel = id === null ? null : graphSelectionLabel(id);
    schedulePersistStateToHash();
    scheduleSessionSave();
  });

  onDestroy(() => {
    if (watchReloadTimer) clearTimeout(watchReloadTimer);
    graphLoadAbort?.abort();
  });

  /// Selection callback handed to GraphCanvas. Tapping a node
  /// flips the inspector open; background tap clears.
  function setSelected(id: string | null): void {
    selectedId = id;
    // A user tap is a definitive selection: drop any unresolved
    // pending auto-select (restore / re-scope) so the persist effect
    // below is free to capture this click.
    graphState.pendingSelectId = null;
    if (id !== null) graphState.inspectorOpen = true;
    // Surface the selection to the tab so the
    // tab strip can derive the title from the selected node's
    // label. We cache the label too so the title renders before
    // the graph data finishes reloading (e.g. after a hard
    // reload that round-trips the selection via URL hash).
    if (tab) {
      tab.selectedNodeId = id;
      tab.selectedNodeLabel = id === null ? null : graphSelectionLabel(id);
    }
  }

  function graphSelectionLabel(id: string): string | null {
    // FsGraphNode carries `name` directly -- workspace root has
    // name="" (empty path), so fall through to the semantic node
    // lookup before declaring no label.
    const fs = fsNodeById.get(id);
    if (fs && fs.name) return fs.name;
    const node = nodeById.get(id);
    if (node) return node.label ?? null;
    return null;
  }
</script>

<svelte:window onkeydown={onTabMenuKeydown} onpointerdown={onTabMenuPointerDown} />

<!-- The graph is always a first-class TAB (mounted only by Pane.svelte
     with a `tab`); there is no overlay variant - OverlayShell lives only
     in Search + Settings. `graphState` is the tab, `visible` is constant,
     and GraphPanel does not read the store's graphOverlay/browserOverlay
     state. -->
{@render graphContent()}

{#snippet graphContent()}
  <div
    class="graph-tab"
    class:active
    data-theme={tab ? surfaceThemeOverride("graph") : undefined}
    oncontextmenu={onGraphContextMenu}
    role="tabpanel"
    aria-hidden={!active}
  >
  {#if tab && tabMenuOpen}
    <!-- Graph-tab right-click bubble. Anchored to
         the tab-strip click position via clampMenu.
         Row shape follows the standard
         hamburger-menu pattern from other tabs (TerminalTab /
         FileEditorTab / FileBrowserSurface) -- `<button class="mbtn">`
         rows with optional icon + label + chord on the right; filters
         render vertically, one row per kind, with the kind colour as
         a dot + on/off cue via the `.on` class. -->
    <!-- The workspace path-scope does not pin the depth slider
         in the disabled state: workspace scope has a valid
         `depthCap` derived from `workspaceDepthProbe`, so the
         slider behaves like the dir scope's depth control.
         Language mode keeps its own pinned-to-1 behaviour via
         the early-return in the clamp `$effect` + depthCap. The
         `!currentScope` check guards the brief boot window where
         the scope hasn't resolved yet. -->
    {@const depthDisabled = !languageMode && !currentScope}
    <div
      class="tab-menu-bubble"
      role="menu"
      tabindex="-1"
      aria-label="graph tab menu"
      use:portal
      use:clampMenu={tabMenuPos}
      onmousedown={(e) => e.stopPropagation()}
    >
      <!-- Header row showing the
           current scope path + a kind-appropriate icon. Mirrors
           the path-row pattern of the
           Terminal / File Browser / Editor right-click
           menus. Click on the row routes through the existing
           inspector-open path so the user can hop from the menu
           to the scope's inspector view. -->
      {#if currentScope}
        {@const scopePath =
          currentScope.kind === "workspace" ? ""
          : currentScope.kind === "file" ? currentScope.path
          : currentScope.kind === "dir" ? currentScope.path
          : currentScope.kind === "tag" ? `#${currentScope.label}`
          : currentScope.kind === "mention" ? `@@${currentScope.label}`
          : currentScope.kind === "contact" ? `@@${currentScope.label}`
          : currentScope.kind === "language" ? currentScope.label
          : ""}
        {@const scopeKindLabel =
          currentScope.kind === "workspace" ? "Workspace"
          : currentScope.kind === "tag" ? "Hashtag"
          : currentScope.kind === "mention" ? "Mention"
          : currentScope.kind === "file" ? "File"
          : currentScope.kind === "dir" ? "Directory"
          : currentScope.kind === "contact" ? "Contact"
          : currentScope.kind === "language" ? "Language"
          : "Scope"}
        <button
          type="button"
          class="mbtn graph-scope-row"
          role="menuitem"
          tabindex="-1"
          title={scopePath || scopeKindLabel}
          onclick={openScopeHeaderInspector}
        >
          <span class="mbtn-icon" aria-hidden="true">
            {#if currentScope.kind === "workspace"}
              <HardDrive size={16} strokeWidth={1.75} />
            {:else if currentScope.kind === "dir"}
              <Folder size={16} strokeWidth={1.75} />
            {:else if currentScope.kind === "tag"}
              <Hash size={16} strokeWidth={1.75} />
            {:else if currentScope.kind === "mention"}
              <AtSign size={16} strokeWidth={1.75} />
            {:else if currentScope.kind === "contact"}
              <AtSign size={16} strokeWidth={1.75} />
            {:else if currentScope.kind === "language"}
              <Code2 size={16} strokeWidth={1.75} />
            {:else}
              <FileText size={16} strokeWidth={1.75} />
            {/if}
          </span>
          <span class="mbtn-label graph-scope-path">
            {scopePath || scopeKindLabel}
          </span>
        </button>
        <div class="msep" role="separator"></div>
      {/if}
      <div
        class="mbtn depth-row"
        class:disabled={depthDisabled}
        class:shallow={depthShallow}
        title={depthShallow
          ? "Scope is shallow: depth 1 already reveals everything forward-reachable"
          : null}
      >
        <span class="mbtn-icon" aria-hidden="true"></span>
        <span class="mbtn-label">Depth</span>
        <input
          type="range"
          min={languageMode ? "0" : "1"}
          max={depthCap}
          step="1"
          bind:value={graphState.depth}
          disabled={depthDisabled || depthShallow}
          onmousedown={(e) => e.stopPropagation()}
          aria-label="depth"
        />
        <span class="depth-value">
          {#if languageMode && graphState.depth === 0}
            max
          {:else if depthShallow}
            {graphState.depth} <span class="depth-cue">[max]</span>
          {:else}
            {graphState.depth}
          {/if}
        </span>
      </div>
      <div class="msep graph-filter-sep" role="separator"></div>
      {#each ["tag", "mention", "language", "img", "folder", "markdown", "source"] as const as kind (kind)}
        {@const workspaceLike =
          currentScope?.kind === "workspace"}
        <!-- The backend emits per-file language edges through
             `scoped_report_files`, so dir-scoped graphs have
             language data too. Show the language chip whenever
             the layout is the semantic graph (not the filesystem
             / language modes), regardless of path scope. -->
        {#if (!filesystemMode || (kind !== "img" && kind !== "language")) && (languageMode ? kind === "language" : true) && (kind !== "folder" || filesystemMode || workspaceLike)}
          <button
            type="button"
            class="mbtn filter-row"
            class:on={show[kind]}
            onclick={() => (show[kind] = !show[kind])}
            role="menuitemcheckbox"
            aria-checked={show[kind]}
          >
            <span
              class="filter-dot"
              class:filter-dot-off={!show[kind]}
              style="background:{show[kind] ? FILTER_COLORS[kind] : 'transparent'};border-color:{FILTER_COLORS[kind]}"
              aria-hidden="true"
            ></span>
            <span class="mbtn-label">
              {#if filesystemMode}
                {kind === "tag"
                  ? "symlink"
                  : kind === "mention"
                    ? "hardlink"
                    : "directory"}
              {:else}
                {kind === "mention" ? "contact" : kind === "img" ? "media" : kind}
              {/if}
            </span>
            <span class="filter-count">{counts[kind]}</span>
          </button>
        {/if}
      {/each}
      <div class="msep" role="separator"></div>
      <button class="mbtn" onclick={closeFromMenu}>
        <span class="mbtn-icon">
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span class="mbtn-label">Close</span>
        <span class="mbtn-chord">{chordFor("app.tab.close") ?? ""}</span>
      </button>
    </div>
  {/if}

  <div class="body">
  <div class="canvas">
    {#if loading && nodes.length === 0}
      <div class="placeholder">loading graph…</div>
    {:else if error}
      <div class="placeholder error">{error}</div>
    {:else if !loading && nodes.length === 0}
      <div class="placeholder">
        {emptyStateMessage}
      </div>
    {/if}
    {#if loading && nodes.length > 0}
      <div class="stream-status">loading graph… {nodes.length} nodes, {edges.length} edges</div>
    {/if}
    <div class="cy" class:dim={!!error}>
      <GraphCanvas
        open={canvasEverShown}
        paused={!active}
        {nodes}
        {edges}
        {visibleNodeIds}
        {visibleEdges}
        {focalIds}
        {selectedId}
        {expansionFitRequest}
        onSelect={setSelected}
        onContextMenu={onGraphContextMenu}
        onSetAsScope={onGraphDoubleClick}
      />
    </div>
  </div>

  {#if graphState.inspectorOpen}
    <Inspector
      title="Details"
      bind:width={
        () => graphState.inspectorWidth ?? paneWidths.graph,
        (v) => (graphState.inspectorWidth = v)
      }
      onResize={persistPaneWidths}
      onClose={() => (graphState.inspectorOpen = false)}
    >
      {#if scopeAncestors.length > 0}
        <!-- Ancestor breadcrumb. Default render mode is "from
             here", so navigating back up the path is the load-
             bearing affordance; the breadcrumb provides it for
             every path-based scope (workspace / dir: / file:). Click
             a prior segment to re-scope in place. -->
        <nav class="scope-crumbs" aria-label="graph scope ancestors">
          {#each scopeAncestors as crumb, i (i + ":" + crumb.scopeId)}
            {#if i > 0}
              <span class="crumb-sep" aria-hidden="true">/</span>
            {/if}
            {#if crumb.current}
              <span class="crumb current" aria-current="true">{crumb.label}</span>
            {:else}
              <button
                type="button"
                class="crumb"
                onclick={() => rescopeFromHere(crumb.scopeId)}
              >{crumb.label}</button>
            {/if}
          {/each}
        </nav>
      {/if}
      {#if (selectedFsNode && isFsDirectory(selectedFsNode) && selectedFsNode.id === "") || (selectedNode?.kind === "folder" && selectedNode.id === "")}
        <!-- Workspace root: same body the file browser hamburger
             menu's Directory row pops (WorkspaceInfoBody) so the
             whole-workspace config lives in one place across surfaces.
             Differentiated visually by GraphCanvas painting the
             "workspace" sub-kind in a darker fill with the HardDrive
             glyph.
             The workspace root is a regular directory inspector
             with both directory actions wired:
             "Show in File Browser" (revealPathInBrowserTab) and
             "Graph from here" (graphFromHere re-scopes the current
             tab to workspace root). variant defaults to inspector. -->
        <WorkspaceInfoBody
          onReveal={() => revealPathInBrowserTab("", true)}
          onSetAsScope={() => graphFromHere("", true)}
          onLanguageClick={openGraphForLanguage}
          onContactNavigate={openGraphForContact}
        />
      {:else if selectedFsNode && (isFsDirectory(selectedFsNode) || selectedFsNode.kind === "file") && selectedFsNode.path !== undefined && !selectedFsNode.broken}
        <!-- Real fs-mode file or directory: render the same body as the
             file browser / editor inspector (counts, size, code
             report; tags / refs / backlinks for files) by routing
             through InspectorBody. FileInfoBody dispatches on
             entry.is_dir so the "file" selection variant covers both
             shapes. Per the nav contract a file "Open" (onOpen ->
             openFileOrReveal) opens the editor pane, matching the File
             Browser; a directory "Open" routes through FileInfoBody's
             openDirInBrowser → onReveal into a new File Browser tab;
             "Graph from here" (`onSetAsScope` → `graphFromHere`) spawns
             a new graph tab. The breadcrumb above handles upward
             navigation. -->
        {@const fsPath = selectedFsNode.path}
        {@const fsKind = selectedFsNode.kind}
        {@const fsIsDir = isFsDirectory(selectedFsNode)}
        <InspectorBody
          selection={{ kind: "file", path: fsPath }}
          showRefs
          onOpen={fsKind === "file" ? () => openFileOrReveal(fsPath) : undefined}
          onReveal={fsIsDir ? () => revealPathInBrowserTab(fsPath, true) : undefined}
          onNavigate={(p) => {
            const peer = fsNodes.find((n) => n.path === p);
            if (peer) {
              selectedId = peer.id;
              graphState.inspectorOpen = true;
            }
          }}
          onSetAsScope={() => graphFromHere(fsPath, fsIsDir)}
        />
      {:else if selectedFsNode}
        <div class="ghost-body">
          <header class="head">
            <KindChip
              kind={isFsDirectory(selectedFsNode) ? "folder" : selectedFsNode.kind === "file" ? "document" : "binary"}
              path={selectedFsNode.path}
              block
              ghost={selectedFsNode.kind === "ghost" || selectedFsNode.broken === true}
            />
          </header>
          <h3 class="title" title={selectedFsNode.path || selectedFsNode.target || selectedFsNode.id}>
            {selectedFsNode.name || selectedFsNode.path || selectedFsNode.id || "(workspace)"}
          </h3>
          <div class="path mono">{selectedFsNode.path || selectedFsNode.target || selectedFsNode.id}</div>
          {#if selectedFsNode.target}
            <div class="missing">target: {selectedFsNode.target}</div>
          {/if}
          {#if selectedFsNode.outside}
            <div class="missing">target is outside this workspace</div>
          {:else if selectedFsNode.broken}
            <div class="missing">missing or unreadable target</div>
          {/if}
          {#if selectedFsNode.kind === "file" && selectedFsNode.path}
            <button class="open-fs" onclick={() => { void openInActivePane(selectedFsNode!.path); }}>
              Open
            </button>
          {/if}
        </div>
      {:else if selectedNode && selectedNode.kind === "file" && isFileGhost}
        <!-- Ghost: either an explicit broken-link target, or the
             graph claims the file exists but it's not in the current
             tree listing (stale search index, common after a bulk
             workspace change). FileInfoBody can't render either; surface
             inline inside the shared Inspector header. -->
        {@const ghostKind = classifyFileKind(
          selectedNode.path,
          selectedNode.node_kind,
        ) as FileKind}
        {@const hint = selectedNode.missing
          ? "file does not exist (broken-link target)"
          : ghostIndexerHint ?? "not in the current file listing (try Reload / chan index)"}
        <div class="ghost-body">
          <header class="head">
            <KindChip kind={ghostKind} path={selectedNode.path} block ghost />
          </header>
          <h3 class="title" title={selectedNode.path}>{selectedNode.label}</h3>
          <div class="path mono">{selectedNode.path}</div>
          <div class="missing">{hint}</div>
        </div>
      {:else}
        <!-- `onSetAsScope` wires "Graph from here" to always open a NEW
             graph tab, per selection kind: file / directory via
             `graphFromHere`; language / tag via `openGraphForLanguage` /
             `openGraphForTag`; a mention via `openGraphForContact` when it
             resolves to a contact file, else `openGraphForMention` on the
             mention meta-node. The breadcrumb (`rescopeFromHere`) owns
             in-place upward navigation. -->
        <InspectorBody
          selection={inspectorSelection}
          onOpen={
            inspectorSelection?.kind === "file"
              ? () => openFileOrReveal(inspectorSelection.path)
              : inspectorSelection?.kind === "mention" && selectedContactPath
                ? () => {
                    // Mention/contact "Open": route the resolved contact
                    // file (looked up via tree.kind === "contact") to the
                    // editor pane, matching the file nav contract and the
                    // File Browser's open-selection.
                    openFileOrReveal(selectedContactPath!);
                  }
                : undefined
          }
          onReveal={
            inspectorSelection?.kind === "directory"
              ? // Directory "Open": FileInfoBody routes a directory's
                // "Open" button through openDirInBrowser → onReveal, so a
                // dir reveals into a new File Browser tab here (the file
                // case uses onOpen above). Fixes the dir-Open no-op.
                () => revealPathInBrowserTab(inspectorSelection.path, true)
              : undefined
          }
          onNavigate={selectByPath}
          onContactNavigate={selectByPath}
          onSetAsScope={
            inspectorSelection?.kind === "file" ||
            inspectorSelection?.kind === "directory"
              ? () =>
                  graphFromHere(
                    inspectorSelection.path,
                    inspectorSelection.kind === "directory",
                  )
              : inspectorSelection?.kind === "language"
                ? // "Graph from here" on a language bubble opens a NEW
                  // graph tab scoped to that language's lens (semantic
                  // mode), matching the file / directory path.
                  () => openGraphForLanguage(inspectorSelection.language)
                : inspectorSelection?.kind === "tag"
                  ? // The tag inspector's "Graph from here" opens a NEW
                    // graph tab scoped to the tag's lens (bidirectional
                    // BFS around the hashtag node), so the user can
                    // descend into its neighbourhood without going
                    // through Search + the chip there.
                    () =>
                      openGraphForTag(
                        inspectorSelection.nodeId,
                        inspectorSelection.label,
                      )
                  : inspectorSelection?.kind === "mention"
                    ? // The mention inspector's "Graph from here" always
                      // opens a NEW graph tab. A mention that resolves to a
                      // contact file scopes to that contact (bidirectional
                      // BFS around it); an unresolved mention (no matching
                      // file) scopes to the mention meta-node itself
                      // (`mention:@@Name`), whose bidirectional BFS lens
                      // surfaces every doc referencing the handle.
                      selectedContactPath
                      ? () => openGraphForContact(selectedContactPath!)
                      : () =>
                          openGraphForMention(
                            inspectorSelection.nodeId,
                            inspectorSelection.label,
                          )
                    : undefined
          }
          documentsOverride={selectionDocumentsInScope}
        />
      {/if}
    </Inspector>
  {/if}
  </div>
  <div class="statusbar">
    <span class="stat">
      {visibleNodeIds.size}/{nodes.length} nodes · {visibleEdges.length}/{edges.length} edges
      {#if filesystemMode && fsTruncated} · truncated{/if}
      {#if indexBuilding}
        · <span class="indexing" title="The workspace index is not ready; dead-end nodes may resolve once it completes.">{workspaceRecovering ? "workspace recovering…" : "indexing…"}</span>
      {/if}
    </span>
    <span class="hint">
      {filesystemMode ? "filesystem graph" : languageMode ? "language graph" : "semantic graph"} · drag to pan · scroll to zoom · click to inspect
    </span>
  </div>
  </div>
{/snippet}

<style>
  /* Keep-alive contract, copied from .editor-tab / .terminal-tab: every
     graph tab in the pane stays mounted; inactive ones hide via
     visibility (NEVER display:none -- a display:none host reports 0x0,
     GraphCanvas.resize() then refits to nothing and pan/zoom is lost).
     visibility:hidden keeps real layout geometry while the rAF loop is
     paused, so a re-shown graph resumes its exact transform. No `flex:1`
     any more: the host is absolutely positioned in the pane's
     .face.front now, not a flex child. The inner flex column is kept
     for the canvas + menu children. */
  .graph-tab {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--bg);
    visibility: hidden;
    pointer-events: none;
  }
  .graph-tab.active {
    visibility: visible;
    pointer-events: auto;
  }
  /* Slider row used inside the graph tab-menu bubble. Mirrors the
     file tab menu's page-width row so all in-menu sliders read alike. */
  :global(.menu-slider-row) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    color: var(--text-secondary);
    font-size: 13px;
  }
  :global(.menu-slider-label) {
    color: var(--text);
    min-width: 4.5em;
  }
  :global(.menu-slider-row input[type="range"]) {
    flex: 1;
    accent-color: var(--link);
  }
  :global(.menu-slider-value) {
    font-variant-numeric: tabular-nums;
    color: var(--text);
    min-width: 2ch;
    text-align: right;
  }
  /* Disabled state: dim the row and disable pointer interactions
     on the range input. The native disabled attribute already
     blocks dragging; this is the visual cue. */
  :global(.menu-slider-row.disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }
  :global(.menu-slider-row.disabled input[type="range"]) {
    cursor: not-allowed;
  }
  .statusbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: var(--bg-card);
    border-top: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-secondary);
    flex-shrink: 0;
    min-height: 22px;
  }
  .stat {
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  /* A soft pulse on the "indexing" cue,
     mirroring the File Browser loader's "still working" feel so an
     in-flight index reads as not-yet-complete rather than final. */
  .indexing {
    color: var(--link);
    animation: graph-indexing-pulse 1.4s ease-in-out infinite;
  }
  @keyframes graph-indexing-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .indexing {
      animation: none;
    }
  }
  .hint {
    margin-left: auto;
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  .canvas {
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
    overflow: hidden;
  }
  /* Cytoscape mount: positioned absolute inside the relative
     .canvas parent. Cytoscape's example pattern; without explicit
     positioning its internal canvases can resolve their absolute
     positioning to the wrong ancestor and end up sized wrong. */
  .cy {
    position: absolute;
    inset: 0;
    /* Smooth fade when buildCytoscape clears the inline opacity:0
       it sets at the start of a rebuild; gives a gentler reveal
       than a hard pop into the d3-force animation. */
    transition: opacity 200ms ease-out;
  }
  .cy.dim {
    opacity: 0.4;
  }
  /* Ancestor breadcrumb band. Sits at the top
     of the inspector body, always visible for path-based scopes.
     Wraps on narrow inspector widths; clickable hops dim until
     hover. The current segment renders as plain text (no button)
     since clicking it would be a no-op. */
  .scope-crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 0.5rem 0.7rem 0.5rem 0.7rem;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    font-family: ui-monospace, monospace;
    color: var(--text-secondary);
    background: var(--bg-card);
  }
  .scope-crumbs .crumb {
    background: transparent;
    border: 0;
    padding: 1px 4px;
    margin: 0;
    color: var(--link);
    cursor: pointer;
    border-radius: 4px;
    font: inherit;
    line-height: 1.3;
    text-decoration: none;
    word-break: break-all;
  }
  .scope-crumbs .crumb:hover {
    background: var(--btn-hover);
    color: var(--text);
  }
  .scope-crumbs .crumb.current {
    color: var(--text);
    cursor: default;
    font-weight: 600;
  }
  .scope-crumbs .crumb-sep {
    color: var(--text-secondary);
    opacity: 0.6;
    user-select: none;
  }
  /* Inline ghost branch for nodes that exist in the graph but
     not in the tree (FileInfoBody can't render those). Mounted
     inside the shared `<Inspector>` wrapper, so we only style
     the body -- the title bar / close × comes from Inspector. */
  .ghost-body {
    padding: 0.6rem 0.7rem 0.8rem 0.7rem;
    font-size: 12.5px;
  }
  .ghost-body .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  .ghost-body .title {
    margin: 0 0 0.15rem 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
  }
  .ghost-body .path {
    color: var(--text-secondary);
    font-size: 13px;
    margin-bottom: 0.5rem;
    word-break: break-all;
  }
  .ghost-body .mono { font-family: ui-monospace, monospace; }
  .ghost-body .missing {
    color: var(--warn-text);
    font-style: italic;
    margin: 0.3rem 0 0.6rem 0;
    font-size: 11.5px;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-style: italic;
    pointer-events: none;
  }
  .placeholder.error {
    color: #d33;
    font-style: normal;
  }
  .stream-status {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 2;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text-secondary);
    font-size: 12px;
    pointer-events: none;
  }

  /* Tab right-click bubble.
     Rows align with the standard hamburger-menu
     shape (`.mbtn` + `.msep`) used by TerminalTab / FileEditorTab
     / FileBrowserSurface. Filter rows pick up the same row chrome
     with a kind-coloured dot on the left, label in the middle,
     count on the right. */
  .tab-menu-bubble {
    position: fixed;
    z-index: 25500;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    padding: 4px;
    min-width: 240px;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    color: var(--text);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    /* easeOutBack bubble-pop matching every
       other tab-menu bubble (TerminalTab / FileEditorTab) and
       the rest of the chrome. */
    transform-origin: top left;
    animation: graph-tab-menu-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .tab-menu-bubble:hover {
    transform: scale(1.015);
  }
  @keyframes graph-tab-menu-pop {
    0%   { opacity: 0; transform: scale(0.92); }
    100% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-menu-bubble {
      animation: none;
      transition: none;
    }
    .tab-menu-bubble:hover {
      transform: none;
    }
  }
  .tab-menu-bubble .mbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    text-align: left;
    transform-origin: left center;
    transition:
      background 80ms ease,
      color 80ms ease,
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .tab-menu-bubble .mbtn:hover,
  .tab-menu-bubble .mbtn.on {
    background: var(--hover-bg);
  }
  .tab-menu-bubble .mbtn:hover:not(.disabled) {
    transform: scale(1.02);
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-menu-bubble .mbtn {
      transition: background 80ms ease, color 80ms ease;
    }
    .tab-menu-bubble .mbtn:hover {
      transform: none;
    }
  }
  .tab-menu-bubble .mbtn.disabled {
    color: var(--text-secondary);
    cursor: not-allowed;
    opacity: 0.58;
  }
  .tab-menu-bubble .mbtn-icon {
    width: 18px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tab-menu-bubble .mbtn-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-menu-bubble .mbtn-chord {
    margin-left: 1.5rem;
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
  }
  .tab-menu-bubble .msep {
    height: 1px;
    background: var(--separator, var(--border));
    margin: 4px 2px;
  }
  /* Depth row hosts a slider in the value slot; keep the row
     height in line with the action rows by leaning on `.mbtn`. */
  .tab-menu-bubble .depth-row input[type="range"] {
    flex-shrink: 0;
    width: 90px;
  }
  .tab-menu-bubble .depth-value {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    width: 1.6em;
    text-align: right;
  }
  /* Graph hamburger header row -- kind icon +
     path label. Path fades at the right edge for long file
     paths so the menu width stays bounded; matches the
     Pane.svelte tab-name + FileTree.svelte fade
     pattern verbatim. */
  .tab-menu-bubble .graph-scope-row {
    /* Click-to-inspector. Cursor:
       pointer matches the rest of the menu's clickable rows so
       the affordance reads at a glance. */
    cursor: pointer;
  }
  .tab-menu-bubble .graph-scope-row:hover .graph-scope-path {
    color: var(--text);
  }
  .tab-menu-bubble .graph-scope-row .graph-scope-path {
    flex: 1;
    min-width: 0;
    display: block;
    white-space: nowrap;
    overflow: hidden;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
  }
  /* Shallow-scope cue: when the scope's
     depth-cap is 1 (single-file graph, etc.) show a `[max]`
     suffix on the depth value so the user can see at a glance
     that the slider can't be dragged further. The `.shallow`
     class on `.depth-row` widens the value column to fit the
     suffix; `.depth-cue` is the smaller dimmer trailing chip. */
  .tab-menu-bubble .depth-row.shallow .depth-value {
    width: auto;
  }
  .tab-menu-bubble .depth-cue {
    color: var(--text-secondary);
    font-size: 0.85em;
    margin-left: 0.25rem;
    opacity: 0.7;
  }
  /* Filter rows: kind-coloured dot left, label middle, count
     right. On-state fills the dot; off-state shows a hollow ring
     so the on/off cue reads at a glance without relying on the
     row background hover. The `.mbtn.on` default background would
     fill the row whenever a filter is toggled on; override it
     here so multiple-on filters don't paint the whole bubble. */
  .tab-menu-bubble .filter-row.on {
    background: transparent;
  }
  .tab-menu-bubble .filter-row.on:hover {
    background: var(--hover-bg);
  }
  .tab-menu-bubble .filter-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid transparent;
    flex-shrink: 0;
  }
  .tab-menu-bubble .filter-count {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
</style>
