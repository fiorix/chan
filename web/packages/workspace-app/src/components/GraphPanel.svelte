<script lang="ts">
  // Graph tab body. Draws the window's shared graph (`state/graphData`,
  // one copy for every tab) over the tab's own filesystem spine
  // (`loadSpine`) and hands it to GraphCanvas, which lays it out with
  // d3-force and paints it on a Canvas 2D context; pan / zoom / node drag
  // / hover / selection live there too.
  //
  // The semantic graph is one graph (`graph/selectionView`): the whole
  // workspace, rooted at its own node, which the canvas pins at the bottom.
  // What is drawn is the directory tree as far as the tab has it opened
  // (`graphState.expanded`), with what the selected node reveals laid over
  // it: a file, tag, mention, contact or language shows what it refers to
  // and what refers to it, each with its directories. A tag, a contact or a
  // directory is a selection here, never a graph of its own, and "Graph
  // from here" opens this same graph with that node selected. The depth is
  // the selected node's: levels opened below a directory, hops of
  // references from any other node. The filter chips compose with all of
  // it in `visibleEdges` / `visibleNodeIds`. GraphCanvas reuses the
  // laid-out node of every id that stays visible and re-warms the
  // simulation around the change.

  import { api } from "../api/client";
  import { ApiError, isWorkspaceRootMissingError } from "../api/errors";
  import { isDraftClientPath } from "../api/fileIdentity";
  import type {
    DraftListEntry,
    FsGraphEdge,
    FsGraphNode,
    FsGraphResponse,
    GraphView,
  } from "../api/types";
  import {
    activeGraphTab,
    allPaneTabs,
    flipHybrid,
    layout,
    openGraphInActivePane,
    openInActivePane,
    panesHaveSides,
    setGraphPendingSelect,
    setGraphSelection,
    setGraphShownDepth,
    type GraphTab,
  } from "../state/tabs.svelte";
  import {
    effectiveHybridSurfaceTheme,
    graphReloadSignal,
    indexStatus,
    openCommandLauncherFromMenu,
    openGraphForContact,
    openGraphForLanguage,
    openGraphForMention,
    openGraphForTag,
    paneWidths,
    persistPaneWidths,
    revealPathInBrowser,
    schedulePersistStateToHash,
    scheduleSessionSave,
    surfaceThemeOverride,
    tree,
  } from "../state/store.svelte";
  import { drafts, refreshDrafts } from "../state/drafts.svelte";
  import { ensureGraphLoaded, graphData, refreshGraph } from "../state/graphData.svelte";
  import { graphPaletteStyleFor } from "../state/graphPalette.svelte";
  import { windowCaps } from "../state/windowCaps";
  import { onDestroy, tick, untrack } from "svelte";
  import {
    fbWatchRegister,
    fbWatchReconcile,
    fbWatchDispose,
  } from "../state/fbWatch.svelte";
  import { basename, parentDir } from "../state/format";
  import { clampMenu } from "./menuClamp";
  import { menuEscape } from "./menuEscape";
  import { portal } from "./portal";
  import { tabMenu, openTabMenu, closeTabMenu } from "../state/tabMenu.svelte";
  import { Command as CommandIcon, HardDrive, Settings2, X } from "@lucide/svelte";
  import DraftInfoBody from "./DraftInfoBody.svelte";
  import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
  import Inspector from "./Inspector.svelte";
  import InspectorBody, { type InspectorSelection } from "./InspectorBody.svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import KindChip from "./KindChip.svelte";
  import {
    classifyFile as classifyFileKind,
    classifyEntry,
    fileBucket,
    isOpenableTextKind,
    type FileKind,
  } from "../state/kinds";
  import { chordFor, shortcutLabel } from "../state/shortcuts";
  import { commandTitle } from "../state/commands";
  import {
    GRAPH_FILTER_ROWS,
    toggleGraphFilter,
    type GraphFilterKind,
  } from "../state/commands/graph";
  import "../state/commands/install";
  import { FS_GRAPH_DEPTH_MAX, shallowestFileDepth } from "../graph/depth";
  import {
    directoryNodeId,
    type CanvasEdge as RenderedEdge,
    type CanvasEdgeKind as RenderedEdgeKind,
    type CanvasNode as RenderedNode,
    type DrawnNode,
  } from "../graph/canvasNodes";
  import {
    DRAFTS_GROUP_NODE_ID,
    NO_DRAFT_LAYER,
    draftLayer,
    type DraftLayer,
  } from "../graph/draftNodes";
  import { ancestorClosure } from "../graph/containmentSpine";
  import { ancestorsExpanded } from "../graph/pathVisibility";
  import {
    NO_GRAPH,
    drawnPart,
    graphEdgeKey,
    withSpine,
    type DrawnGraph,
  } from "../graph/sharedGraph";
  import {
    graphNodeIds,
    openBelow,
    openedDepth,
    openedForPath,
    selectedDirectory,
    selectionDepthCap,
  } from "../graph/selectionView";

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
  // with a `graph`-kind tab), so the scope/state come straight from
  // the tab. Every graph tab in
  // the pane stays mounted and hidden through the visibility contract,
  // so `visible` tracks the `active` prop. The load and watcher effects
  // gate on it: a hidden graph fetches nothing, takes nothing of the
  // shared graph and paints nothing, and catches up once when it is
  // shown again.
  const graphState = $derived(tab);
  const visible = $derived(active);

  /// The breadcrumb over the inspector: the selected file's or directory's
  /// path from the workspace down, one step per directory. A step selects
  /// its directory; the last is the selection itself, and is not a button.
  /// With a tag, a mention or a language selected, or nothing, it is the
  /// workspace alone.
  type Crumb = { label: string; key: string; current: boolean; go: () => void };
  const scopeAncestors = $derived.by<Crumb[]>(() => {
    const path =
      selectedNode && (selectedNode.kind === "file" || selectedNode.kind === "folder")
        ? selectedNode.path
        : null;
    const crumbs: Crumb[] = [
      { label: "workspace", key: "", current: path === "", go: () => selectFromCrumb("") },
    ];
    const segments = path ? path.split("/") : [];
    for (let i = 0; i < segments.length; i++) {
      const sub = segments.slice(0, i + 1).join("/");
      crumbs.push({
        label: segments[i],
        key: sub,
        current: i === segments.length - 1,
        go: () => selectFromCrumb(directoryNodeId(sub)),
      });
    }
    return crumbs;
  });

  /// A breadcrumb step: select that directory's node, when the loaded graph
  /// has it.
  function selectFromCrumb(id: string): void {
    const n = nodeById.get(id);
    if (n) selectFromList(n);
  }

  /// Double-click a graph node: a directory opens or closes in place, as a
  /// File Browser's does. The loaded graph holds the whole tree, so this
  /// only flips the directory's flag in the opened set and the drawn set
  /// follows; closing keeps what was opened below it for the next opening.
  /// The preceding tap already set the selection, so this reads it. The
  /// window's session follows the tab's opened set as a whole, not each
  /// key, so this schedules its saves.
  function onGraphDoubleClick(): void {
    if (!selectedNode || selectedNode.kind !== "folder") return;
    const path = selectedNode.path;
    if (graphState.expanded[path]) {
      delete graphState.expanded[path];
    } else {
      const before = new Set(visibleNodeIds);
      graphState.expanded[path] = true;
      loadOpenedChildren();
      void requestExpansionFitAfterUpdate(path, before);
    }
    schedulePersistStateToHash();
    scheduleSessionSave();
  }

  /// Bumped to fetch the whole spine again when a directory is opened whose
  /// children the drawn graph does not hold and there is no spine to patch.
  let spineReload = $state(0);
  /// Directories a fetch was already asked for, so one that is empty on
  /// disk asks once.
  const spineAsked = new Set<string>();

  /// The shared graph holds the whole tree once the index has answered.
  /// Until then the tab draws its filesystem spine only as deep as the
  /// opened directories reached at its last fetch, so one opened past that
  /// has no children to show: read them, a level per such directory.
  function loadOpenedChildren(): void {
    const withChildren = new Set<string>();
    for (const n of nodes) {
      if ((n.kind === "file" || n.kind === "folder") && n.path) withChildren.add(parentDir(n.path));
    }
    const missing = new Set<string>();
    for (const dir of Object.keys(expandedDirs)) {
      if (!dir || !expandedDirs[dir] || withChildren.has(dir) || spineAsked.has(dir)) continue;
      spineAsked.add(dir);
      missing.add(dir);
    }
    if (missing.size === 0) return;
    if (spineRead !== null && !spineLoading && spineError === null) void patchSpine(missing);
    else spineReload += 1;
  }

  // ---- the depth, which is the selected node's ---------------------------

  /// The directory the depth acts on: the selected one, the root when
  /// nothing is selected, null when the selection is any other node (its
  /// depth is hops).
  const depthDir = $derived.by(() => selectedDirectory(nodes, selectedId));
  /// A directory other than the root can be closed, which is depth 0.
  const depthMin = $derived.by(() => (depthDir !== null && depthDir !== "" ? 0 : 1));
  /// The largest depth the selected node can use: the levels below a
  /// directory, the hops a file's, tag's or mention's references run.
  const depthCap = $derived.by(() => selectionDepthCap(nodes, edges, selectedId));
  /// Nothing further to reveal from the selected node: the control is
  /// disabled and marks its value as the maximum.
  const depthShallow = $derived.by(() => depthCap <= depthMin);
  /// What the depth control shows. A directory's depth is read from the
  /// tree, so it follows a double-click as well as the slider; any other
  /// node's is the hops the tab holds.
  const depthValue = $derived.by(() =>
    depthDir !== null
      ? Math.min(openedDepth(nodes, expandedDirs, depthDir), depthCap)
      : Math.max(1, Math.min(graphState.depth, depthCap)),
  );
  function setDepth(value: number): void {
    if (depthDir === null) {
      graphState.depth = value;
      return;
    }
    const before = new Set(visibleNodeIds);
    graphState.expanded = openBelow(nodes, expandedDirs, depthDir, value);
    loadOpenedChildren();
    void requestExpansionFitAfterUpdate(depthDir, before);
  }
  /// The depth is the selected node's, so a new selection starts it over:
  /// a directory's is read from the tree as it stands, any other node
  /// begins at one hop.
  function depthFollowsSelection(next: string | null): void {
    if (next !== selectedId) graphState.depth = 1;
  }

  // The launcher's depth steps show the depth as their value. It is worked
  // out here, so a shown tab carries what its control shows.
  $effect(() => {
    if (!visible) return;
    const shown = depthValue;
    untrack(() => setGraphShownDepth(tab, shown));
  });

  /// Whether this panel's tab came from an opener and has not yet shown a
  /// selection, as opposed to one restored or moved here with its own.
  const openedFresh = untrack(() => tab.selectedNodeId == null && tab.pendingSelectId !== null);

  /// A graph opened on a directory shows that directory's files. The
  /// opener opens the directory one level; when its immediate children are
  /// all directories, that level holds folder bubbles and no file, though
  /// the loaded graph carries the files and the inspector beside it counts
  /// them. This opens it down to the shallowest level that holds one.
  ///
  /// Only for a tab fresh from an opener, on its first load, and only
  /// while nothing below the directory is opened: a restored or moved tab's
  /// tree is the user's, and so is a depth they lowered afterwards.
  function showSelectedDirectoryFiles(): void {
    const dir = selectedNode?.kind === "folder" ? selectedNode.path : "";
    if (!dir || !expandedDirs[dir]) return;
    const below = `${dir}/`;
    if (Object.keys(expandedDirs).some((d) => expandedDirs[d] && d.startsWith(below))) return;
    const reveal = shallowestFileDepth(dir, nodes);
    if (reveal <= 1) return;
    graphState.expanded = openBelow(nodes, expandedDirs, dir, Math.min(reveal, FS_GRAPH_DEPTH_MAX));
  }

  /// Asks the canvas to fit the directory at `path`, its parent and what
  /// opening it brought into view, once the drawn set has followed.
  async function requestExpansionFitAfterUpdate(
    path: string,
    before: Set<string>,
  ): Promise<void> {
    await tick();
    const ids = new Set<string>([directoryNodeId(path)]);
    if (path) ids.add(directoryNodeId(parentDir(path)));
    for (const id of visibleNodeIds) {
      if (!before.has(id)) ids.add(id);
    }
    expansionFitRequest = { nonce: ++expansionFitNonce, ids: [...ids] };
  }

  function fsEdgeKey(edge: FsGraphEdge): string {
    return `${edge.kind}\0${edge.source}\0${edge.target}`;
  }

  /// Join loaded paths by the opaque group, including pairs split across requests.
  function joinFsHardlinks(nodes: FsGraphNode[], edges: FsGraphEdge[]): FsGraphEdge[] {
    const edgeByKey = new Map<string, FsGraphEdge>();
    for (const edge of edges) {
      const ordered = edge.kind === "hardlink" && edge.source > edge.target
        ? { ...edge, source: edge.target, target: edge.source }
        : edge;
      edgeByKey.set(fsEdgeKey(ordered), ordered);
    }
    const groups = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.kind !== "file" || !node.link_group) continue;
      const members = groups.get(node.link_group) ?? [];
      members.push(node.id);
      groups.set(node.link_group, members);
    }
    for (const members of groups.values()) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const [source, target] = [members[i]!, members[j]!].sort();
          const edge: FsGraphEdge = { source, target, kind: "hardlink" };
          if (!edgeByKey.has(fsEdgeKey(edge))) edgeByKey.set(fsEdgeKey(edge), edge);
        }
      }
    }
    return [...edgeByKey.values()];
  }

  /// Per-batch node budget for cursor-paged fs-graph delivery. Within the
  /// server's [16, 256] clamp; small enough that appending a batch plus a
  /// low-alpha layout pass stays within a frame, large enough to keep the
  /// round-trip count down on a big workspace.
  const GRAPH_BATCH_NODES = 128;

  /// Levels a whole fetch of the spine asks for at once. A few in flight
  /// keep a tab with hundreds of opened directories from waiting on each
  /// round trip in turn.
  const SPINE_READS_AHEAD = 4;
  /// The first spine is drawn once its root's level lands, then at most
  /// this often: each drawing lays it over the shared graph and the layout
  /// takes the new nodes, which with thousands of directories opened costs
  /// more than reading a level.
  const SPINE_DRAW_MS = 1000;

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

  /// "Graph from here" opens a NEW graph tab with the clicked node selected:
  /// the same graph, on that node. A directory comes with the path down to
  /// it opened, so its children show; a file is revealed by its selection.
  function graphFromHere(path: string, isDir: boolean): void {
    openGraphInActivePane({
      depth: 1,
      pendingSelectId: path,
      ...(isDir ? { expanded: openedForPath(path) } : {}),
    });
  }

  function close(): void {
    onClose?.();
  }

  // ---- types -------------------------------------------------------------

  // The graph view renders files (media arrive as file nodes too),
  // folders, tags, mentions and languages: the canvas's node and edge
  // types, imported above. The wire types also name a `date` node and edge
  // kind; `drawnGraph` (graph/sharedGraph) drops both.

  /// Chip toggles. `tag`, `mention` and `language` are edge-kind
  /// filters: off, their edges hide, and a meta node renders only
  /// while a visible edge still reaches it. The `mention` chip,
  /// labelled contact, also hides contact file nodes. `img` hides
  /// file nodes whose path classifies as an image, with the edges
  /// touching them; `folder` hides directory nodes except those on
  /// an in-scope file's spine (`hiddenFolderIds`).
  /// `link` is intentionally absent from the user-facing
  /// FilterKind -- link edges always render (visibility is
  /// implicit via endpoint visibility). The tab's `GraphFilters`
  /// (tabs.svelte.ts) keeps a `link` slot this panel never reads;
  /// `encodeGraphTabFilters` still writes it into the layout hash,
  /// the saved session and `chan://graph` links.
  /// `markdown` + `source` FileBucket toggles, default ON. The
  /// shared `fileBucket` (state/kinds.ts) dispatches file nodes into
  /// the markdown / source / binary buckets client-side:
  /// `GraphNodeView::File` doesn't carry the `bucket` field
  /// (`ReportFileStats` does), so classification happens here
  /// rather than in a chan-server emit.
  type FilterKind = GraphFilterKind;

  // ---- state -------------------------------------------------------------

  /// The view of the window's shared graph this tab draws, and whether it
  /// was still streaming when taken (`graphData.partial`). The tab takes it
  /// while shown (see the effect that takes it). Held raw: the view is the
  /// store's own object, never a copy.
  let taken = $state.raw<{ view: GraphView; partial: boolean } | null>(null);
  /// What a hidden tab holds in place of `taken` once the window's graph has
  /// moved on under it: the part of its view it draws from, and no more.
  let kept = $state.raw<DrawnGraph | null>(null);
  /// The tab's own filesystem spine (`loadSpine`), under the canvas's types.
  let spine = $state.raw<DrawnGraph>(NO_GRAPH);
  let spineLoading = $state(true);
  let spineError = $state<string | null>(null);
  let spineSeq = 0;
  /// The spine's request found the workspace root gone. The tab then draws
  /// nothing, the shared graph included: what the index still holds of a
  /// missing workspace is not shown behind the error.
  let rootGone = $state(false);
  /// What the tab draws from: the shared graph over the spine. With nothing
  /// of the spine's own to add these are the shared graph's arrays
  /// themselves, the same in every tab of the window.
  const graph = $derived(
    rootGone ? NO_GRAPH : (kept ?? withSpine(spine, taken?.view ?? null)),
  );
  const nodes = $derived(graph.nodes);
  const edges = $derived(graph.edges);
  const loading = $derived(spineLoading || graphData.loading);
  const error = $derived(spineError ?? graphData.error);
  /// The tab draws a whole graph: its spine is in, and the shared graph it
  /// took is complete and is the one the window holds now. An answer marked
  /// gated is the empty graph of an index being rebuilt, which says nothing
  /// of what the workspace holds, until the index reports an error: then no
  /// later answer is coming.
  const graphWhole = $derived(
    !loading &&
      taken !== null &&
      !taken.partial &&
      taken.view === graphData.view &&
      (!graphData.gated || indexStatus.value?.state === "error"),
  );
  /// Set once `showSelectedDirectoryFiles` has had its one run.
  let shownDirectoryFiles = false;
  let watchReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let seenGraphReloadNonce = graphReloadSignal.nonce;
  // Keep-alive load gating. PLAIN locals, never rendered:
  // they are read/written only inside the load + watcher effects, so
  // they cannot trip Svelte's state_unsafe_mutation guard (that fires
  // on mutating $state inside a $derived). `hasLoadedOnce` makes the
  // first load LAZY on first activation rather than on mount (the
  // each-block mounts every graph tab at session restore; mount-gating
  // would fire N loads at once). `graphDirty` records that a hidden
  // graph missed a watcher edit, so it fetches its spine exactly once
  // when next shown. `lastLoadedKey` lets the visible-load decision
  // tell a real change of the load key from an idempotent re-fire.
  let hasLoadedOnce = false;
  let graphDirty = false;
  let lastLoadedKey: string | null = null;
  /// The paths of the changes the spine has not taken yet, or null when one
  /// of them named no path and only a whole fetch takes it.
  let spineChanges: Set<string> | null = new Set();
  /// Past this many paths not taken yet (a branch switch, a hidden tab's
  /// long wait) the changes are dropped for a whole fetch, which reads the
  /// tree the tab draws whatever changed below it.
  const SPINE_CHANGES_MAX = 1000;
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
  // mechanism File Browser drives via `fbWatch`; the actual redraw
  // runs through the `graphReloadSignal` reload path.
  const graphInstanceId = $derived(`graph-tab-${tab.id}`);

  /// Directories the loaded graph holds a file of: the parent directory
  /// of each file node. Root (`""`) is excluded (always implicitly
  /// watched). Recomputes as the nodes change.
  const displayedDirs = $derived.by<string[]>(() => {
    const dirs = new Set<string>();
    // A file node carries no directory node; add each one's parent
    // directory so a save inside a shown document's folder reaches this
    // graph.
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

  /// `indexStatus` is the workspace-global indexer state. While the index is
  /// still building/reindexing, or the workspace is recovering, the semantic
  /// graph may be INCOMPLETE -
  /// link targets that simply aren't indexed yet surface as dead-end
  /// ("missing") nodes. Surface an "indexing" cue so an in-flight graph
  /// isn't trusted as complete; once the index is idle, any remaining
  /// dead-end is a real broken link. (`hiddenMissingIds` below pulls
  /// those dead-ends back while indexing.)
  const workspaceRecovering = $derived(
    indexStatus.value?.state === "recovering",
  );
  const indexBuilding = $derived(
    indexStatus.value?.state === "building" ||
      indexStatus.value?.state === "reindexing" ||
      workspaceRecovering,
  );

  /// Copy for the canvas empty-state (not loading, no error, zero nodes).
  /// The graph draws the tree from disk before the index answers, so it is
  /// empty only over a workspace with nothing in it or while the workspace
  /// recovers. A zero-node result WHILE the index is still building means
  /// "not ready yet", not "nothing here"; an idle one stays optimistic
  /// ("data being indexed, hang tight...").
  const emptyStateMessage = $derived(
    workspaceRecovering
      ? "graph unavailable while the workspace recovers"
      : indexBuilding
        ? "graph temporarily unavailable while indexing the workspace"
        : "data being indexed, hang tight...",
  );

  // Currently inspected node, surfaced in the side details panel.
  // Tap a node to set this; tap empty space to clear it. Nodes never
  // auto-open on click; the panel's Open button is the only path to
  // opening a file from here.
  let selectedId = $state<string | null>(null);
  // The tab outlives its panel: moving it to another pane mounts a new
  // panel, whose `selectedId` starts empty. The selection the tab recorded
  // goes through the pending path a reload restores it by, so the first
  // load selects its node, or drops it when the node is gone.
  untrack(() => {
    if (tab.pendingSelectId === null && tab.selectedNodeId != null) {
      setGraphPendingSelect(tab, tab.selectedNodeId);
    }
  });
  let expansionFitNonce = 0;
  let expansionFitRequest = $state<{ nonce: number; ids: string[] } | null>(null);

  /// Tab right-click bubble state. Open when the
  /// shared tab-menu state addresses THIS tab; positioned via the
  /// stored anchor through `clampMenu` so the bubble stays on-
  /// screen even when the tab sits near the viewport edge.
  const tabMenuOpen = $derived(tabMenu.openForTabId === tab.id);
  const tabMenuPos = $derived.by(() => {
    const a = tabMenu.anchor;
    if (!a) return { x: 0, y: 0 };
    return { x: Math.round(a.left), y: Math.round(a.bottom + 4) };
  });

  const tabMenuKeys = menuEscape({
    open: () => tabMenuOpen,
    inside: (target) => target instanceof Element && !!target.closest(".tab-menu-bubble"),
    close: closeTabMenu,
  });

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

  /// File nodes reach the chips, the hidden-id sets and the inspector
  /// through `fileBucket` (state/kinds.ts), the bucketer the canvas
  /// paints with, so a node is counted, hidden and coloured as one kind.

  /// Forced reload of the graph, by the launcher's `Reload graph` command:
  /// the tab's spine, and the window's shared graph, which every surface
  /// that draws it takes once it has arrived whole.
  function reloadGraph(): void {
    closeTabMenu();
    lastLoadedKey = loadKey;
    graphDirty = false;
    void loadSpine();
    void refreshGraph();
  }

  // The launcher's `Reload graph`, `Select workspace` and depth steps reach
  // this panel through the chan:command bridge, since the tab's spine is
  // fetched here and the loaded nodes and the selection live here. Only the
  // graph the launcher itself targeted responds, so the command's
  // active-surface gate and the acting graph agree.
  $effect(() => {
    const onLauncherCommand = (e: Event) => {
      const name = (e as CustomEvent).detail?.name;
      if (activeGraphTab()?.id !== tab.id) return;
      if (name === "app.graph.reload") reloadGraph();
      else if (name === "app.graph.scopeDetails") openScopeHeaderInspector();
      // The depth is the selected node's, which only the panel knows.
      else if (name === "app.graph.depth.increase") setDepth(Math.min(depthValue + 1, depthCap));
      else if (name === "app.graph.depth.decrease") setDepth(Math.max(depthValue - 1, depthMin));
    };
    window.addEventListener("chan:command", onLauncherCommand);
    return () => window.removeEventListener("chan:command", onLauncherCommand);
  });

  function closeFromMenu(): void {
    closeTabMenu();
    close();
  }

  /// Flip the pane that holds this graph, whichever pane has the focus.
  function flipFromMenu(): void {
    closeTabMenu();
    const pane = Object.values(layout.nodes).find(
      (node) => node.kind === "leaf" && allPaneTabs(node).some((t) => t.id === tab.id),
    );
    if (pane) flipHybrid(pane.id);
  }

  // The launcher's own toggle is a chord with no catalog row, so its menu row
  // takes the shortcut table's words.
  const LAUNCHER = "app.launcher.toggle";
  const launcherLabel = shortcutLabel(LAUNCHER);

  /// Open the launcher from the menu. A graph holds no keyboard caret to
  /// hand back, so the launcher records the page as its opener.
  function openCommandsFromMenu(e: MouseEvent): void {
    const row = e.currentTarget as Element;
    closeTabMenu();
    openCommandLauncherFromMenu(row);
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

  // ---- derived: what is drawn --------------------------------------------
  //
  // Two filters compose to decide what's drawn:
  //
  //   (1) what the graph includes (`scopedNodeIds`): the opened directory
  //       tree with what the selected node reveals laid over it.
  //   (2) the chips (tag / mention / language / img / folder /
  //       markdown / source). An edge whose kind or endpoint is
  //       filtered out drops, and a tag, mention or language node
  //       reached by no visible edge drops with it.
  //
  // (1) runs first, over the whole loaded graph, so a selection's walk
  // sees every reference. (2) is a render-time filter that can change
  // without walking the graph again.

  /// The directory-spine expanded set, stored on the graph tab so it
  /// serializes into the tab's hash / session state (File Browser tab
  /// parity) and survives a window reload. A directory is present when its
  /// children should show; the scope root ("") is always expanded.
  const expandedDirs = $derived(graphState.expanded ?? { "": true });

  /// Set of node ids the graph includes, before the chips: the opened tree
  /// with the selection's reveal laid over it.
  const scopedNodeIds = $derived(
    graphNodeIds({
      nodes,
      edges,
      opened: expandedDirs,
      selectedId,
      depth: Math.max(1, graphState.depth),
    }),
  );

  /// File-node ids the `img` filter currently hides. Pulled out so
  /// both visibleEdges (drop edges touching a hidden image) and
  /// visibleNodeIds (skip the node entirely) agree.
  const hiddenImageIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.img) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && fileBucket(n.path, n.node_kind) === "img") ids.add(n.id);
    }
    return ids;
  });

  /// Contact-kind file-node ids hidden when the contact chip is off.
  /// The chip is wired off the `mention` filter slot (labelled
  /// "contact" in the semantic graph) so toggling it has the same shape
  /// as the img toggle: hide the nodes AND any edges touching them.
  /// Without the node hide, the contact nodes would stay on screen with
  /// their mention edges gone -- half a filter.
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
  /// files and walks `contains` upward with `ancestorClosure`, for
  /// the same "no file renders edgeless" invariant. Keyed off in-scope (not chip-visible) files
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
    ancestorClosure(onSpine, edges);
    for (const n of nodes) {
      if (n.kind === "folder" && onSpine.has(n.id)) ids.add(n.id);
    }
    return ids;
  });

  /// Directory node ids hidden when the folder chip is off -- directory-bubble
  /// CLUTTER only. Directories on the file→parent spine (`spineFolderIds`) stay
  /// visible so files keep their containment anchor; the folder chip declutters
  /// directory bubbles, it does not cut the spine. Every mode maps a directory
  /// to a `folder` node, so the set can be non-empty in each of them.
  const hiddenFolderIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.folder) return ids;
    for (const n of nodes) {
      if (n.kind === "folder" && !spineFolderIds.has(n.id)) ids.add(n.id);
    }
    return ids;
  });

  /// File nodes hidden when the markdown chip is OFF.
  /// Bucket = `fileBucket === "doc"` (.md / .txt per the
  /// shared classifier). The `contact` discriminator is gated by
  /// the `mention` chip (existing hiddenContactIds) and image-class
  /// files by `img`; this hidden-set covers markdown specifically.
  const hiddenMarkdownIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.markdown) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && fileBucket(n.path, n.node_kind) === "doc") {
        ids.add(n.id);
      }
    }
    return ids;
  });

  /// File nodes hidden when the source chip is OFF.
  /// Bucket = `fileBucket === "source"` (the rest of the server's
  /// text class: code, config, markup, data).
  const hiddenSourceIds = $derived.by(() => {
    const ids = new Set<string>();
    if (show.source) return ids;
    for (const n of nodes) {
      if (n.kind === "file" && fileBucket(n.path, n.node_kind) === "source") {
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
  /// (The status bar's "indexing" cue is the loading signal.)
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
    // non-spine directory bubbles out). Gating it on show.folder would drop
    // the whole spine when the folder chip is off and leave files loose.
    if (kind === "contains") return true;
    // Link edges always render -- a link filter doesn't make
    // sense because link visibility
    // is implicit (an edge renders iff both endpoints render under
    // the current node-type filters + depth). The `link` slot on
    // the tab's `GraphFilters` (tabs.svelte.ts) is never read here;
    // `encodeGraphTabFilters` still round-trips it through the
    // layout hash, the saved session and `chan://graph` links.
    if (kind === "link") return true;
    // A symlink's and a hardlink's edges are facts of the tree, as
    // `contains` is: no chip names them, and they join files, not a tag or
    // a contact a chip could hide.
    if (kind === "symlink" || kind === "hardlink") return true;
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
      const cls = fileBucket(n.path, n.node_kind);
      if (cls === "img") c.img++;
      else if (cls === "contact") c.mention++;
      else if (cls === "doc") c.markdown++;
      else if (cls === "source") c.source++;
    }
    return c;
  });

  // ---- side-panel derived state ------------------------------------------

  const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));

  // ---- the drafts, drawn beside the graph ---------------------------------
  //
  // A workspace's drafts are kept outside it, so the loaded graph has no
  // node for one. The whole-workspace content graph still draws them: the
  // Drafts group hung from the workspace's node, and a node per listed
  // draft hung from the group. They go only into what the canvas is handed
  // (the four `canvas*` values below). `nodes`, `edges` and everything
  // derived from them above never hold one, so the chip counts, the depth
  // range, a selection's reveal and the watched directories read the same
  // whether or not drafts are listed, and a draft is counted nowhere as a
  // workspace file.
  const draftNodes = $derived.by<DraftLayer>(() => {
    if (!windowCaps.workspace) return NO_DRAFT_LAYER;
    // Drawn where the workspace's own node is: the group hangs from it.
    const rootId = directoryNodeId("");
    if (!nodeById.has(rootId) || !visibleNodeIds.has(rootId)) return NO_DRAFT_LAYER;
    return draftLayer(drafts.rows, rootId, (id) => nodeById.has(id));
  });
  const canvasNodes = $derived<DrawnNode[]>(
    draftNodes.nodes.length === 0 ? nodes : [...nodes, ...draftNodes.nodes],
  );
  const canvasEdges = $derived(
    draftNodes.edges.length === 0 ? edges : [...edges, ...draftNodes.edges],
  );
  const canvasVisibleEdges = $derived(
    draftNodes.edges.length === 0 ? visibleEdges : [...visibleEdges, ...draftNodes.edges],
  );
  const canvasVisibleNodeIds = $derived.by(() => {
    if (draftNodes.nodes.length === 0) return visibleNodeIds;
    const ids = new Set(visibleNodeIds);
    for (const n of draftNodes.nodes) ids.add(n.id);
    return ids;
  });

  // The drafts list is asked for when a graph that draws it is first shown;
  // every draft event refetches it after that. A request that fails leaves
  // `drafts.loaded` as it was, so this does not ask again by itself.
  $effect(() => {
    if (!visible || !windowCaps.workspace || drafts.loaded) return;
    untrack(() => void refreshDrafts());
  });

  /// The selection when it is the drafts group's node or a draft's: the
  /// listed draft behind a draft's node, null for the group. The loaded
  /// graph's node of the same id, were there one, is not in the layer.
  const selectedDraft = $derived.by<{ row: DraftListEntry | null } | null>(() => {
    if (selectedId === null || draftNodes.nodes.length === 0) return null;
    if (selectedId === DRAFTS_GROUP_NODE_ID) return { row: null };
    const row = draftNodes.rows.get(selectedId);
    return row === undefined ? null : { row };
  });

  // A selected draft can leave the list: it is saved to the workspace or
  // discarded, which is what its Open button leads to. Its node goes with
  // it, and so does the selection: left in place it would name a node no
  // graph holds, and the tab would save that as its selection.
  let selectedLayerId: string | null = null;
  $effect(() => {
    const id = selectedId;
    if (selectedDraft !== null) {
      selectedLayerId = id;
      return;
    }
    const left = id !== null && id === selectedLayerId;
    selectedLayerId = null;
    if (left) selectedId = null;
  });

  /// The selection as the tab keeps it across a reload. The drafts group's
  /// node and a draft's are not kept: they are drawn from the drafts list,
  /// and the graph a reload restores a selection onto does not hold them.
  function keptSelection(id: string | null): string | null {
    if (id === null || draftNodes.nodes.length === 0) return id;
    return id === DRAFTS_GROUP_NODE_ID || draftNodes.rows.has(id) ? null : id;
  }

  const selectedNode = $derived<RenderedNode | null>(
    // `selectedId !== null` (not a truthy test): the workspace-root
    // node carries id="" in the workspace-scope merged view, and a
    // truthy test would silently null it out.
    selectedId !== null ? (nodeById.get(selectedId) ?? null) : null,
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
      const base = basename(e.path);
      const stem = base.replace(/\.md$/i, "").toLowerCase();
      if (stem.includes(needle)) return e.path;
    }
    return null;
  }

  /// Path the currently-selected mention/contact node resolves to,
  /// or null when the mention is unresolved (no contact file on
  /// disk yet). Drives whether a mention selection gets an `onOpen`
  /// action, and whether its `onSetAsScope` scopes the new graph to the
  /// contact file or to the mention node.
  const selectedContactPath = $derived<string | null>(
    selectedNode && selectedNode.kind === "mention"
      ? resolveContactToPath(selectedNode.label)
      : null,
  );

  /// Graph "Open" for a node that resolves to a real workspace path.
  /// Mirrors the File Browser's open-selection: an editable text file
  /// (markdown note, contact, plain source / config) opens in the active
  /// editor pane through the same `openInActivePane` call
  /// `FileBrowserSurface` uses, so the two surfaces agree on what "Open"
  /// means. A binary / media / non-openable file reveals in a File
  /// Browser tab instead; the filesystem
  /// layer's `file`-kind nodes carry no text-vs-binary distinction, so
  /// the editable verdict comes from the tree entry's server kind (with
  /// a path-based fallback when the entry isn't in the current listing).
  /// Directory nodes never reach here: a directory "Open" routes through
  /// `onReveal`, which reveals it in a File Browser tab that enters it.
  /// Either reveal opens the File Browser as a sibling tab and the graph
  /// tab stays open.
  function openFileOrReveal(path: string): void {
    const entry = tree.entries.find((e) => e.path === path);
    const kind = entry ? classifyEntry(entry) : classifyFileKind(path);
    if (isOpenableTextKind(kind)) {
      void openInActivePane(path);
    } else {
      revealPathInBrowser(path);
    }
  }

  function selectFromList(n: RenderedNode): void {
    // GraphCanvas reads `selectedId` reactively and applies the
    // selection ring + first-degree label reveal itself, so all
    // this surface has to do is mirror the id.
    depthFollowsSelection(n.id);
    selectedId = n.id;
    graphState.inspectorOpen = true;
  }

  /// The tab menu's header row names the workspace the graph is of; a click,
  /// or the launcher's `Select workspace`, selects the workspace's own node,
  /// which opens its inspector.
  function openScopeHeaderInspector(): void {
    depthFollowsSelection("");
    selectedId = "";
    // As a tap does: a selection still waiting on the graph must not take
    // this one's place when it lands.
    graphState.pendingSelectId = null;
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
                // Directory nodes route to FileInfoBody via the
                // "directory" kind on InspectorSelection. Backend emits `directory` for
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

  /// Per-chip dot color. The tag, mention and language chips name the
  /// tokens GraphCanvas strokes those edge kinds with, so a dot matches
  /// its edges; img is a node filter so it points at the image node
  /// color directly.
  const FILTER_COLORS: Record<FilterKind, string> = {
    tag: "var(--g-tag)",
    mention: "var(--g-contact, var(--warn-text))",
    language: "var(--g-language)",
    img: "var(--g-img)",
    folder: "var(--g-folder)",
    // FileBucket chip swatch colours. Markdown
    // tracks `--g-doc` (orange); source
    // tracks `--g-source` (royalblue). Binary nodes have no chip;
    // the `--g-binary` slot still drives their canvas fill but the
    // user can't toggle them on/off.
    markdown: "var(--g-doc)",
    source: "var(--g-source)",
  };

  function isFsDirectory(node: FsGraphNode): boolean {
    return node.kind === "directory";
  }

  // ---- custom palette application ------------------------------------------

  /// Inline custom-property block carrying the user's custom graph
  /// palette, keyed by the graph surface's EFFECTIVE theme (the
  /// body-theme pin, else the app theme) so a per-mode palette follows
  /// the pin. Applied on `.graph-tab` below (the canvas reads its theme
  /// from inside that subtree) and on the portaled tab-menu bubble (its
  /// filter dots escape the subtree onto document.body and would
  /// otherwise keep the theme colours while the canvas shows the custom
  /// ones). Standard mode yields an empty string: no attribute, no
  /// override, theme palette untouched.
  const paletteStyle = $derived(
    graphPaletteStyleFor(effectiveHybridSurfaceTheme("graph")),
  );

  // ---- canvas glue -------------------------------------------------------
  //
  // The graph is rendered by the GraphCanvas child component. This
  // panel owns the data fetch + the scope/depth derivations; the
  // canvas owns the d3-force simulation, painting, and pointer
  // interaction. Selection round-trips: GraphCanvas calls back into
  // `setSelected` on tap, and `selectedId` goes back down as a prop,
  // so the inspector and the canvas's selection emphasis follow it.

  /// The graph has one root: the workspace's node, which the canvas pins
  /// and, under its default framing, seats at the bottom, so the tree grows
  /// up from the same spot whatever is selected.
  const FOCAL_IDS = [""];

  /// Resolve a `pendingSelectId` (set by "Graph from here") to the real
  /// rendered node id. The select is a workspace PATH: for a file that
  /// path IS the node id, but a directory node's id is `directory:<path>`
  /// (graph.rs::directory_node_id), so a bare-path pending does not match
  /// a directory by id. Match by id first,
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

  /// Fetches the tab's filesystem spine whole: the root's level and the
  /// level of every opened directory the tree draws, read straight from
  /// disk, one level a request, so a tab costs what it draws and not a walk
  /// of the tree down to its deepest opened directory. It is what the tab
  /// draws before the shared graph's first batch and while the index cannot
  /// answer, and it carries the symlinks and hardlinks of the directories
  /// the tab has open. The shared graph is laid over it (`withSpine`): a
  /// file (bare-path id) or a directory (normalized to `directory:<path>`)
  /// collides on id and the shared graph's node is the one drawn; what only
  /// the spine carries stays. A change in the workspace, and a directory
  /// opened before the shared graph holds its children, patch it
  /// (`patchSpine`) rather than fetching it again; a change made while this
  /// runs is patched once it lands.
  async function loadSpine(): Promise<void> {
    const seq = ++spineSeq;
    spineLoading = true;
    spineError = null;
    // A whole fetch reads every change made before it.
    spineChanges = new Set();
    // The first spine is drawn as its levels land, at most every
    // SPINE_DRAW_MS after the root's. A later one replaces the drawn spine
    // once it is whole, so a reload shows no shrunken tree on the way.
    const first = spine === NO_GRAPH;
    const read: SpineRead = { nodes: new Map(), edges: [], held: new Set() };
    const dirs = openedSpineDirs();
    // Up to SPINE_READS_AHEAD levels are asked for at once and laid down in
    // order, parents first.
    const reads: Array<ReturnType<typeof fetchSpineLevel>> = [];
    let asked = 0;
    const askAhead = (): void => {
      while (asked < dirs.length && reads.length < SPINE_READS_AHEAD) {
        const level = fetchSpineLevel(dirs[asked++], seq);
        // Awaited in its turn; one in flight when an earlier one fails is
        // dropped with the fetch.
        level.catch(() => {});
        reads.push(level);
      }
    };
    let drawnAt = -Infinity;
    let undrawn = false;
    let landed = false;
    try {
      askAhead();
      for (const dir of dirs) {
        const level = await reads.shift()!;
        if (level === "superseded") return;
        askAhead();
        applySpineLevel(read, dir, level);
        undrawn = true;
        if (first && performance.now() - drawnAt >= SPINE_DRAW_MS) {
          publishSpine(read);
          drawnAt = performance.now();
          undrawn = false;
        }
      }
      if (undrawn) publishSpine(read);
      spineRead = read;
      rootGone = false;
      landed = true;
    } catch (e) {
      if (seq !== spineSeq) return;
      spineFailed(e);
    } finally {
      if (seq === spineSeq) spineLoading = false;
    }
    if (landed && seq === spineSeq && (spineChanges === null || spineChanges.size > 0)) {
      if (visible) takeSpineChanges();
      else graphDirty = true;
    }
  }

  /// The root and every opened directory whose own directories are opened
  /// too, which is the tree the tab draws, parents first.
  function openedSpineDirs(): string[] {
    const dirs = Object.keys(expandedDirs).filter(
      (dir) => dir && expandedDirs[dir] && ancestorsExpanded("", dir, expandedDirs),
    );
    return ["", ...dirs.sort(byDepth)];
  }

  function spineFailed(e: unknown): void {
    if (isWorkspaceRootMissingError(e)) {
      // Do not leave the persisted/indexed graph dimly visible behind the
      // error after the source root is gone. The dirty editor owns its
      // buffer; a graph owns no unsaved state and converges to unavailable.
      rootGone = true;
      selectedId = null;
    }
    spineError = (e as Error).message;
  }

  /// The spine as `/api/fs-graph` delivered it, which a change patches: the
  /// nodes by id, the edges, and the directories whose children it holds.
  /// Plain, never rendered; `spine` is what is drawn of it.
  type SpineRead = {
    nodes: Map<string, FsGraphNode>;
    edges: FsGraphEdge[];
    held: Set<string>;
  };
  let spineRead: SpineRead | null = null;

  /// Whether the spine holds the children of the directory at `dir`: one
  /// whose level it read.
  function spineHoldsChildren(dir: string): boolean {
    return spineRead?.held.has(dir) ?? false;
  }

  /// Path segments whose contents the spine never draws: the repository's
  /// state and chan's own, which the walk leaves out and the watch still
  /// reports (git's HEAD and index, for one, on every commit).
  const UNDRAWN_SEGMENTS: ReadonlySet<string> = new Set([".git", ".hg", ".chan"]);

  /// The directories whose children a change at `paths` can have moved
  /// and the spine holds or the tree opens, or null for a change that named
  /// no path, which only a whole fetch answers. A draft's path names no
  /// workspace directory, and a path under `.git`, `.hg` or `.chan` none the
  /// spine draws.
  function spineDirsTouched(paths: Iterable<string>): Set<string> | null {
    const dirs = new Set<string>();
    let named = false;
    for (const path of paths) {
      named = true;
      if (isDraftClientPath(path) || path.split("/").some((segment) => UNDRAWN_SEGMENTS.has(segment))) {
        continue;
      }
      const dir = parentDir(path);
      // An opened directory the spine has not read (it was not there when
      // the tab read the tree) is read once the same patch brings it.
      if (spineHoldsChildren(dir) || drawsChildren(dir)) dirs.add(dir);
    }
    return named ? dirs : null;
  }

  /// The directories a change at `paths` named something in, held by the
  /// spine or not: where a symlink the spine holds may point.
  function spineParentsTouched(paths: Iterable<string>): Set<string> {
    const parents = new Set<string>();
    for (const path of paths) {
      if (isDraftClientPath(path) || path.split("/").some((segment) => UNDRAWN_SEGMENTS.has(segment))) {
        continue;
      }
      parents.add(parentDir(path));
    }
    return parents;
  }

  /// Whether the tree the tab draws shows the children of `dir`.
  function drawsChildren(dir: string): boolean {
    return dir === "" || (expandedDirs[dir] === true && ancestorsExpanded("", dir, expandedDirs));
  }

  /// The spine node `n` is a child of the directory at `dir`: an entry in
  /// it, or the ghost a symlink in it points at outside the workspace or at
  /// nothing (`outside:<symlink>`, `broken:<symlink>`).
  function spineChildOf(dir: string, n: FsGraphNode): boolean {
    if (n.path) return n.path !== dir && parentDir(n.path) === dir;
    const at = n.id.indexOf(":");
    return at > 0 && parentDir(n.id.slice(at + 1)) === dir;
  }

  /// The spine node `n` sits below the directory at `dir`, at any depth.
  function spineBelow(dir: string, n: FsGraphNode): boolean {
    const below = dir === "" ? "" : `${dir}/`;
    if (n.path) return n.path !== dir && n.path.startsWith(below);
    const at = n.id.indexOf(":");
    return at > 0 && n.id.slice(at + 1).startsWith(below);
  }

  /// One directory's children, read from disk a page at a time; null when
  /// the directory is no longer there. Throws any other failure.
  async function fetchSpineLevel(
    dir: string,
    seq: number,
  ): Promise<{ nodes: FsGraphNode[]; edges: FsGraphEdge[] } | null | "superseded"> {
    const nodes: FsGraphNode[] = [];
    const edges: FsGraphEdge[] = [];
    let cursor: string | undefined;
    let fs: FsGraphResponse;
    try {
      do {
        fs = await api.fsGraph({ scope: "directory", path: dir, depth: 1, limit: GRAPH_BATCH_NODES, cursor });
        if (seq !== spineSeq) return "superseded";
        nodes.push(...fs.nodes);
        edges.push(...fs.edges);
        cursor = fs.cursor ?? undefined;
        if (!fs.done && cursor) {
          await yieldToFrame();
          if (seq !== spineSeq) return "superseded";
        }
      } while (!fs.done && cursor);
    } catch (e) {
      if (seq !== spineSeq) return "superseded";
      // 404: the directory is gone; 400: a file stands where it was.
      if (dir !== "" && e instanceof ApiError && (e.status === 404 || e.status === 400) && !isWorkspaceRootMissingError(e)) {
        return null;
      }
      throw e;
    }
    return { nodes, edges };
  }

  /// The spine patches of a change, one at a time, so a later change's
  /// level lands after an earlier one's.
  let spinePatches: Promise<void> = Promise.resolve();

  /// A change in the workspace, as the spine takes it: the children of each
  /// directory in `dirs` are read again, one level each, and take the place
  /// of what the spine held of them, so a save costs a request per
  /// directory it touched, not a walk of the tree. A directory gone from
  /// disk takes everything below it. A patch that would read as many
  /// directories as a whole fetch reads is one, so a change never costs more
  /// than the tree the tab draws. A whole fetch begun since drops it, and a
  /// read that fails for another reason hands the change to one.
  /// `touched` holds every directory the change named something in, which
  /// is where the symlinks the spine holds are checked against.
  function patchSpine(dirs: ReadonlySet<string>, touched: ReadonlySet<string> = dirs): Promise<void> {
    if (dirs.size === 0 && touched.size === 0) return spinePatches;
    const seq = spineSeq;
    const run = async (): Promise<void> => {
      const read = spineRead;
      if (read === null || seq !== spineSeq) return;
      // A symlink's state is its target's: one whose target is in a
      // directory the change touched, or one this patch reads, is read again
      // with its own directory, when the spine holds that. The target's
      // directory itself is not read for it, so a closed one costs nothing.
      const reading = new Set(dirs);
      for (const e of read.edges) {
        if (e.kind !== "symlink") continue;
        const target = read.nodes.get(e.target);
        const at = parentDir(target?.path || e.target);
        if (!dirs.has(at) && !touched.has(at)) continue;
        const from = parentDir(e.source);
        if (spineHoldsChildren(from)) reading.add(from);
      }
      if (reading.size === 0) return;
      if (reading.size >= openedSpineDirs().length) {
        void loadSpine();
        return;
      }
      try {
        // Parents first, so a directory an earlier level of this patch
        // brings is in the spine by the time its own turn comes.
        for (const dir of [...reading].sort(byDepth)) {
          // A directory is read only when the spine holds it: what the walk
          // never drew, a patch never draws either.
          if (dir !== "" && !isFsDirectoryNode(read.nodes.get(dir))) continue;
          const level = await fetchSpineLevel(dir, seq);
          if (level === "superseded" || seq !== spineSeq || read !== spineRead) return;
          applySpineLevel(read, dir, level);
        }
      } catch {
        if (seq === spineSeq) void loadSpine();
        return;
      }
      publishSpine(read);
    };
    spinePatches = spinePatches.then(run, run);
    return spinePatches;
  }

  /// Shallower paths first, then by name.
  function byDepth(a: string, b: string): number {
    return (a === "" ? 0 : a.split("/").length) - (b === "" ? 0 : b.split("/").length) || a.localeCompare(b);
  }

  function isFsDirectoryNode(n: FsGraphNode | undefined): boolean {
    return n !== undefined && isFsDirectory(n);
  }

  /// Lays the children of `dir` as read now over what `read` held of them.
  /// An entry no longer there goes, with every edge that touches it, and a
  /// directory no longer there takes what was below it. An entry still there
  /// keeps the edges the level does not deliver again: those below an opened
  /// subdirectory, and those into it from elsewhere. What the level does
  /// deliver again replaces the old: `dir`'s own `contains` edges, its
  /// entries' symlink edges and their hardlinks, which are joined anew. A
  /// null level is a directory gone from disk, which takes everything below
  /// it. `dir`'s children count as read from then on.
  function applySpineLevel(
    read: SpineRead,
    dir: string,
    level: { nodes: FsGraphNode[]; edges: FsGraphEdge[] } | null,
  ): void {
    const fresh = new Set(level?.nodes.map((n) => n.id) ?? []);
    // A directory there now, by id; a file where a directory was is not one.
    const freshDirs = new Set(level?.nodes.filter(isFsDirectory).map((n) => n.id) ?? []);
    const entries = new Set<string>();
    const removed = new Set<string>();
    const dropBelow = (below: string): void => {
      for (const m of read.nodes.values()) if (spineBelow(below, m)) removed.add(m.id);
      for (const held of read.held) if (held === below || held.startsWith(`${below}/`)) read.held.delete(held);
    };
    for (const n of read.nodes.values()) {
      // A ghost is a symlink's missing target, which the symlink's own level
      // delivers, not an entry of the directory it names.
      if (!spineChildOf(dir, n) || n.kind === "ghost") continue;
      entries.add(n.id);
      if (!fresh.has(n.id)) removed.add(n.id);
      if (isFsDirectory(n) && !freshDirs.has(n.id)) dropBelow(n.path);
    }
    if (level === null) dropBelow(dir);
    // A node of the level that takes the place of a directory the spine
    // held, and is no directory, takes what was below it: a symlink's level
    // names its target that way once the target directory is gone (a
    // ghost), whichever of the two directories is read first.
    for (const n of level?.nodes ?? []) {
      const was = read.nodes.get(n.id);
      if (was !== undefined && isFsDirectory(was) && !isFsDirectory(n)) dropBelow(was.path);
    }
    for (const id of removed) read.nodes.delete(id);
    read.edges = read.edges.filter((e) => {
      if (removed.has(e.source) || removed.has(e.target)) return false;
      if (e.kind === "contains") return e.source !== dir;
      if (e.kind === "hardlink") return !entries.has(e.source) && !entries.has(e.target);
      return !entries.has(e.source);
    });
    if (level === null) {
      read.held.delete(dir);
      return;
    }
    for (const n of level.nodes) read.nodes.set(n.id, n);
    read.edges.push(...level.edges);
    read.held.add(dir);
  }

  /// Draws `read`: hardlinks joined over every node it holds, and a ghost no
  /// symlink points at any more dropped.
  function publishSpine(read: SpineRead): void {
    const pointed = new Set(read.edges.map((e) => e.target));
    for (const n of read.nodes.values()) {
      if (n.kind === "ghost" && !pointed.has(n.id)) read.nodes.delete(n.id);
    }
    const nodes = [...read.nodes.values()];
    read.edges = joinFsHardlinks(nodes, read.edges);
    spine = drawnSpine(nodes, read.edges);
  }

  /// The spine as the canvas takes it: each directory under the semantic
  /// graph's id (`directory:<path>`, the root ""), so the spine collapses
  /// onto the shared graph, which names a file by its bare path as the
  /// spine does.
  function drawnSpine(nodes: FsGraphNode[], edges: FsGraphEdge[]): DrawnGraph {
    const dirIds = new Set<string>();
    for (const n of nodes) {
      if (isFsDirectory(n)) dirIds.add(n.id);
    }
    const normalizeId = (id: string): string => (dirIds.has(id) ? directoryNodeId(id) : id);
    const drawnNodes = new Map<string, RenderedNode>();
    for (const mapped of mapFsNodes({ nodes })) {
      const id = normalizeId(mapped.id);
      drawnNodes.set(id, { ...mapped, id });
    }
    const drawnEdges = new Map<string, RenderedEdge>();
    for (const mapped of mapFsEdges({ nodes, edges })) {
      const edge = { ...mapped, source: normalizeId(mapped.source), target: normalizeId(mapped.target) };
      drawnEdges.set(graphEdgeKey(edge), edge);
    }
    return { nodes: [...drawnNodes.values()], edges: [...drawnEdges.values()] };
  }

  // The window's shared graph is asked for when the tab is first shown and
  // again whenever it is dropped under a shown tab (the view goes null). The
  // request is the window's, whoever asks: a second tab, or an inspector's
  // references, starts no second one. The load's own writes are untracked,
  // so a stream that keeps failing is not restarted from here.
  const graphDropped = $derived(graphData.view === null);
  $effect(() => {
    if (!visible) return;
    void graphDropped;
    untrack(() => void ensureGraphLoaded());
  });

  // A shown tab draws the view the window holds. A hidden tab takes nothing
  // and takes the current view when it is next shown. A view still
  // streaming is taken only by a tab that draws no whole graph (none yet,
  // or the empty one of an index that could not answer), so a reload keeps
  // the drawn graph on screen until its successor is complete, and a
  // dropped view (null) is never taken.
  $effect(() => {
    if (!visible) return;
    const view = graphData.view;
    const partial = graphData.partial;
    untrack(() => {
      if (view === null) return;
      if (taken !== null && taken.view === view && taken.partial === partial) return;
      const drawsWhole =
        kept !== null || (taken !== null && !taken.partial && taken.view.nodes.length > 0);
      if (partial && drawsWhole) return;
      taken = { view, partial };
      kept = null;
    });
  });

  // A hidden tab lets go of the view it took as soon as the window's graph
  // moves on, so the window holds one copy of the graph and not one more for
  // every tab last shown under an older one. It keeps the part it draws
  // from (`drawnPart`), which is all its canvas reads, so its layout is
  // there when it is shown again; from then on it does no work while the
  // graph changes under it.
  $effect(() => {
    if (visible) return;
    const view = graphData.view;
    untrack(() => {
      if (taken === null || taken.view === view) return;
      const whole = !taken.partial && taken.view.nodes.length > 0;
      kept = whole ? drawnPart(graph, scopedNodeIds, selectedId) : null;
      taken = null;
    });
  });

  // A selection waiting on the graph (`pendingSelectId`: an opener's, or the
  // one a reload or a moved tab restores) lands as soon as the drawn graph
  // holds its node, and is dropped when the whole graph does not hold it. A
  // tag, mention or language is known only to the index, so it waits out a
  // gated answer for the graph the window fetches once the index is ready.
  $effect(() => {
    const byId = nodeById;
    const whole = graphWhole;
    untrack(() => {
      const pending = graphState.pendingSelectId;
      if (pending !== null) {
        const resolved = resolveSelectId(pending, byId);
        if (resolved !== null) {
          selectedId = resolved;
          // A new selection opens Details; restoring the selected node keeps
          // the tab's saved visibility.
          if (graphState.selectedNodeId !== selectedId) graphState.inspectorOpen = true;
          graphState.pendingSelectId = null;
        } else if (whole) {
          graphState.pendingSelectId = null;
        }
      }
      // A tab fresh from an opener, on a directory: open it down to its
      // files, once.
      if (whole && openedFresh && !shownDirectoryFiles) {
        shownDirectoryFiles = true;
        showSelectedDirectoryFiles();
      }
    });
  });

  function mapFsNodes(fs: Pick<FsGraphResponse, "nodes">): RenderedNode[] {
    return fs.nodes.map((n): RenderedNode => {
      // A symlink is a file-like leaf: render it as a file node so the
      // canvas classifies it by name (binary for an extension-less link,
      // doc for a `.md` link, etc.). Without this branch a "symlink" kind
      // fell through to the `mention` catch-all below and drew as a yellow
      // contact silhouette. What makes it a symlink reads from its edge
      // to its target, which keeps the `symlink` kind.
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

  /// The spine's edges under the kinds the graph's own stream gives them, so
  /// an edge both deliver is one edge.
  function mapFsEdges(fs: Pick<FsGraphResponse, "nodes" | "edges">): RenderedEdge[] {
    const broken = new Set<string>();
    for (const n of fs.nodes) {
      if (n.broken) broken.add(n.id);
    }
    return fs.edges.map((e): RenderedEdge => {
      const edge: RenderedEdge = { source: e.source, target: e.target, kind: e.kind };
      if (e.kind === "symlink" && broken.has(e.target)) {
        edge.broken = true;
      }
      return edge;
    });
  }

  /// The stable identity of "what spine to fetch". The tab draws from the
  /// whole workspace: its selection and its depth only choose what of it is
  /// drawn, so neither fetches anything, and the one thing that does is a
  /// directory opened past what the spine holds (`spineReload`). The load
  /// effect tracks THIS key and runs `loadSpine()` untracked, so nothing
  /// `loadSpine()` reads on the way (the expanded set) is a trigger.
  const loadKey = $derived(`graph|${spineReload}`);

  /// Keep-alive load gating. A graph tab stays mounted while hidden,
  /// so "visible" does not mean "just mounted": this effect decides
  /// per activation whether the tab's spine is fetched:
  ///   - HIDDEN: never fetch (the whole point -- no background load).
  ///     If the load key changed while hidden, mark dirty so the next
  ///     activation refetches once. (A hidden watcher edit also sets
  ///     graphDirty, in the watcher effect below.)
  ///   - VISIBLE: fetch only on the first activation (lazy, not mount),
  ///     on a change of the key, or when dirty. Then latch
  ///     hasLoadedOnce, record the key, and clear dirty.
  /// `loadSpine()` runs untracked so its internal reads don't register as
  /// triggers; only `visible` + `loadKey` do. The shared graph has its own
  /// two effects above: asked for when shown, taken while shown.
  $effect(() => {
    // Read both triggers up front so the effect tracks exactly them.
    const show = visible;
    const key = loadKey;
    if (!show) {
      // Hidden: defer. A key change becomes a one-shot reload on the
      // next activation rather than a background fetch.
      if (hasLoadedOnce && key !== lastLoadedKey) {
        graphDirty = true;
        spineChanges = null;
      }
      return;
    }
    const keyChanged = key !== lastLoadedKey;
    if (!hasLoadedOnce || keyChanged) {
      hasLoadedOnce = true;
      lastLoadedKey = key;
      graphDirty = false;
      untrack(() => void loadSpine());
    } else if (graphDirty) {
      // Shown again after changes it missed: take them.
      untrack(takeSpineChanges);
    }
  });

  /// Takes the changes the spine has not taken yet: a patch of the
  /// directories they touched, or a whole fetch when one named no path,
  /// there is no spine yet to patch, or the last fetch failed. Syncs
  /// lastLoadedKey and clears dirty, since the spine is up to date once this
  /// lands.
  function takeSpineChanges(): void {
    lastLoadedKey = loadKey;
    graphDirty = false;
    // A whole fetch in flight may have read a directory before the change:
    // it takes them as a patch once it lands, rather than starting over,
    // which on a busy tree would never land.
    if (spineLoading) return;
    const paths = spineChanges;
    spineChanges = new Set();
    // A whole fetch since took them.
    if (paths !== null && paths.size === 0) return;
    const dirs = paths === null ? null : spineDirsTouched(paths);
    if (paths === null || dirs === null || spineRead === null || spineError !== null) {
      void loadSpine();
    } else {
      void patchSpine(dirs, spineParentsTouched(paths));
    }
  }

  // A change in the workspace. The shared graph fetches itself once after
  // the burst the change belongs to (`noteGraphChanged`, at the store's
  // signal sites) and this tab takes the answer; what the tab fetches here
  // is its own spine, and only what the change touched of it.
  $effect(() => {
    const nonce = graphReloadSignal.nonce;
    if (nonce === seenGraphReloadNonce) return;
    // Two changes signalled before this runs leave the paths of the later
    // one alone, so a skipped count is a change whose paths are not known.
    const skipped = nonce !== seenGraphReloadNonce + 1;
    seenGraphReloadNonce = nonce;
    untrack(() => {
      const paths = graphReloadSignal.paths;
      if (skipped || paths.length === 0) spineChanges = null;
      else if (spineChanges !== null) for (const path of paths) spineChanges.add(path);
      if (spineChanges !== null && spineChanges.size > SPINE_CHANGES_MAX) spineChanges = null;
    });
    if (!visible) {
      // Hidden: don't reload in the background. Remember it so the next
      // activation takes the changes once.
      graphDirty = true;
      return;
    }
    // Visible: once the burst is over. A tab hidden by then takes the
    // changes when it is next shown, as one hidden all along does.
    if (watchReloadTimer) clearTimeout(watchReloadTimer);
    watchReloadTimer = setTimeout(() => {
      watchReloadTimer = null;
      if (visible) takeSpineChanges();
      else graphDirty = true;
    }, 250);
  });

  /// Persist the live selection so it survives a window reload. The
  /// serializer writes `gn`/`gnl` from graphState.selectedNodeId/Label,
  /// and restore reads them back into selectedNodeId + pendingSelectId.
  /// App.svelte's layout-persist effect does not track the graph tab's
  /// selection, so this effect is the trigger. Mirror selectedId (the live,
  /// component-local source of truth, written by clicks AND the
  /// programmatic re-scope / load-resolution paths) into the tab fields
  /// and kick both persists (each debounces internally).
  let lastSyncedSelect: string | null = null;
  $effect(() => {
    const id = keptSelection(selectedId);
    // A restore (gn -> pendingSelectId) or re-scope resolves once the
    // graph holds its node; skip until then so we neither clobber the
    // restored selection with the initial null nor persist a transient
    // mid-resolve value. setSelected clears pendingSelectId, so user
    // clicks pass.
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
    // A spine request still in flight publishes nothing.
    spineSeq += 1;
  });

  /// Selection callback handed to GraphCanvas. Tapping a node
  /// flips the inspector open; background tap clears.
  function setSelected(id: string | null): void {
    depthFollowsSelection(id);
    selectedId = id;
    // A user tap is a definitive selection: drop any unresolved
    // pending auto-select (restore / re-scope) so the persist effect
    // above is free to capture this click.
    graphState.pendingSelectId = null;
    if (id !== null) graphState.inspectorOpen = true;
    // Surface the selection to the tab so the
    // tab strip can derive the title from the selected node's
    // label. We cache the label too so the title renders before
    // the graph data finishes reloading (e.g. after a hard
    // reload that round-trips the selection via URL hash).
    const kept = keptSelection(id);
    setGraphSelection(tab, kept, kept === null ? null : graphSelectionLabel(kept));
  }

  function graphSelectionLabel(id: string): string | null {
    const node = nodeById.get(id);
    if (node) return node.label ?? null;
    return null;
  }
</script>

<svelte:window
  onkeydowncapture={tabMenuKeys.capture}
  onkeydown={tabMenuKeys.bubble}
  onpointerdown={onTabMenuPointerDown}
/>

<!-- The graph is always a first-class TAB (mounted only by Pane.svelte
     with a `tab`): `graphState` is the tab and `visible` follows the
     `active` prop. -->
{@render graphContent()}

{#snippet graphContent()}
  <div
    class="graph-tab"
    class:active
    data-theme={surfaceThemeOverride("graph")}
    style={paletteStyle || undefined}
    oncontextmenu={onGraphContextMenu}
    role="tabpanel"
    aria-hidden={!active}
  >
  {#if tabMenuOpen}
    <!-- Graph-tab right-click bubble. Anchored to
         the tab-strip click position via clampMenu.
         Row shape follows the standard
         hamburger-menu pattern from other tabs (TerminalTab /
         FileEditorTab / FileBrowserSurface) -- `<button class="mbtn">`
         rows with optional icon + label + chord on the right; filters
         render vertically, one row per kind, with the kind colour as
         a dot + on/off cue via the `.on` class. -->
    <div
      class="tab-menu-bubble"
      role="menu"
      tabindex="-1"
      aria-label="graph tab menu"
      style={paletteStyle || undefined}
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
      <button
        type="button"
        class="mbtn graph-scope-row"
        role="menuitem"
        tabindex="-1"
        title={commandTitle("app.graph.scopeDetails")}
        onclick={openScopeHeaderInspector}
      >
        <span class="mbtn-icon" aria-hidden="true">
          <HardDrive size={16} strokeWidth={1.75} />
        </span>
        <span class="mbtn-label graph-scope-path">Workspace</span>
      </button>
      <div class="msep" role="separator"></div>
      <div
        class="mbtn depth-row"
        class:shallow={depthShallow}
        title={depthShallow
          ? "Nothing further to reveal from here"
          : depthDir !== null
            ? "Directory levels opened below the selected directory"
            : "Hops of references shown from the selected node"}
      >
        <span class="mbtn-icon" aria-hidden="true"></span>
        <span class="mbtn-label">Depth</span>
        <input
          type="range"
          min={depthMin}
          max={depthCap}
          step="1"
          value={depthValue}
          oninput={(e) => setDepth(+e.currentTarget.value)}
          disabled={depthShallow}
          onmousedown={(e) => e.stopPropagation()}
          aria-label="depth"
        />
        <span class="depth-value">
          {#if depthShallow}
            {depthValue} <span class="depth-cue">[max]</span>
          {:else}
            {depthValue}
          {/if}
        </span>
      </div>
      <div class="msep graph-filter-sep" role="separator"></div>
      <!-- One row per filter, in the words the launcher's Filters
           command lists as its options: the rows and the options come
           from one list. -->
      {#each GRAPH_FILTER_ROWS as filter (filter.kind)}
        {@const kind = filter.kind}
        <button
          type="button"
          class="mbtn filter-row"
          class:on={show[kind]}
          onclick={() => toggleGraphFilter(graphState, kind)}
          role="menuitemcheckbox"
          aria-checked={show[kind]}
        >
          <span
            class="filter-dot"
            class:filter-dot-off={!show[kind]}
            style="background:{show[kind] ? FILTER_COLORS[kind] : 'transparent'};border-color:{FILTER_COLORS[kind]}"
            aria-hidden="true"
          ></span>
          <span class="mbtn-label">{filter.label}</span>
          <span class="filter-count">{counts[kind]}</span>
        </button>
      {/each}
      <div class="msep" role="separator"></div>
      {#if panesHaveSides()}
        <button class="mbtn" role="menuitem" onclick={flipFromMenu}>
          <span class="mbtn-icon">
            <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">{commandTitle("app.pane.flip")}</span>
          <span class="mbtn-chord">{chordFor("app.pane.flip") ?? ""}</span>
        </button>
      {/if}
      <button class="mbtn" role="menuitem" onclick={closeFromMenu}>
        <span class="mbtn-icon">
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span class="mbtn-label">{commandTitle("app.tab.close")}</span>
        <span class="mbtn-chord">{chordFor("app.tab.close") ?? ""}</span>
      </button>
      <!-- The window's commands, after this graph's own. -->
      <div class="msep" role="separator"></div>
      <button class="mbtn" role="menuitem" onclick={openCommandsFromMenu}>
        <span class="mbtn-icon">
          <CommandIcon size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span class="mbtn-label">{launcherLabel}</span>
        <span class="mbtn-chord">{chordFor(LAUNCHER) ?? ""}</span>
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
        nodes={canvasNodes}
        edges={canvasEdges}
        visibleNodeIds={canvasVisibleNodeIds}
        visibleEdges={canvasVisibleEdges}
        focalIds={FOCAL_IDS}
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
      floating
      reserveSpace
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
          {#each scopeAncestors as crumb, i (i + ":" + crumb.key)}
            {#if i > 0}
              <span class="crumb-sep" aria-hidden="true">/</span>
            {/if}
            {#if crumb.current}
              <span class="crumb current" aria-current="true">{crumb.label}</span>
            {:else}
              <button
                type="button"
                class="crumb"
                onclick={crumb.go}
              >{crumb.label}</button>
            {/if}
          {/each}
        </nav>
      {/if}
      {#if selectedDraft}
        <!-- The drafts group or one draft. Neither is a workspace file:
             the body says where drafts are kept, and a draft with a file
             opens it in the editor, where it is saved or discarded. -->
        {@const draft = selectedDraft.row}
        {#if draft === null}
          <DraftInfoBody title="Drafts" />
        {:else}
          {@const draftFile = draft.path}
          <DraftInfoBody
            title={draft.name}
            path={draftFile}
            busy={draft.busy}
            onOpen={draftFile === null ? undefined : () => void openInActivePane(draftFile)}
          />
        {/if}
      {:else if selectedNode?.kind === "folder" && selectedNode.id === ""}
        <!-- Workspace root: same body the file browser hamburger
             menu's Directory row pops (WorkspaceInfoBody) so the
             whole-workspace config lives in one place across surfaces.
             Differentiated visually by GraphCanvas painting the
             "workspace" sub-kind in a darker fill with the HardDrive
             glyph.
             The workspace root is a regular directory inspector
             with both directory actions wired:
             "Show in File Browser" (revealPathInBrowser) and
             "Graph from here" (graphFromHere opens a new graph tab at
             the workspace root). variant defaults to inspector. -->
        <WorkspaceInfoBody
          onReveal={() => revealPathInBrowser("", { enter: true })}
          onSetAsScope={() => graphFromHere("", true)}
          onLanguageClick={openGraphForLanguage}
          onContactNavigate={openGraphForContact}
        />
      {:else if selectedNode && selectedNode.kind === "file" && isFileGhost}
        <!-- Ghost: a file node marked missing, a broken-link target.
             FileInfoBody can't render it; surface inline inside the
             shared Inspector header. -->
        {@const ghostKind = classifyFileKind(
          selectedNode.path,
          selectedNode.node_kind,
        ) as FileKind}
        <div class="ghost-body">
          <header class="head">
            <KindChip kind={ghostKind} path={selectedNode.path} block ghost />
          </header>
          <h3 class="title" title={selectedNode.path}>{selectedNode.label}</h3>
          <div class="path mono">{selectedNode.path}</div>
          <div class="missing">file does not exist (broken-link target)</div>
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
                // case uses onOpen above).
                () => revealPathInBrowser(inspectorSelection.path, { enter: true })
              : undefined
          }
          onNavigate={selectByPath}
          onContactNavigate={selectByPath}
          onOpenDirectory={
            // Language-inspector directory rows route through the
            // same "Graph from here" directory routing the folder
            // inspector uses: a new graph tab with the clicked
            // directory selected and opened.
            (path) => graphFromHere(path, true)
          }
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
                  // graph tab with that language selected, matching the
                  // file / directory path.
                  () => openGraphForLanguage(inspectorSelection.language)
                : inspectorSelection?.kind === "tag"
                  ? // The tag inspector's "Graph from here" opens a NEW
                    // graph tab with the tag selected, so the user can
                    // follow its neighbourhood beside this graph.
                    () =>
                      openGraphForTag(
                        inspectorSelection.nodeId,
                        inspectorSelection.label,
                      )
                  : inspectorSelection?.kind === "mention"
                    ? // The mention inspector's "Graph from here" always
                      // opens a NEW graph tab. A mention that resolves to a
                      // contact file opens it on that file; an unresolved
                      // one (no matching file) on the mention's own node,
                      // which shows every doc referencing the handle.
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
      {#if indexBuilding}
        · <span class="indexing" title="The workspace index is not ready; dead-end nodes may resolve once it completes.">{workspaceRecovering ? "workspace recovering…" : "indexing…"}</span>
      {/if}
    </span>
    <span class="hint">
drag to pan · scroll to zoom · click to select · double-click a directory to open it
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
     paused, so a re-shown graph resumes its exact transform. The host
     is absolutely positioned, not a flex child, so it takes no
     `flex: 1`; its own flex column lays out the body and the status
     bar. */
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
    position: relative;
    isolation: isolate;
    overflow-x: auto;
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  .canvas {
    flex: 1;
    min-height: 0;
    min-width: 200px;
    position: relative;
    overflow: hidden;
  }
  /* GraphCanvas mount: positioned absolute inside the relative
     .canvas parent, filling it. */
  .cy {
    position: absolute;
    inset: 0;
    /* Eases the opacity change when an error toggles `.dim`. */
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
    animation: graph-tab-menu-pop 260ms var(--ease-pop);
    transition: transform 200ms var(--ease-pop);
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
      transform 260ms var(--ease-pop);
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
