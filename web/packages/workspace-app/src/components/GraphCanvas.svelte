<script lang="ts">
  // Canvas + d3-force renderer for the chan graph.
  //
  // Why d3-force over cytoscape: cytoscape's per-frame pipeline (style-selector resolution,
  // SVG-icon bitmap compositing, scenegraph hit-testing) sits above
  // the d3-force simulation it wraps, and chews enough budget that
  // a 90-node graph never matches the Observable d3-force example's
  // smoothness. Rendering straight to a canvas - one fill + ring +
  // icon blit per node per tick - closes that gap.
  //
  // What GraphCanvas owns:
  //   - HTML5 canvas + animation loop (requestAnimationFrame)
  //   - d3-force simulation (charge / link / collide / x / y) with
  //     "infinite: true"-style alphaTarget bookkeeping so dragging
  //     a node re-heats the cluster and releasing settles it
  //   - hover / click / drag / pan / zoom interaction
  //   - focal pinning during the initial layout
  //   - icon pre-rasterisation per kind (chan's existing
  //     lucide-style glyphs decoded once to HTMLImageElement and
  //     drawn via ctx.drawImage)
  //   - label visibility: hidden by default; opt-in for the
  //     selected node and every first-degree neighbour
  //
  // What stays in GraphPanel.svelte:
  //   - scope picker + BFS to compute visibleNodeIds / visibleEdges
  //   - filter chips (link / tag / mention / img)
  //   - depth slider, inspector, scope history, hamburger menu

  import { onDestroy, onMount, tick } from "svelte";
  import {
    forceCenter,
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
    forceX,
    forceY,
    type Simulation,
  } from "d3-force";
  import type { GraphViewEdge, GraphViewNode } from "../api/types";
  import { draftsDir } from "../state/workspace.svelte";
  import { fileBucket } from "../state/kinds";
  import { GRAPH_PALETTE_DEFAULTS } from "../state/graphPalette.svelte";
  import { DEFAULT_FORCE, type GraphForce } from "../graph/force";
  import { containmentSpine, spineEdgeKey } from "../graph/containmentSpine";

  type RenderedEdgeKind =
    | "link"
    | "tag"
    | "mention"
    | "contains"
    | "language"
    | "group";
  type RenderedEdge = GraphViewEdge & { kind: RenderedEdgeKind };
  type RenderedNode = Extract<
    GraphViewNode,
    { kind: "file" | "tag" | "mention" | "language" | "folder" }
  >;
  type ExpansionFitRequest = { nonce: number; ids: string[] };

  // ---- props ------------------------------------------------------------

  type Props = {
    open: boolean;
    /// Suspend the animation loop without tearing the canvas down.
    /// Set by a keep-alive host (GraphPanel) when its tab is hidden:
    /// `open` LATCHES true once the graph is first shown (so the sim +
    /// pan/zoom transform survive a tab switch), and `paused` gates the
    /// rAF loop so a latched-but-hidden graph does zero background
    /// paint/sim. Unlike `open=false`, pausing never resets the
    /// transform or discards node arrays. Default false (always-on
    /// hosts like the Dashboard slide pass nothing).
    paused?: boolean;
    nodes: RenderedNode[];
    edges: RenderedEdge[];
    visibleNodeIds: Set<string>;
    visibleEdges: RenderedEdge[];
    focalIds: string[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onContextMenu?: (e: MouseEvent) => void;
    /// Double-clicking a node fires the "graph from here" action.
    /// The canvas only signals intent;
    /// the parent owns the rescope (it has access to the current
    /// selection's `path` / `isDir` and to `graphFromHere`).
    onSetAsScope?: () => void;
    /// Where the single focal node sits in the viewport. "bottom"
    /// (default) anchors it near the bottom edge so the cluster grows
    /// upward from it, so the workspace-root spine reads bottom-to-top.
    /// The Dashboard search-index graph and the main Graph tab both
    /// anchor at the bottom; "center" centers the focal instead and is
    /// available for callers that want it.
    focalAnchor?: "center" | "bottom";
    /// d3-force tuning. Defaults to DEFAULT_FORCE (../graph/force.ts),
    /// the values the live graph ships with. Only the standalone
    /// graph-tuner playground overrides this, driving the same shape
    /// live from sliders; every production caller omits it. Pass a NEW
    /// object to re-tune (the sim rebuilds + reheats on reference
    /// change).
    force?: GraphForce;
    /// Incremented by GraphPanel after a directory expansion. Fits the
    /// expanded directory, its parent, and the newly visible nodes without
    /// resetting the user's manual-pan ownership for later refreshes.
    expansionFitRequest?: ExpansionFitRequest | null;
  };
  let {
    open,
    paused = false,
    nodes,
    edges,
    visibleNodeIds,
    visibleEdges,
    focalIds,
    selectedId,
    onSelect,
    onContextMenu,
    onSetAsScope,
    focalAnchor = "bottom",
    force = DEFAULT_FORCE,
    expansionFitRequest = null,
  }: Props = $props();

  // ---- types: d3-shaped working copies ---------------------------------

  type DKind =
    | "doc"
    | "img"
    | "contact"
    | "source"
    | "binary"
    | "tag"
    | "mention"
    | "language"
    | "folder"
    | "workspace";
  type DNode = {
    id: string;
    label: string;
    kind: DKind;
    missing: boolean;
    isFocal: boolean;
    radius: number;
    /// Filesystem-hierarchy spine. `depth` is the path-segment count
    /// from the workspace root (workspace root = 0, top-level dirs /
    /// root files = 1, nested = 2+). Non-hierarchical nodes (tag /
    /// mention / language) get depth = -1 and are exempt from the
    /// depth-based forceY anchor; they float on the center force.
    /// `parentId` is the id of the parent directory node (the
    /// workspace-root marker is "" per chan-server's
    /// `directory_node_id("")`); `null` for the workspace root or
    /// for non-hierarchical nodes.
    depth: number;
    parentId: string | null;
    /// Per-directory indexing status surfaced by the Dashboard
    /// indexing slide. When set on a `folder` node the
    /// paint pass overrides the standard folder fill with the
    /// indexing palette (green/grey/pulsing-orange). Undefined for
    /// normal Graph-tab views.
    indexState?: "pending" | "indexed" | "indexing";
    // d3-force mutates these in-place; declared optional so the
    // first tick can initialise them.
    index?: number;
    x?: number; y?: number; vx?: number; vy?: number;
    fx?: number | null; fy?: number | null;
  };
  type DEdge = {
    source: string | DNode;
    target: string | DNode;
    kind: RenderedEdgeKind;
    broken?: boolean;
  };

  // ---- constants --------------------------------------------------------

  /// Node rendering radii. Doc nodes are slightly larger so the file
  /// chrome reads as the load-bearing kind at a glance; tag / mention
  /// / image / contact sit a notch smaller. Backlink mapData scaling
  /// is applied on top in `renderRadius`.
  const RADIUS_BASE = 5;
  const RADIUS_DOC = 7;
  /// Directory nodes sit a notch above the leaf base (but below the
  /// doc/workspace hub size) so they read as clearly clickable folder
  /// targets without dominating the graph. Slightly bigger, not much.
  const RADIUS_DIR = 6;
  const RADIUS_HUB_SCALE = 1.4;
  /// The workspace-root anchor stays clearly 1.5x larger than any
  /// other directory, INCLUDING dirs that the backlink ramp has
  /// already pushed to `RADIUS_DIR * RADIUS_HUB_SCALE`. Compute
  /// against the worst-case dir radius so the 1.5x gap survives the
  /// backlink ramp, and exempt workspace from the ramp itself so the
  /// hub stays exactly this size regardless of how many things link
  /// to it.
  const RADIUS_WORKSPACE = RADIUS_DIR * RADIUS_HUB_SCALE * 1.5;

  /// Icon glyph occupies this fraction of the rendered diameter.
  const ICON_FRACTION = 0.6;

  /// Focus-on-select emphasis. Selecting a node spotlights its
  /// 1st-degree neighbourhood: the selected node + its direct neighbours
  /// stay full-strength (and keep their labels), every other node fades
  /// to FOCUS_DIM_NODE, the edges touching the selection light up at
  /// FOCUS_LIT_EDGE, and all other edges recede to FOCUS_DIM_EDGE. With
  /// nothing selected every node is full-strength and edges draw at
  /// EDGE_ALPHA.
  const EDGE_ALPHA = 0.18;
  const FOCUS_DIM_NODE = 0.2;
  const FOCUS_DIM_EDGE = 0.05;
  const FOCUS_LIT_EDGE = 0.9;

  /// d3-force tuning lives in ../graph/force.ts (DEFAULT_FORCE), the
  /// single source of truth shared with the graph-tuner playground.
  /// Callers can override it via the `force` prop (below); every
  /// production caller passes nothing and gets DEFAULT_force.

  /// Stroke ring colour for non-missing nodes. Reads from the page
  /// background so touching nodes still separate visually.
  let strokeColor = "#1c1c1e";
  /// Body text + label outline (halo). Read from theme on each
  /// paint pass.
  let textColor = "#ebebf0";

  // ---- state ------------------------------------------------------------

  let canvas: HTMLCanvasElement | undefined = $state();
  let containerEl: HTMLDivElement | undefined = $state();
  let resizeObs: ResizeObserver | null = null;
  let sim: Simulation<DNode, DEdge> | null = null;
  let rafId: number | null = null;
  let dNodes: DNode[] = [];
  let dEdges: DEdge[] = [];
  let nodeById = new Map<string, DNode>();
  let adjacency = new Map<string, Set<string>>();
  /// Child-node id -> parent-directory-node id, from the `contains` edges.
  /// Drives the focus-on-select containment spine (path home to the root).
  let containsParent = new Map<string, string>();
  let visibleEdgeRefs: DEdge[] = [];

  /// Pan + zoom transform. Same shape as d3-zoom's: viewportPx =
  /// worldCoord * k + (tx, ty). Updated by mouse wheel + drag-pan
  /// handlers; consumed once per paint pass.
  let transform = { x: 0, y: 0, k: 1 };

  /// Auto-fit state. While `refitUntil` is in the future the rAF
  /// loop recomputes `fitTarget` each frame from the current bbox
  /// so the view tracks the cluster as it relaxes after a scope /
  /// filter / depth change. `fitTarget` is the ease-in destination
  /// for transform; null = no easing in flight.
  let refitUntil = 0;
  let fitTarget: { x: number; y: number; k: number } | null = null;
  let expansionRefit: { until: number; ids: Set<string> } | null = null;
  let seenExpansionFitNonce = 0;
  /// Once the user has manually panned, zoomed, or dragged a node,
  /// the view belongs to them. Periodic re-renders of the same node
  /// set (e.g., the Dashboard indexing slide polling
  /// `/api/indexing/state` every 3s, which produces fresh array
  /// references with no structural change) must not snap the view
  /// back to fit-content. The flag stays set until the node SET
  /// genuinely differs from what's on screen, which is clearly a new
  /// dataset where a refit IS the right thing.
  let userInteracted = false;
  /// When `start()` runs before the host has been measured
  /// (carousel mounts GraphCanvas before slide 2 is visible, so
  /// the first `resize()` clamps the canvas to 0x0), the initial
  /// `fitToContent` returns null and the view stays at the
  /// origin-zoom-1 placeholder. `resize()` flips this flag back
  /// off the moment the container reports nonzero dimensions and
  /// re-runs the fit so the spine ends up framed in the viewport
  /// without requiring a manual zoom.
  let pendingInitialFit = false;

  /// Pointer interaction state. dragId: id of the node currently
  /// being pulled by the cursor (fixes its fx/fy); panStart: mouse
  /// origin + transform snapshot at the moment the user started a
  /// background-pan gesture. hoverId: node under the cursor for
  /// the hover ring + cursor change.
  let dragId: string | null = null;
  let panStart: { x: number; y: number; tx: number; ty: number } | null = null;
  let hoverId = $state<string | null>(null);
  /// Position of the mousedown that started the current gesture.
  /// Used at mouseup to decide whether the gesture was a tap
  /// (movement under a few pixels → onSelect) versus a drag.
  let downAt: { x: number; y: number } | null = null;
  /// True once a press on a node has actually moved past
  /// `DRAG_ACTIVATE_PX` and become a drag. A press alone must not pin the
  /// node or re-heat the simulation: on a large graph the alpha injected by
  /// a mere click takes hundreds of ticks to decay, which reads as the whole
  /// cluster shaking for seconds after a plain selection. Pinning and
  /// re-heating are therefore deferred to the first qualifying move.
  let dragActive = false;

  /// Repaint gate. The rAF loop is free-running, but a graph that is not
  /// moving must not re-rasterise thousands of discs and edges 60 times a
  /// second. `dirty` marks "something changed that the canvas has not drawn
  /// yet"; `markDirty()` is called from every state transition the paint
  /// pass observes. Continuous sources (a live simulation, an in-flight fit
  /// ease, the indexing pulse) are detected per frame in `loop()` instead,
  /// since they change on their own schedule.
  let dirty = true;
  function markDirty(): void {
    dirty = true;
  }

  /// Below this alpha d3-force has stopped its own timer and node positions
  /// are fixed, so there is nothing new to draw. Mirrors d3's internal
  /// `alphaMin` default.
  const SIM_ALPHA_MIN = 0.001;

  /// Structural revision of the working set. Bumped by
  /// `rebuildWorkingSet()` so paint-time caches keyed on it invalidate
  /// exactly when nodes or edges actually change, and not on every frame.
  let workingSetRev = 0;

  /// True while any node carries `indexState: "indexing"`. Those discs
  /// breathe on a timer, so they are the one thing that must keep painting
  /// even when the layout has settled and nothing else has changed.
  let hasIndexingPulse = false;

  // ---- icon rasterisation ----------------------------------------------

  /// Per-kind icon raster. Decoded from chan's existing
  /// lucide-style 24px SVG paths into HTMLImageElement so paint can
  /// blit each glyph with one ctx.drawImage call per node.
  /// Rebuilt whenever the theme background colour changes (the icon
  /// stroke is baked in at build time).
  const iconImages: Partial<Record<DKind, HTMLImageElement>> = {};
  /// Parallel set stroked in the muted text-secondary colour for
  /// "ghost" rendering - broken-link targets and unresolved
  /// mentions. The regular variant is stroked in the page bg so
  /// it knocks out against the kind-coloured disc; the ghost
  /// variant is stroked in textSec so it reads against the empty
  /// bgCard fill the ghost ring sits over.
  const ghostIconImages: Partial<Record<DKind, HTMLImageElement>> = {};

  const PATH_DOC =
    `<path d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'/>` +
    `<polyline points='14 3 14 8 19 8'/>`;
  const PATH_CONTACT =
    `<circle cx='12' cy='9' r='3.4'/>` +
    `<path d='M5 20c.6-3.6 3.6-6 7-6s6.4 2.4 7 6'/>`;
  const PATH_IMG =
    `<rect x='3.5' y='4' width='17' height='16' rx='2'/>` +
    `<circle cx='9' cy='10' r='1.6'/>` +
    `<polyline points='20 16 15 11 5 19'/>`;
  const PATH_FOLDER =
    `<path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>`;
  /// Lucide HardDrive - used as the workspace-root glyph so the node
  /// reads as the storage anchor, distinct from any other directory.
  const PATH_WORKSPACE =
    `<line x1='22' y1='12' x2='2' y2='12'/>` +
    `<path d='M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'/>` +
    `<line x1='6' y1='16' x2='6.01' y2='16'/>` +
    `<line x1='10' y1='16' x2='10.01' y2='16'/>`;

  function svgStrokeIcon(inner: string, stroke: string): string {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' ` +
      `viewBox='0 0 24 24' fill='none' stroke='${stroke}' stroke-width='2.4' ` +
      `stroke-linecap='round' stroke-linejoin='round'>${inner}</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
  function svgTextIcon(glyph: string, fill: string): string {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' ` +
      `viewBox='0 0 24 24'>` +
      `<text x='12' y='18' text-anchor='middle' ` +
      `font-family='-apple-system, system-ui, sans-serif' ` +
      `font-size='20' font-weight='800' fill='${fill}'>${glyph}</text>` +
      `</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function loadIcon(
    bucket: Partial<Record<DKind, HTMLImageElement>>,
    kind: DKind,
    dataUrl: string,
  ): void {
    const img = new Image();
    img.src = dataUrl;
    // The decode resolves asynchronously; until it lands, paint
    // skips this kind's icon. The disc + ring still render.
    img.decode?.().then(markDirty).catch(() => { /* fall through; .complete remains true once loaded */ });
    bucket[kind] = img;
  }

  /// The rasterised icon set is a function of exactly two theme inputs
  /// (the page bg the glyphs knock out against, and the ghost stroke),
  /// so a hue-only palette change must NOT re-rasterise: rebuilding
  /// twenty byte-identical images per colour-picker pointer move is the
  /// cost this key exists to skip.
  let lastIconKey: string | null = null;

  function rebuildIcons(bg: string, ghostStroke: string): void {
    const iconKey = `${bg}\n${ghostStroke}`;
    if (iconKey === lastIconKey) return;
    lastIconKey = iconKey;
    // Regular variants - stroked in the page-bg so the icon
    // "knocks out" against the kind-coloured disc. mention reuses
    // the contact silhouette because a fuzzy-resolved @@name IS
    // a contact for every UX purpose; the only difference between
    // contact and mention kinds is whether the on-disk file
    // exists as a direct match versus a near match.
    loadIcon(iconImages, "doc", svgStrokeIcon(PATH_DOC, bg));
    loadIcon(iconImages, "img", svgStrokeIcon(PATH_IMG, bg));
    loadIcon(iconImages, "contact", svgStrokeIcon(PATH_CONTACT, bg));
    loadIcon(iconImages, "tag", svgTextIcon("#", bg));
    loadIcon(iconImages, "mention", svgStrokeIcon(PATH_CONTACT, bg));
    loadIcon(iconImages, "language", svgTextIcon("{ }", bg));
    loadIcon(iconImages, "folder", svgStrokeIcon(PATH_FOLDER, bg));
    // Source + binary file-class buckets. Source code uses the same
    // doc/file glyph rendered against the royalblue fill: the chrome
    // reads as "file" while the colour discriminates the class.
    // Binary uses the same glyph against the grey fill so users see
    // "yes it's a file but it's not editable" via colour alone.
    loadIcon(iconImages, "source", svgStrokeIcon(PATH_DOC, bg));
    loadIcon(iconImages, "binary", svgStrokeIcon(PATH_DOC, bg));
    // Workspace root: stroke against the dark fill so the glyph still
    // reads; uses text-secondary (lifted off the bgCard fill that
    // matches the panel background).
    loadIcon(iconImages, "workspace", svgStrokeIcon(PATH_WORKSPACE, ghostStroke));
    // Ghost variants - stroked in text-secondary so the icon
    // reads against the empty bgCard fill the ghost ring sits
    // over. Same paths as the regular set; only the stroke
    // colour differs.
    loadIcon(ghostIconImages, "doc", svgStrokeIcon(PATH_DOC, ghostStroke));
    loadIcon(ghostIconImages, "img", svgStrokeIcon(PATH_IMG, ghostStroke));
    loadIcon(ghostIconImages, "contact", svgStrokeIcon(PATH_CONTACT, ghostStroke));
    loadIcon(ghostIconImages, "tag", svgTextIcon("#", ghostStroke));
    loadIcon(ghostIconImages, "mention", svgStrokeIcon(PATH_CONTACT, ghostStroke));
    loadIcon(ghostIconImages, "language", svgTextIcon("{ }", ghostStroke));
    loadIcon(ghostIconImages, "folder", svgStrokeIcon(PATH_FOLDER, ghostStroke));
    loadIcon(ghostIconImages, "source", svgStrokeIcon(PATH_DOC, ghostStroke));
    loadIcon(ghostIconImages, "binary", svgStrokeIcon(PATH_DOC, ghostStroke));
    loadIcon(ghostIconImages, "workspace", svgStrokeIcon(PATH_WORKSPACE, ghostStroke));
  }

  // ---- theme ------------------------------------------------------------

  type ThemeColors = {
    bg: string;
    bgCard: string;
    text: string;
    textSec: string;
    doc: string;
    img: string;
    tag: string;
    mention: string;
    language: string;
    accent: string;
    /// Directory node fill (filesystem graph mode).
    folder: string;
    /// Source-code file fill. Royalblue; source is its own bucket
    /// (distinct from binary's grey) so the markdown / source /
    /// binary / media split reads clearly.
    source: string;
    /// Binary file fill. Grey (darker than --g-folder so binary
    /// nodes don't visually collapse into directory nodes).
    binary: string;
    /// Drafts directory node fill. Pulls from --fb-drafts-fg so the
    /// graph + the FB row + the inspector header all render the same
    /// yellow tint.
    drafts: string;
  };

  function readTheme(host: HTMLElement): ThemeColors {
    // Default hexes come from the single palette definition; the
    // literal-CSS copies in App.svelte / GraphTuner.svelte are asserted
    // equal to it, so a retune can't land in one place only.
    const palette = GRAPH_PALETTE_DEFAULTS.dark;
    const cs = getComputedStyle(host);
    const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
    return {
      bg: v("--bg", "#1c1c1e"),
      bgCard: v("--bg-card", "#232325"),
      text: v("--text", "#ebebf0"),
      textSec: v("--text-secondary", "#8e8e93"),
      doc: v("--g-doc", palette.doc),
      img: v("--g-img", palette.img),
      tag: v("--g-tag", palette.tag),
      mention: v("--g-contact", v("--warn-text", "#e3b341")),
      language: v("--g-language", palette.language),
      accent: v("--accent", "#3fb950"),
      folder: v("--g-folder", palette.folder),
      // Colour scheme: source vs binary split. Markdown is orange
      // (--g-doc); source code royalblue; binary darker grey
      // (distinct from --g-folder); media purple (--g-img).
      source: v("--g-source", palette.source),
      binary: v("--g-binary", palette.binary),
      // Drafts tint pulled from the same CSS variable as the FB row +
      // the inspector chip.
      drafts: v("--fb-drafts-fg", "#e3b341"),
    };
  }

  const paletteSeed = GRAPH_PALETTE_DEFAULTS.dark;
  let theme: ThemeColors = $state({
    bg: "#1c1c1e", bgCard: "#232325", text: "#ebebf0", textSec: "#8e8e93",
    doc: paletteSeed.doc, img: paletteSeed.img, tag: paletteSeed.tag,
    mention: "#e3b341", language: paletteSeed.language, accent: "#3fb950",
    folder: paletteSeed.folder, source: paletteSeed.source,
    binary: paletteSeed.binary, drafts: "#e3b341",
  });

  /// Track `prefers-reduced-motion` so the indexing-state pulse can
  /// fall back to a flat mid-strength
  /// alpha for users who opt out of motion. Initialised in
  /// `onMount` so SSR-style first paint stays neutral.
  let reduceMotion = $state(false);

  function refreshTheme(): void {
    if (!containerEl) return;
    const next = readTheme(containerEl);
    theme = next;
    strokeColor = next.bg;
    textColor = next.text;
    rebuildIcons(next.bg, next.textSec);
    markDirty();
  }

  /// Palette colour for a file/document node kind. Mirrors the
  /// node-fill mapping in the paint pass so `link` edges
  /// can be stroked in the SOURCE document's hue: a markdown link is
  /// orange (--g-doc), a source-file link royalblue (--g-source), and
  /// so on. Non-file kinds (tag / mention / language / folder / workspace)
  /// fall back to the doc colour, since a `link` edge should originate
  /// from a document; the fallback keeps a stray edge visible rather
  /// than invisible.
  function fileKindColor(kind: DKind): string {
    switch (kind) {
      case "doc":
        return theme.doc;
      case "img":
        return theme.img;
      case "source":
        return theme.source;
      case "binary":
        return theme.binary;
      case "contact":
        return theme.mention;
      default:
        return theme.doc;
    }
  }

  // ---- node classification + data assembly -----------------------------

  // File nodes bucket into markdown / source / binary / media / contact
  // via the shared `fileBucket` (state/kinds.ts). The bubble side of the
  // inspector reads the same classifier so the node fill and the kind
  // chip stay in lockstep (a `.rs` source node opens a source-blue
  // bubble, not a document-orange one).

  /// Backlink counts per node - used to size hubs slightly larger.
  /// Pre-counted at assembly so the paint pass doesn't walk edges
  /// every frame.
  let backlinks: Map<string, number> = new Map();
  let maxBacklinks = 0;

  function rebuildAdjacency(): void {
    adjacency = new Map();
    containsParent = new Map();
    backlinks = new Map();
    maxBacklinks = 0;
    for (const e of edges) {
      let a = adjacency.get(e.source);
      if (!a) { a = new Set(); adjacency.set(e.source, a); }
      a.add(e.target);
      let b = adjacency.get(e.target);
      if (!b) { b = new Set(); adjacency.set(e.target, b); }
      b.add(e.source);
      // `contains` runs parent dir -> child; edge endpoints are still
      // string ids at rebuild time (before the force sim swaps in node
      // refs), matching the adjacency keys above.
      if (e.kind === "contains") containsParent.set(e.target, e.source);
      const c = (backlinks.get(e.target) ?? 0) + 1;
      backlinks.set(e.target, c);
      if (c > maxBacklinks) maxBacklinks = c;
    }
  }

  function renderRadius(kind: DKind, id: string): number {
    // Workspace root is the structural anchor of the whole graph - per
    // It is 1.5x every other directory so the hub reads at a
    // glance. Doc nodes stay at the prior RADIUS_DOC; folder
    // (non-workspace) nodes stay at RADIUS_DIR.
    const base =
      kind === "workspace"
        ? RADIUS_WORKSPACE
        : kind === "doc"
          ? RADIUS_DOC
          : kind === "folder"
            ? RADIUS_DIR
            : RADIUS_BASE;
    // Workspace skips the backlink ramp. RADIUS_WORKSPACE already
    // accounts for the max-scaled dir size, so further inflating it
    // via backlinks (which the workspace root always has the most of)
    // would dominate the canvas. Pin workspace to the base; the 1.5x
    // gap stays visible at every backlink density.
    if (kind === "workspace") return base;
    if (maxBacklinks <= 0) return base;
    const bl = backlinks.get(id) ?? 0;
    // Linear ramp from base to base*RADIUS_HUB_SCALE across the
    // observed backlink range. Anything heavily-linked gets a
    // visible bump; leaf nodes stay at the base size.
    const t = bl / maxBacklinks;
    return base * (1 + (RADIUS_HUB_SCALE - 1) * t);
  }

  /// Build the d3 working set from the latest props. Reuses existing
  /// DNodes when ids match (preserves position + velocity through a
  /// scope/depth tick); creates fresh ones for newly-visible ids and
  /// drops any whose id left the visible set.
  /// Derive a node's filesystem depth + parent-directory id from its
  /// kind + path. Workspace root (folder
  /// id "") sits at depth 0; top-level files / directories at
  /// depth 1; nested at depth = parent depth + 1. Non-hierarchical
  /// node kinds (tag / mention / language) return `depth: -1` so
  /// the layout forces skip them - those nodes float on the
  /// existing center force without a depth anchor.
  function nodeHierarchy(n: RenderedNode): {
    depth: number;
    parentId: string | null;
  } {
    if (n.kind === "tag" || n.kind === "mention" || n.kind === "language") {
      return { depth: -1, parentId: null };
    }
    if (n.kind === "folder") {
      // Workspace root marker emitted by chan-server as
      // `directory_node_id("")` → id "". Sits at depth 0 with no
      // parent.
      if (n.id === "" || n.path === "") {
        return { depth: 0, parentId: null };
      }
      const segs = n.path.split("/").filter((s) => s.length > 0);
      const depth = segs.length;
      const parentSegs = segs.slice(0, -1);
      const parentPath = parentSegs.join("/");
      const parentId = parentPath === ""
        ? ""
        : `directory:${parentPath}`;
      return { depth, parentId };
    }
    // File / media node: depth = directory depth + 1; parent is
    // the directory node id at the path-without-basename.
    const filePath = n.path ?? "";
    const segs = filePath.split("/").filter((s) => s.length > 0);
    const parentSegs = segs.slice(0, -1);
    const depth = segs.length;
    const parentPath = parentSegs.join("/");
    const parentId = parentPath === ""
      ? ""
      : `directory:${parentPath}`;
    return { depth, parentId };
  }

  function rebuildWorkingSet(): { added: DNode[]; removed: DNode[] } {
    const newById = new Map<string, DNode>();
    const added: DNode[] = [];
    const removed: DNode[] = [];
    const focalSet = new Set(focalIds);
    for (const n of nodes) {
      if (!visibleNodeIds.has(n.id)) continue;
      const kind: DKind = n.kind === "file"
        ? fileBucket(n.path, n.node_kind)
        : n.kind === "tag" ? "tag"
          : n.kind === "mention" ? "mention"
            : n.kind === "folder" && n.id === ""
              ? "workspace"
              : n.kind;
      const existing = nodeById.get(n.id);
      const missing = n.kind === "file" && Boolean(n.missing);
      const isFocal = focalSet.has(n.id);
      const radius = renderRadius(kind, n.id);
      const { depth, parentId } = nodeHierarchy(n);
      // Only folder nodes carry an indexState; everything else gets
      // undefined and the paint pass falls back to the standard
      // kind-fill.
      const indexState = n.kind === "folder" ? n.indexState : undefined;
      if (existing) {
        existing.label = n.label;
        existing.kind = kind;
        existing.missing = missing;
        existing.isFocal = isFocal;
        existing.radius = radius;
        existing.depth = depth;
        existing.parentId = parentId;
        existing.indexState = indexState;
        newById.set(n.id, existing);
      } else {
        const fresh: DNode = {
          id: n.id, label: n.label, kind, missing,
          isFocal, radius, depth, parentId, indexState,
        };
        newById.set(n.id, fresh);
        added.push(fresh);
      }
    }
    for (const [id, n] of nodeById) {
      if (!newById.has(id)) removed.push(n);
    }
    // Seed fresh node positions near a visible neighbour so they
    // grow out of the cluster on a depth-bump rather than popping
    // in from the origin and being yanked across the canvas by
    // the spring forces.
    for (const a of added) {
      const adj = adjacency.get(a.id);
      let anchor: DNode | null = null;
      if (adj) {
        for (const nb of adj) {
          const ex = nodeById.get(nb);
          if (ex && ex.x != null && ex.y != null) {
            anchor = ex;
            break;
          }
        }
      }
      if (anchor) {
        a.x = anchor.x! + (Math.random() - 0.5) * 40;
        a.y = anchor.y! + (Math.random() - 0.5) * 40;
      } else {
        // No anchor available (first run or fully disconnected
        // component): drop into a 600x600 box around origin and
        // let the sim settle it.
        a.x = (Math.random() - 0.5) * 600;
        a.y = (Math.random() - 0.5) * 600;
      }
    }
    // Pin focal nodes. Single-focus scopes stay centered at origin;
    // multi-file/directory scopes fan their seeds around a small ring so
    // they repel from distinct starting points instead of stacking.
    const focalPositions = new Map<string, { x: number; y: number }>();
    if (focalIds.length === 1) {
      focalPositions.set(focalIds[0], { x: 0, y: 0 });
    } else if (focalIds.length > 1) {
      const radius = Math.max(70, Math.min(220, focalIds.length * 10));
      focalIds.forEach((id, i) => {
        const angle = (Math.PI * 2 * i) / focalIds.length - Math.PI / 2;
        focalPositions.set(id, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      });
    }
    for (const n of newById.values()) {
      const pos = focalPositions.get(n.id);
      if (pos) {
        n.fx = pos.x;
        n.fy = pos.y;
      } else if (n.fx != null || n.fy != null) {
        // Was a focal; the new prop set demotes it. Release.
        n.fx = null;
        n.fy = null;
      }
    }
    nodeById = newById;
    dNodes = [...newById.values()];
    // Rebuild edges from `edges` (the full set), keyed by string
    // ids until d3-force's forceLink resolves them to objects on
    // its next tick.
    dEdges = [];
    visibleEdgeRefs = [];
    const visibleSet = new Set<string>();
    for (const e of visibleEdges) {
      visibleSet.add(`${e.source}|${e.target}|${e.kind}`);
    }
    for (const e of edges) {
      const key = `${e.source}|${e.target}|${e.kind}`;
      // Only feed the sim edges whose endpoints are visible. The
      // visibleEdges prop already encodes the chip-filter logic;
      // we cross-check the endpoint set here in case it lags by a
      // tick.
      if (!newById.has(e.source) || !newById.has(e.target)) continue;
      const de: DEdge = {
        source: e.source, target: e.target, kind: e.kind, broken: e.broken,
      };
      dEdges.push(de);
      if (visibleSet.has(key)) visibleEdgeRefs.push(de);
    }
    // Nodes and edges just changed identity, so every paint-time cache
    // keyed on the working set is now stale and the canvas owes a frame.
    workingSetRev++;
    hasIndexingPulse = false;
    for (const n of dNodes) {
      if (n.indexState === "indexing") { hasIndexingPulse = true; break; }
    }
    markDirty();
    return { added, removed };
  }

  // ---- sim plumbing -----------------------------------------------------

  function buildSim(): void {
    if (!canvas) return;
    sim?.stop();
    sim = forceSimulation<DNode>(dNodes)
      .force(
        "link",
        forceLink<DNode, DEdge>(dEdges)
          .id((d) => d.id)
          .distance((d) =>
            d.kind === "link" ? force.linkDistance : force.linkDistanceTag,
          )
          .strength(force.linkStrength),
      )
      .force("charge", forceManyBody<DNode>().strength(force.chargeStrength))
      .force(
        "collide",
        forceCollide<DNode>().radius((d) => d.radius + force.collidePad),
      )
      .force("x", forceX<DNode>(0).strength(force.centerStrength))
      // Filesystem-hierarchy spine:
      //   * Hierarchical nodes (file / folder / media) get a
      //     depth-anchored forceY pulling each toward
      //     `-depth * hierarchyYSpacing` so the layout reads
      //     bottom-to-top as workspace-root → top-level dirs → nested
      //     dirs → files. The workspace root (depth 0) settles at
      //     the BOTTOM and the containment spine grows UPWARD from it.
      //     Non-hierarchical nodes (tag / mention / language;
      //     depth = -1) keep the weak center force.
      //   * A custom parent-anchored forceX pulls each
      //     hierarchical node toward its parent directory's X
      //     position, so siblings under the same parent cluster
      //     together. The existing `contains` edges stay in the
      //     link force; the parent-X anchor reinforces the
      //     hierarchy without removing the link spring's
      //     contribution.
      .force(
        "y",
        forceY<DNode>((d) => {
          if (d.depth < 0) return 0;
          // Negative pull so deeper nodes rise ABOVE their
          // ancestors; the workspace root (depth 0) anchors the bottom.
          return -d.depth * force.hierarchyYSpacing;
        }).strength((d) =>
          d.depth < 0 ? force.centerStrength : force.hierarchyYStrength,
        ),
      )
      .force("parentX", parentXForce(force.parentXStrength))
      .velocityDecay(force.velocityDecay)
      .alpha(1)
      .alphaTarget(0)
      // The animation loop workspaces painting independently; the sim
      // just needs to mutate positions. No-op on tick keeps us from
      // doing per-tick work twice (rAF + tick callback).
      .on("tick", () => {});
  }

  /// Parent-anchored X force. Each hierarchical node (depth >= 0)
  /// with a known parent gets
  /// pulled toward its parent's current X position. The pull is
  /// proportional to `strength * alpha` so the simulation
  /// converges as alpha decays. Non-hierarchical nodes + nodes
  /// whose parent is missing from the working set are skipped.
  function parentXForce(strength: number) {
    let initialized: DNode[] = [];
    function force(alpha: number) {
      for (const node of initialized) {
        if (node.depth < 0) continue;
        if (node.parentId === null) continue;
        const parent = nodeById.get(node.parentId);
        if (!parent || parent.x == null) continue;
        const nodeX = node.x ?? 0;
        const dx = parent.x - nodeX;
        node.vx = (node.vx ?? 0) + dx * strength * alpha;
      }
    }
    force.initialize = (n: DNode[]) => {
      initialized = n;
    };
    return force;
  }

  /// Re-warm with a fresh `dNodes` / `dEdges` set without
  /// reconstructing the simulation. d3-force keeps node positions
  /// across `nodes(...)` swaps when objects are reused, which is
  /// the entire point of preserving DNode identity in
  /// `rebuildWorkingSet`. Pass a higher alpha for full-rebuild
  /// gestures (scope change), a smaller one for incremental
  /// depth bumps.
  function rewarmSim(alpha: number): void {
    if (!sim) {
      buildSim();
      return;
    }
    sim.nodes(dNodes);
    const link = sim.force("link") as unknown as {
      links(ls: DEdge[]): unknown;
    } | undefined;
    if (link && typeof link.links === "function") link.links(dEdges);
    sim.alpha(alpha).restart();
  }

  // ---- canvas sizing + DPR ----------------------------------------------

  function resize(): void {
    if (!canvas || !containerEl) return;
    const r = containerEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    markDirty();
    // setTransform inside paint() applies the DPR scaling along
    // with the user's pan/zoom, so we don't bake it here.
    // When GraphCanvas is hosted inside a hidden carousel slide, the
    // first resize() runs against a 0x0 rect and start()'s initial
    // fit returns null. Replay the fit now that the host has a real
    // size so the spine ends up framed in the viewport without a
    // manual zoom.
    if (pendingInitialFit && r.width > 0 && r.height > 0) {
      pendingInitialFit = false;
      transform = { x: r.width / 2, y: r.height / 2, k: 1 };
      fitToContent(24);
      scheduleRefit(900);
    }
  }

  /// Translate a viewport-space pixel into model/world space using
  /// the current pan + zoom transform.
  function screenToWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - transform.x) / transform.k,
      y: (py - transform.y) / transform.k,
    };
  }

  /// Forgiving-clicks: separate drag-detect from click-to-select hit
  /// radii. The drag/pan disambiguation uses a tight 4px slack (so
  /// clicking on empty canvas near a node still reads as "pan", not
  /// "grab"). The click-to-select tap uses a wider 10px slack so
  /// users don't need to zoom in to register clicks on small nodes,
  /// matching the typical UX pattern
  /// `hitRadius = strokeRadius + 8-12px`. Same `pickNode` covers
  /// both via the `slack` parameter; closer hits always win when
  /// several discs overlap (`d2 < bestD2`).
  const PICK_SLACK_DRAG_PX = 4;
  const PICK_SLACK_CLICK_PX = 10;
  function pickNode(
    px: number,
    py: number,
    slackPx: number = PICK_SLACK_DRAG_PX,
  ): DNode | null {
    const p = screenToWorld(px, py);
    let best: DNode | null = null;
    let bestD2 = Infinity;
    for (const n of dNodes) {
      if (n.x == null || n.y == null) continue;
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const r = n.radius + slackPx / Math.max(0.5, transform.k);
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD2) {
        best = n;
        bestD2 = d2;
      }
    }
    return best;
  }

  // ---- paint ------------------------------------------------------------

  /// Edges grouped for painting: one bucket per kind, so the stroke style
  /// changes once per kind rather than once per edge.
  type EdgeBuckets = {
    byKind: Record<RenderedEdgeKind, DEdge[]>;
    linkByKind: Map<string, DEdge[]>;
  };

  /// Group an edge list for painting. `link` edges are sub-grouped by their
  /// SOURCE document's kind so a markdown link strokes orange (--g-doc) and
  /// a source file's link royalblue (--g-source), mirroring the node-fill
  /// palette. Endpoints are read as resolved DNodes, which holds because
  /// d3-force's `forceLink` swaps the string ids for node objects
  /// synchronously inside `links()` / `nodes()`, both of which run before
  /// the next paint.
  function bucketEdges(edgeList: DEdge[]): EdgeBuckets {
    const edgesByKind: Record<RenderedEdgeKind, DEdge[]> = {
      link: [], tag: [], mention: [], contains: [], language: [], group: [],
    };
    for (const e of edgeList) edgesByKind[e.kind].push(e);
    // Falls back to the doc colour when the source kind isn't a recognised
    // file class (e.g. a tag/mention source, which shouldn't originate a
    // `link` but is handled defensively).
    const linkByKind = new Map<string, DEdge[]>();
    for (const e of edgesByKind.link) {
      const src = e.source as DNode;
      const key = typeof src === "object" ? src.kind : "doc";
      const bucket = linkByKind.get(key);
      if (bucket) bucket.push(e);
      else linkByKind.set(key, [e]);
    }
    return { byKind: edgesByKind, linkByKind };
  }

  type SelectionPaint = {
    rev: number;
    selected: string | null;
    spine: { nodes: Set<string>; edges: Set<string> };
    base: EdgeBuckets;
    lit: EdgeBuckets | null;
  };
  let paintCache: SelectionPaint | null = null;

  /// Selection-derived paint inputs, memoised on (working-set revision,
  /// selection). Recomputing these every frame is what made a selected node
  /// expensive on a large graph: the spine walk allocates two sets, the
  /// incident-edge scan walks the whole edge list, and bucketing walks it
  /// twice more. None of it depends on node POSITIONS, so the result stays
  /// valid across every frame of a running simulation and is rebuilt only
  /// when the selection or the working set actually changes.
  function selectionPaint(): SelectionPaint {
    if (
      paintCache
      && paintCache.rev === workingSetRev
      && paintCache.selected === selectedId
    ) {
      return paintCache;
    }
    // Containment spine: a node in the directory tree (any file /
    // directory / contact / symlink / media, i.e. anything with a
    // `contains` parent) also lights its whole parent chain up to the
    // workspace root, so the path home reads at a glance. Tag / mention /
    // language meta-nodes have no `contains` edge, so their spine is empty.
    const spine =
      selectedId !== null
        ? containmentSpine(selectedId, containsParent)
        : { nodes: new Set<string>(), edges: new Set<string>() };
    const isIncidentEdge = (e: DEdge): boolean => {
      const sId = typeof e.source === "object" ? e.source.id : e.source;
      const tId = typeof e.target === "object" ? e.target.id : e.target;
      return sId === selectedId || tId === selectedId;
    };
    const isSpineEdge = (e: DEdge): boolean => {
      if (spine.edges.size === 0) return false;
      const sId = typeof e.source === "object" ? e.source.id : e.source;
      const tId = typeof e.target === "object" ? e.target.id : e.target;
      return spine.edges.has(spineEdgeKey(sId, tId));
    };
    paintCache = {
      rev: workingSetRev,
      selected: selectedId,
      spine,
      base: bucketEdges(visibleEdgeRefs),
      // Lit overlay: the edges touching the selection, plus its path home
      // to the workspace root. Drawn on top of the dimmed base pass.
      lit:
        selectedId === null
          ? null
          : bucketEdges(
            visibleEdgeRefs.filter((e) => isIncidentEdge(e) || isSpineEdge(e)),
          ),
    };
    return paintCache;
  }

  function paint(): void {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // Combined transform: DPR scaling × user pan/zoom. setTransform
    // re-applies from identity each frame so cumulative drift is
    // impossible.
    ctx.setTransform(
      dpr * transform.k, 0, 0, dpr * transform.k,
      dpr * transform.x, dpr * transform.y,
    );
    ctx.clearRect(
      -transform.x / transform.k,
      -transform.y / transform.k,
      canvas.width / (dpr * transform.k),
      canvas.height / (dpr * transform.k),
    );

    // World-space bounds of what is actually on screen. Anything fully
    // outside is skipped: the rasteriser would discard it anyway, but the
    // path building, the icon blits and the label measuring are paid in JS
    // regardless, and on a multi-thousand-node graph that dominates the
    // frame when the user is zoomed in.
    const viewMinX = -transform.x / transform.k;
    const viewMinY = -transform.y / transform.k;
    const viewMaxX = viewMinX + canvas.width / (dpr * transform.k);
    const viewMaxY = viewMinY + canvas.height / (dpr * transform.k);
    /// Slack around the viewport, in world units, so a node just off-screen
    /// still draws and its label (which extends above and to either side of
    /// the disc) does not pop in at the edge.
    const cullPad = 140 / Math.max(0.5, transform.k);

    const adj = selectedId !== null ? adjacency.get(selectedId) : null;
    // Focus-on-select: with a node selected, its 1st-degree
    // neighbourhood (itself + `adj`) is the spotlight; everything else
    // dims so the selection reads at a glance. Drives both the node
    // alpha (below) and the edge emphasis (incident edges lit, the rest
    // faded).
    const hasSelection = selectedId !== null;
    const sel = selectionPaint();
    const spine = sel.spine;

    // Edges first so nodes paint on top. Group by kind so we only
    // change strokeStyle once per kind.
    //
    // Edge palette: directory->dir and directory->file containment
    // edges stay GREY (the `contains`
    // kind, stroked in `theme.folder`); every other edge matches its
    // DOCUMENT TYPE rather than a single connector colour. `tag`,
    // `mention`, and `language` already carry their own palette hue;
    // the `link` (wiki/markdown reference) edge is the one that needs
    // its colour derived from the SOURCE document's kind so a markdown
    // link reads orange (--g-doc), a source-file link royalblue
    // (--g-source), and so on, honouring the Graph settings palette.
    ctx.lineWidth = 1 / Math.max(0.5, transform.k);

    // `link` edges are coloured per source document type, so they are
    // sub-grouped by the source node's kind and stroked in their own
    // pass below. The other kinds keep the single-stroke-per-kind fast
    // path. `group` (synthetic scope-hub) keeps the accent colour.
    const strokeForKind = (kind: RenderedEdgeKind): string =>
      kind === "tag" ? theme.tag
      : kind === "mention" ? theme.mention
      : kind === "contains" ? theme.folder
      : kind === "language" ? theme.language
      : theme.accent;

    /// Both endpoints strictly off the same side of the viewport means the
    /// segment cannot cross it. Cheap conservative reject; a segment that
    /// straddles the viewport diagonally is kept and clipped by the canvas.
    const edgeOffscreen = (s: DNode, t: DNode): boolean =>
      (s.x! < viewMinX && t.x! < viewMinX)
      || (s.x! > viewMaxX && t.x! > viewMaxX)
      || (s.y! < viewMinY && t.y! < viewMinY)
      || (s.y! > viewMaxY && t.y! > viewMaxY);

    const strokePass = (list: DEdge[], color: string, alpha: number): void => {
      if (list.length === 0) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.beginPath();
      // Counted rather than collected: broken edges are rare, and a
      // `filter` here would allocate an array per kind per pass on a list
      // that can run to five figures.
      let broken = 0;
      for (const e of list) {
        const s = e.source as DNode;
        const t = e.target as DNode;
        if (s.x == null || t.x == null) continue;
        if (e.broken) { broken++; continue; } // dashed pass below
        if (edgeOffscreen(s, t)) continue;
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
      }
      ctx.stroke();
      // Broken edges: same colour, lower alpha, dashed.
      if (broken > 0) {
        ctx.save();
        ctx.setLineDash([3 / Math.max(0.5, transform.k), 3 / Math.max(0.5, transform.k)]);
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        for (const e of list) {
          if (!e.broken) continue;
          const s = e.source as DNode;
          const t = e.target as DNode;
          if (s.x == null || t.x == null) continue;
          if (edgeOffscreen(s, t)) continue;
          ctx.moveTo(s.x!, s.y!);
          ctx.lineTo(t.x!, t.y!);
        }
        ctx.stroke();
        ctx.restore();
      }
    };

    // Draw pre-grouped edges at one alpha, preserving the palette: each
    // kind strokes in its own hue, and `link` edges sub-group by their
    // source document's kind. Factored out so the base pass and the focus
    // lit overlay share identical colour resolution. The grouping itself
    // is memoised in `selectionPaint()`, so a frame only walks the
    // buckets it draws.
    const drawEdgeBuckets = (buckets: EdgeBuckets, alpha: number): void => {
      for (const kind of ["tag", "mention", "contains", "language", "group"] as const) {
        strokePass(buckets.byKind[kind], strokeForKind(kind), alpha);
      }
      for (const [kind, list] of buckets.linkByKind) {
        strokePass(list, fileKindColor(kind as DKind), alpha);
      }
    };

    // Base pass: dim every edge when a selection is active so the
    // spotlighted neighbourhood stands out; otherwise draw at the normal
    // weight. Then, when selected, redraw the edges touching the
    // selection on top at full strength so the 1st-degree connections
    // light up against the faded rest.
    drawEdgeBuckets(sel.base, hasSelection ? FOCUS_DIM_EDGE : EDGE_ALPHA);
    if (hasSelection && sel.lit) {
      drawEdgeBuckets(sel.lit, FOCUS_LIT_EDGE);
    }
    ctx.globalAlpha = 1;

    // Nodes: fill disc, stroke ring, blit icon, optional label.
    for (const n of dNodes) {
      if (n.x == null || n.y == null) continue;
      const isSel = n.id === selectedId;
      const isAdj = adj?.has(n.id) === true;
      // Labelled nodes are exempt from culling: a label is drawn centred
      // above its disc and can be far wider than it, so a node just past
      // the pad could still owe visible text. There are only ever a
      // handful of them (the selection, its neighbours, its spine).
      const labelled = isSel || isAdj || spine.nodes.has(n.id);
      if (
        !labelled
        && (n.x < viewMinX - cullPad || n.x > viewMaxX + cullPad
          || n.y < viewMinY - cullPad || n.y > viewMaxY + cullPad)
      ) {
        continue;
      }
      const isHover = n.id === hoverId;
      // Out of the spotlight: a selection is active and this node is
      // neither the selection nor one of its 1st-degree neighbours, so
      // it fades to let the focused neighbourhood read.
      const isDimmed = hasSelection && !isSel && !isAdj && !spine.nodes.has(n.id);
      // Ghost styling fires only for broken-link targets - files
      // that another doc points at but don't exist on disk. A
      // `@@name` mention is free-form by design (the indexer
      // emits a node per distinct token; no contact file is
      // required), so unresolved mentions are not ghosts; they
      // render as normal contact-coloured nodes. Whether a
      // mention happens to fuzzy-match a contact file shows up
      // in the inspector ("Open"), not the graph.
      const isGhost = n.missing;
      // Tint the Drafts directory node with the Drafts yellow so the
      // graph reads consistent with the FB row + the inspector chip.
      // The drafts dir is a normal in-workspace directory node with id
      // `directory:${draftsDir()}`. DNode doesn't carry the raw path
      // (the canvas only needs id + label + kind), so we key on the id.
      const isDraftsRoot =
        n.kind === "folder" && n.id === `directory:${draftsDir()}`;
      // Indexing palette override. When a
      // folder/workspace node carries `indexState` (the Dashboard
      // indexing slide feeds this; the main graph leaves it
      // undefined), paint the disc in the indexing colour and let
      // the pulse below modulate alpha for the in-flight state.
      // The override takes precedence over isDraftsRoot so the
      // Drafts directory still reads green/grey/orange in the
      // indexing slide.
      const indexFill = n.indexState === "indexed"
        ? theme.accent
        : n.indexState === "indexing"
          ? theme.doc
          : n.indexState === "pending"
            ? theme.textSec
            : null;
      const fill = isGhost
        ? theme.bgCard
        : indexFill ?? (
          isDraftsRoot ? theme.drafts
          : n.kind === "doc" ? theme.doc
          : n.kind === "img" ? theme.img
          : n.kind === "contact" ? theme.mention
          : n.kind === "mention" ? theme.mention
          : n.kind === "language" ? theme.language
          : n.kind === "workspace" ? theme.bgCard
          : n.kind === "folder" ? theme.folder
          : n.kind === "source" ? theme.source
          : n.kind === "binary" ? theme.binary
          : theme.tag
        );
      // Pulse the "indexing" state via alpha modulation on the
      // disc fill so the in-flight directories breathe against
      // their static neighbours. 1100ms cycle matches the
      // terminal-activity-pulse keyframe; pure sine so the motion
      // is calm and never snaps. Static (pending/indexed/standard)
      // nodes keep the focus-dim alpha behaviour.
      // `prefers-reduced-motion: reduce` users get a flat
      // mid-strength alpha (no pulse) so the indexing colour still
      // reads as distinct from pending/indexed without animating.
      let baseAlpha = isDimmed ? FOCUS_DIM_NODE : 1;
      if (n.indexState === "indexing") {
        if (reduceMotion) {
          baseAlpha = 0.78;
        } else {
          const t = (performance.now() % 1100) / 1100;
          const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
          baseAlpha = 0.55 + 0.45 * pulse;
        }
      }
      ctx.globalAlpha = baseAlpha;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      // Stroke ring. Selected / hover get the same thickness as
      // the rest so the disc size stays stable; the colour change
      // is what signals state.
      ctx.lineWidth = isGhost
        ? 1 / Math.max(0.5, transform.k)
        : isSel ? 2 / Math.max(0.5, transform.k)
        : 1.2 / Math.max(0.5, transform.k);
      ctx.strokeStyle = isGhost
        ? theme.textSec
        : isSel ? theme.text
        : isHover ? theme.text
        : strokeColor;
      if (isGhost) {
        ctx.save();
        ctx.setLineDash([2 / Math.max(0.5, transform.k), 2 / Math.max(0.5, transform.k)]);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.stroke();
      }
      // Icon blit. Skips while the SVG is still decoding; the disc
      // alone still reads as a kind via colour. Ghost variants
      // (missing-file targets) reach for the textSec-stroked
      // raster so the icon reads against the empty bgCard fill.
      const icon = isGhost
        ? (ghostIconImages[n.kind] ?? iconImages[n.kind])
        : iconImages[n.kind];
      if (icon && icon.complete && icon.naturalWidth > 0) {
        const w = n.radius * 2 * ICON_FRACTION;
        ctx.globalAlpha = baseAlpha * (isGhost ? 0.75 : 1);
        ctx.drawImage(icon, n.x - w / 2, n.y - w / 2, w, w);
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;
      // Label: the selected node, its first-degree neighbours, and the
      // containment spine directories on the path to the root, so the
      // canvas stays uncluttered at rest while the path home reads by name.
      if (isSel || isAdj || spine.nodes.has(n.id)) {
        const fontPx = 11 / Math.max(0.5, transform.k);
        ctx.font = `${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const labelY = n.y - n.radius - 4 / Math.max(0.5, transform.k);
        // Halo: thick stroke in page-bg, then thin fill in text.
        ctx.lineWidth = 3 / Math.max(0.5, transform.k);
        ctx.strokeStyle = theme.bg;
        ctx.strokeText(n.label, n.x, labelY);
        ctx.fillStyle = textColor;
        ctx.fillText(n.label, n.x, labelY);
      }
    }
  }

  function loop(): void {
    // Keep-alive pause: a hidden graph's host sets `paused`. Bail before
    // any paint/fit work and null the handle so the loop is genuinely
    // stopped (the resume effect re-arms it via requestAnimationFrame,
    // never start() -- so the transform + sim are untouched).
    if (paused) {
      rafId = null;
      return;
    }
    const now = performance.now();
    // While the refit window is open, retarget every frame so the
    // view tracks the cluster as the sim spreads / contracts. Once
    // the window expires we keep easing toward the last target until
    // it converges, then drop it.
    if (expansionRefit) {
      if (now < expansionRefit.until) {
        const t = computeFitForNodes(32, expansionRefit.ids, false, transform.k);
        if (t) fitTarget = t;
      } else {
        expansionRefit = null;
      }
    } else if (now < refitUntil) {
      const t = computeFit(24);
      if (t) fitTarget = t;
    }
    if (fitTarget) {
      const a = 0.18;
      const nx = transform.x + (fitTarget.x - transform.x) * a;
      const ny = transform.y + (fitTarget.y - transform.y) * a;
      const nk = transform.k + (fitTarget.k - transform.k) * a;
      transform = { x: nx, y: ny, k: nk };
      markDirty();
      if (
        now >= refitUntil
        && Math.abs(fitTarget.x - transform.x) < 0.5
        && Math.abs(fitTarget.y - transform.y) < 0.5
        && Math.abs(fitTarget.k - transform.k) < 0.002
      ) {
        fitTarget = null;
      }
    }
    // Repaint only when there is something new to show. A settled graph
    // with an idle pointer is the common case, and re-rasterising
    // thousands of discs, icon blits and edges into an identical frame
    // sixty times a second is pure waste -- it is what makes the whole
    // viewport feel heavy on a large workspace. Discrete changes announce
    // themselves through `markDirty()`; the continuous sources below
    // advance on their own schedule and so have to be polled here.
    //
    // `sim.alpha()` is the authoritative "is the layout still moving"
    // signal: d3-force stops its own timer once alpha decays past
    // alphaMin, and node positions are fixed from then on.
    const simRunning = sim !== null && sim.alpha() > SIM_ALPHA_MIN;
    const pulsing = hasIndexingPulse && !reduceMotion;
    if (dirty || simRunning || fitTarget !== null || pulsing) {
      paint();
      dirty = false;
    }
    rafId = requestAnimationFrame(loop);
  }

  // ---- pointer handlers -------------------------------------------------

  function localCoords(e: MouseEvent): { x: number; y: number } {
    const r = canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onMouseDown(e: MouseEvent): void {
    if (!canvas) return;
    if (e.button !== 0) return; // right-click → context menu
    const p = localCoords(e);
    downAt = { x: p.x, y: p.y };
    const n = pickNode(p.x, p.y);
    if (n) {
      // Candidate drag only. Pinning the node and re-heating the
      // simulation happen on the first qualifying move (see
      // `activateDrag`), never on the press itself: a press that turns out
      // to be a plain selection click would otherwise inject alpha that
      // takes hundreds of ticks to decay, which on a large graph reads as
      // the cluster shaking for seconds after every click.
      dragId = n.id;
      dragActive = false;
      cancelRefit();
      // Drag is user interaction; subsequent same-set data
      // refreshes must not snap the view back.
      userInteracted = true;
    } else {
      panStart = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
      cancelRefit();
      userInteracted = true;
    }
  }

  /// Movement past this many screen pixels promotes a press on a node into
  /// a real drag. Matches the tap/drag threshold `onMouseUp` already uses
  /// to decide between selecting and dragging, so the two never disagree.
  const DRAG_ACTIVATE_PX = 3;

  /// Promote the pending press into a live drag: pin the node under the
  /// cursor and re-heat the simulation so the cluster follows it.
  function activateDrag(n: DNode): void {
    dragActive = true;
    n.fx = n.x;
    n.fy = n.y;
    sim?.alphaTarget(0.3).restart();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!canvas) return;
    const p = localCoords(e);
    if (dragId !== null) {
      const n = nodeById.get(dragId);
      if (!n) return;
      if (!dragActive) {
        // Still deciding whether this press is a click or a drag. Until it
        // clears the threshold the simulation stays untouched.
        if (
          !downAt
          || (Math.abs(p.x - downAt.x) <= DRAG_ACTIVATE_PX
            && Math.abs(p.y - downAt.y) <= DRAG_ACTIVATE_PX)
        ) {
          return;
        }
        activateDrag(n);
      }
      const w = screenToWorld(p.x, p.y);
      n.fx = w.x;
      n.fy = w.y;
      markDirty();
      return;
    }
    if (panStart) {
      transform.x = panStart.tx + (e.clientX - panStart.x);
      transform.y = panStart.ty + (e.clientY - panStart.y);
      markDirty();
      return;
    }
    // Cheap hover update. Match the wider click slack so the cursor
    // preview (`hoverId` → "pointer" CSS) reads the same hit-target
    // the user will actually tap. Drag-detect (onMouseDown) uses the
    // tighter slack to keep pan-on-empty usable.
    const h = pickNode(p.x, p.y, PICK_SLACK_CLICK_PX);
    const next = h?.id ?? null;
    if (next !== hoverId) {
      hoverId = next;
      markDirty();
    }
  }

  function onMouseUp(e: MouseEvent): void {
    const p = localCoords(e);
    const moved =
      downAt
      && (Math.abs(p.x - downAt.x) > DRAG_ACTIVATE_PX
        || Math.abs(p.y - downAt.y) > DRAG_ACTIVATE_PX);
    if (dragId !== null) {
      // Only a drag that actually activated pinned the node and re-heated
      // the simulation, so only that path has anything to undo. A plain
      // selection click leaves the layout untouched.
      if (dragActive) {
        const n = nodeById.get(dragId);
        if (n && !n.isFocal) {
          // Release the node back to the simulation. Focal nodes
          // remain pinned at origin regardless.
          n.fx = null;
          n.fy = null;
        }
        sim?.alphaTarget(0);
      }
      dragActive = false;
      dragId = null;
      if (!moved) {
        // A tap on a node (no drag movement) selects it. Use the
        // wider click slack so the user doesn't need to zoom in for
        // small targets. The drag-detect path (onMouseDown's pickNode
        // call) still uses the tight 4px slack so pan-on-empty-space
        // stays usable.
        const tapped = pickNode(p.x, p.y, PICK_SLACK_CLICK_PX);
        onSelect(tapped ? tapped.id : null);
      }
    } else if (panStart) {
      panStart = null;
      if (!moved) {
        // Background tap clears selection.
        onSelect(null);
      }
    }
    downAt = null;
  }

  /// A double-click on a node calls `onSetAsScope` so the parent
  /// re-roots the graph at that node
  /// (`graphFromHere`). The preceding two single-clicks already
  /// fired onSelect for the parent, so the parent's selectedId
  /// reflects the dblclicked node when this handler runs; the
  /// parent reads its own selection to derive (path, isDir).
  /// Skipping when no node sits under the cursor keeps double-
  /// clicking empty space a no-op (no rescope to workspace from
  /// a stray double-tap).
  function onDoubleClick(e: MouseEvent): void {
    if (!canvas) return;
    const p = localCoords(e);
    const n = pickNode(p.x, p.y, PICK_SLACK_CLICK_PX);
    if (n && onSetAsScope) onSetAsScope();
  }

  function onWheel(e: WheelEvent): void {
    if (!canvas) return;
    e.preventDefault();
    const p = localCoords(e);
    // Wheel deltas are wildly inconsistent across input devices:
    // mouse-wheel notches fire ~100, trackpads fire dozens of
    // small events (~3-15), `deltaMode` further changes units.
    // Map every delta through `exp(-d * SENSITIVITY)` so the
    // effective zoom factor is smooth and bounded regardless of
    // device, and tune SENSITIVITY low enough that a trackpad
    // pinch doesn't snap-zoom across the cluster.
    const SENSITIVITY = 0.0015;
    const factor = Math.exp(-e.deltaY * SENSITIVITY);
    const k2 = Math.min(6, Math.max(0.15, transform.k * factor));
    cancelRefit();
    // Zoom is user interaction; subsequent same-set data refreshes
    // must not snap the view back.
    userInteracted = true;
    // Zoom toward the cursor: the world point under the cursor
    // must stay anchored across the transform. Solve for the new
    // (tx, ty) that holds wx, wy invariant.
    transform.x = p.x - ((p.x - transform.x) * k2) / transform.k;
    transform.y = p.y - ((p.y - transform.y) * k2) / transform.k;
    transform.k = k2;
    markDirty();
  }

  function onContextMenuLocal(e: MouseEvent): void {
    // Delegate to the parent so the existing hamburger-menu
    // affordance still works on right-click.
    onContextMenu?.(e);
  }

  // ---- lifecycle --------------------------------------------------------

  /// First-open setup: pre-rasterise icons, kick the resize
  /// observer, build the working set + sim, start the rAF loop.
  function start(): void {
    if (!canvas || !containerEl) return;
    refreshTheme();
    resize();
    rebuildAdjacency();
    rebuildWorkingSet();
    // Centre the world origin in the viewport so the focal-pinned
    // cluster lands in the middle of the canvas on first paint.
    if (canvas) {
      transform = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, k: 1 };
    }
    buildSim();
    // Pre-tick so node positions settle before we measure the
    // bounding box. d3-force's tick(n) advances the layout without
    // firing the rAF loop, so the first painted frame already shows
    // a fitted cluster instead of nodes flying out from the origin.
    if (sim) sim.tick(300);
    // Defer the initial fit when the host hasn't been measured yet
    // (the carousel mounts GraphCanvas before its slide is visible,
    // so the first `resize()` may clamp the canvas to 0x0).
    // `resize()` re-runs the fit the moment the host reports nonzero
    // dims.
    const cw = canvas?.clientWidth ?? 0;
    const ch = canvas?.clientHeight ?? 0;
    if (cw > 0 && ch > 0) {
      fitToContent(24);
    } else {
      pendingInitialFit = true;
    }
    if (rafId === null) rafId = requestAnimationFrame(loop);
  }

  /// Compute the transform that fits the current node set into the
  /// canvas with `pad` pixels of margin. When a focal node is
  /// present its world position is pinned to the viewport center so
  /// the user's anchor stays put across scope / filter / depth
  /// changes; the zoom is then chosen so the farthest node still
  /// fits inside the padded viewport. Falls back to bbox-center
  /// framing for views without a focal pin (e.g. whole-workspace).
  function computeFitForNodes(
    pad: number,
    ids: Set<string> | null,
    anchorFocal: boolean,
    maxK?: number,
  ): { x: number; y: number; k: number } | null {
    if (!canvas || dNodes.length === 0) return null;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw <= 0 || ch <= 0) return null;
    let xmin = Infinity, xmax = -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    let focal: { x: number; y: number } | null = null;
    for (const n of dNodes) {
      if (ids !== null && !ids.has(n.id)) continue;
      if (n.x == null || n.y == null) continue;
      if (n.x - n.radius < xmin) xmin = n.x - n.radius;
      if (n.x + n.radius > xmax) xmax = n.x + n.radius;
      if (n.y - n.radius < ymin) ymin = n.y - n.radius;
      if (n.y + n.radius > ymax) ymax = n.y + n.radius;
      if (anchorFocal && n.isFocal && !focal) focal = { x: n.x, y: n.y };
    }
    if (!isFinite(xmin)) return null;
    let cx: number, cy: number, halfW: number, halfH: number;
    if (focal) {
      // Anchor on the focal node: the half-extent is the max distance
      // from focal to any edge of the bbox so every visible node
      // stays inside the padded viewport.
      cx = focal.x;
      cy = focal.y;
      halfW = Math.max(focal.x - xmin, xmax - focal.x);
      halfH = Math.max(focal.y - ymin, ymax - focal.y);
    } else {
      cx = (xmin + xmax) / 2;
      cy = (ymin + ymax) / 2;
      halfW = (xmax - xmin) / 2;
      halfH = (ymax - ymin) / 2;
    }
    // Bottom-anchor mode (Dashboard search-index): seat the focal node near
    // the bottom edge instead of the vertical center, so the spine grows
    // upward from it and the root sits just above the carousel scroller. The
    // fittable height is then the room ABOVE the bottom anchor, not half the
    // canvas.
    const bottomAnchored = focalAnchor === "bottom" && focal !== null;
    const FOCAL_BOTTOM_MARGIN = 56;
    const anchorY = bottomAnchored ? ch - FOCAL_BOTTOM_MARGIN : ch / 2;
    const availHalfW = Math.max(1, cw / 2 - pad);
    const availHalfH = bottomAnchored
      ? Math.max(1, ch - FOCAL_BOTTOM_MARGIN - pad)
      : Math.max(1, ch / 2 - pad);
    // Clamp to the wheel-zoom range, with the same upper cap so a
    // tiny cluster (1-2 nodes) doesn't zoom in past a sensible level.
    let k = Math.min(
      6,
      Math.max(
        0.15,
        Math.min(availHalfW / Math.max(1, halfW), availHalfH / Math.max(1, halfH)),
      ),
    );
    if (maxK !== undefined) k = Math.min(k, maxK);
    return { x: cw / 2 - cx * k, y: anchorY - cy * k, k };
  }

  function computeFit(pad: number): { x: number; y: number; k: number } | null {
    return computeFitForNodes(pad, null, true);
  }

  /// Snap the transform to fit the current node set. Used at first
  /// open after the sim has pre-ticked into a settled layout.
  function fitToContent(pad: number): void {
    const t = computeFit(pad);
    if (t) {
      transform = t;
      markDirty();
    }
  }

  /// Open a refit window for `ms` so the rAF loop tracks the cluster
  /// as the sim relaxes after a scope / filter / depth change. The
  /// view eases toward the moving target without snapping, and stays
  /// active until both the window expires and the easing converges.
  function scheduleRefit(ms: number): void {
    // Skip auto-refit once the user has panned, zoomed, or dragged a
    // node. The view belongs to them; periodic data refreshes (e.g.,
    // Dashboard indexing polling) must not snap back to fit-content.
    // The interaction flag resets when the node SET actually differs
    // from the current dNodes (scope/depth change, first load), so
    // genuine dataset swaps still re-frame the cluster.
    if (userInteracted) return;
    refitUntil = performance.now() + ms;
  }

  function scheduleExpansionFit(ids: string[], ms: number): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    expansionRefit = { until: performance.now() + ms, ids: set };
    const t = computeFitForNodes(32, set, false, transform.k);
    if (t) fitTarget = t;
  }

  function applyExpansionFitRequest(request: ExpansionFitRequest): void {
    seenExpansionFitNonce = request.nonce;
    scheduleExpansionFit(request.ids, 900);
  }

  /// User pan / zoom / drag cancels any in-flight auto-fit so manual
  /// interaction wins immediately.
  function cancelRefit(): void {
    refitUntil = 0;
    fitTarget = null;
    expansionRefit = null;
  }

  function stop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    sim?.stop();
    sim = null;
    nodeById = new Map();
    dNodes = [];
    dEdges = [];
    visibleEdgeRefs = [];
  }

  onMount(() => {
    if (!canvas || !containerEl) return;
    resizeObs = new ResizeObserver(() => resize());
    resizeObs.observe(containerEl);
    // Theme tracker: re-read CSS variables when the document's or
    // graph surface's `data-theme` attribute flips, and when the graph
    // surface's inline custom-property block changes (a graph-palette
    // override lands as a `style` attribute on `.graph-tab`).
    const themeObs = new MutationObserver(() => refreshTheme());
    themeObs.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });
    const graphEl = containerEl.closest(".graph-tab");
    if (graphEl) {
      themeObs.observe(graphEl, {
        attributes: true, attributeFilter: ["data-theme", "style"],
      });
    }
    // Track reduced-motion for the indexing pulse. Listener stays
    // subscribed while the canvas is mounted
    // so the user toggling the OS preference takes effect on the
    // next paint without a reload.
    const reduceMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    reduceMotion = reduceMotionQuery.matches;
    const onReduceMotionChange = (e: MediaQueryListEvent): void => {
      reduceMotion = e.matches;
      markDirty();
    };
    reduceMotionQuery.addEventListener("change", onReduceMotionChange);
    if (open) start();
    return () => {
      themeObs.disconnect();
      reduceMotionQuery.removeEventListener("change", onReduceMotionChange);
    };
  });

  onDestroy(() => {
    resizeObs?.disconnect();
    stop();
  });

  // ---- prop-reactive effects -------------------------------------------

  /// Open/close: start the renderer when the overlay becomes
  /// visible, tear it down when it closes. Matches the previous
  /// cytoscape lifecycle and keeps idle overlays from burning rAF
  /// budget.
  $effect(() => {
    if (open) {
      if (!sim) start();
    } else {
      stop();
    }
  });

  /// Keep-alive resume: when the host un-hides the graph, `paused`
  /// flips false. The loop short-circuited itself to a stop while
  /// hidden (rafId nulled in loop()), and `open` stayed latched true so
  /// the open effect above never tore the sim down. Re-arm WITHOUT
  /// start() -- the pane may have resized while the tab was hidden, so
  /// resize() first to match the canvas backing store to the new size
  /// (it leaves the pan/zoom transform alone unless a first-fit is
  /// still pending), then restart the rAF loop. No transform reset, no
  /// sim rebuild: pan/zoom/selection are preserved across the switch.
  $effect(() => {
    if (paused) return;
    if (!sim || rafId !== null) return;
    resize();
    markDirty();
    rafId = requestAnimationFrame(loop);
  });

  /// Selection / hover emphasis. The paint pass reads `selectedId` straight
  /// from props rather than through reactivity, so the repaint has to be
  /// requested explicitly. Load-bearing now that idle frames are gated:
  /// without it, selecting a node on a settled graph would change nothing
  /// on screen until the next unrelated repaint.
  $effect(() => {
    void selectedId;
    markDirty();
  });

  /// Nodes / edges arrays changed (new graph payload from the
  /// server). Full rebuild: regenerate adjacency, recreate the
  /// working set, restart the sim with alpha=1.
  $effect(() => {
    void nodes;
    void edges;
    if (!sim) return;
    // The Dashboard indexing slide polls /api/indexing/state every
    // 3s, which produces a new (content-identical) `nodes`/`edges`
    // array reference each tick. When the node id SET hasn't changed
    // (only node fields like `indexState` colour have refreshed),
    // this is a content-update tick, not a structural change: skip
    // the refit so the user's view stays put rather than zooming
    // back to fit-content. Scope / depth / first-load swaps still
    // refit because the set actually differs.
    const nextIds = new Set<string>();
    for (const n of nodes) nextIds.add(n.id);
    let overlap = 0;
    for (const n of dNodes) if (nextIds.has(n.id)) overlap++;
    const sameSet =
      dNodes.length > 0 &&
      dNodes.length === nextIds.size &&
      overlap === dNodes.length;
    // Pick the simulation re-warm alpha by structural delta, not by
    // a binary "same set vs not". The Dashboard indexing slide adds
    // nodes one at a time as files appear on disk; alpha=1 (full-swap
    // strength) would yank every node toward the layout origin and
    // look more like a scope change than a fluid file-browser update.
    // Treat anything with >=50% overlap as incremental (gentle alpha
    // so existing nodes barely move and the new ones ease in);
    // zero-or-low overlap reads as a real scope swap and warrants the
    // strong re-warm.
    const incremental = !sameSet && dNodes.length > 0 && overlap * 2 >= dNodes.length;
    // Capture emptiness BEFORE rebuildWorkingSet reassigns dNodes. An
    // empty -> non-empty transition means the canvas opened before its
    // data arrived (carousel flip-back, first load): start()'s fit ran
    // on an empty set and left the viewport at the origin placeholder.
    // We re-fit once the nodes have landed (below), independent of the
    // userInteracted gate since there was nothing to interact with.
    const wasEmpty = dNodes.length === 0;
    rebuildAdjacency();
    rebuildWorkingSet();
    const alpha = sameSet ? 0.05 : incremental ? 0.2 : 1;
    rewarmSim(alpha);
    if (wasEmpty && dNodes.length > 0) {
      fitToContent(24);
    }
    // scheduleRefit is itself gated on `userInteracted`, so calling
    // it on a structural change is a no-op once the user has taken
    // control of the view. First-load (userInteracted false) still
    // gets the auto-fit. The interaction flag is never reset on set
    // changes: the file-browser-style expectation is that new nodes
    // appear in place while the user's chosen viewport stays put.
    if (!sameSet) {
      scheduleRefit(1200);
    }
  });

  /// Visibility change without a full data swap: scope / depth /
  /// chip filters moved. Incremental rebuild that preserves existing
  /// node positions, seeds new arrivals near a visible neighbour, and
  /// re-warms with a small alpha so the cluster relaxes around the
  /// edit instead of jumping.
  $effect(() => {
    void visibleNodeIds;
    void visibleEdges;
    void focalIds;
    if (!sim) return;
    const { added, removed } = rebuildWorkingSet();
    // The Dashboard indexing slide re-derives its `visibleNodeIds`
    // (a new Set ref) + `visibleEdges` (a new array ref) every 3s
    // poll. When the working set is unchanged (no nodes added or
    // removed), this is a content-only re-render: skip the refit +
    // the alpha bump so the canvas stays still.
    //
    // The same-set path still rebinds the d3-force link force to the
    // freshly-rebuilt `dEdges` (rebuildWorkingSet replaces it on
    // every call). Skipping that rebind would orphan the link force
    // pointing at stale DEdge objects, and the render would walk the
    // new `visibleEdgeRefs` whose endpoints were never resolved, so
    // the canvas would paint no edges. The rebind happens with no
    // alpha bump and no refit so edges keep rendering while the
    // user's view stays put.
    if (added.length === 0 && removed.length === 0) {
      sim.nodes(dNodes);
      const link = sim.force("link") as unknown as {
        links(ls: DEdge[]): unknown;
      } | undefined;
      if (link && typeof link.links === "function") link.links(dEdges);
      return;
    }
    const alpha = added.length > 0 ? 0.35 : 0.2;
    rewarmSim(alpha);
    // Scope / filter / depth change: re-fit so the focal node stays
    // centered and the new visible set lands inside the viewport.
    // Depth bumps that add nodes need the longest window; pure
    // filter toggles settle fastest.
    const ms = added.length > 0 ? 900 : 600;
    scheduleRefit(ms);
  });

  /// Directory expansion fit. Runs after the visibility effect above so
  /// `dNodes` contains the newly visible directory children. Unlike the
  /// normal content refit, this bypasses `userInteracted` because it is a
  /// direct result of the user's expand gesture. The target caps zoom at the
  /// current scale, so it can zoom out or pan but never zoom in.
  $effect(() => {
    const request = expansionFitRequest;
    if (!request || request.nonce === seenExpansionFitNonce) return;
    if (!sim) {
      void tick().then(() => {
        if (expansionFitRequest !== request || !sim || request.nonce === seenExpansionFitNonce) {
          return;
        }
        applyExpansionFitRequest(request);
      });
      return;
    }
    applyExpansionFitRequest(request);
  });

  /// Live re-tune: the graph-tuner playground swaps in a NEW `force`
  /// object whenever a slider moves. Rebuild the simulation with the
  /// new params (buildSim reads `force`) and give it a gentle reheat so
  /// the layout visibly responds. The reference compare makes this a
  /// strict no-op for every production caller: they never pass `force`,
  /// so it stays === DEFAULT_FORCE for the component's lifetime, and it
  /// keeps the initial mount (where start() already built the sim) from
  /// rebuilding redundantly.
  let prevForce: GraphForce | undefined;
  $effect(() => {
    // Seed the baseline inside the effect (first run) so the initial
    // mount never rebuilds; thereafter rebuild only on a genuine
    // reference change.
    if (prevForce === undefined) {
      prevForce = force;
      return;
    }
    if (force === prevForce) return;
    prevForce = force;
    if (!sim) return;
    buildSim();
    sim.alpha(0.5).restart();
  });

  /// Cursor: pointer over a node when nothing is being dragged.
  const cursor = $derived(
    dragId !== null ? "grabbing"
    : hoverId !== null ? "pointer"
    : "grab",
  );
</script>

<div
  bind:this={containerEl}
  class="canvas-host"
  oncontextmenu={onContextMenuLocal}
  role="presentation"
>
  <canvas
    bind:this={canvas}
    style:cursor={cursor}
    onmousedown={onMouseDown}
    onmousemove={onMouseMove}
    onmouseup={onMouseUp}
    onmouseleave={onMouseUp}
    ondblclick={onDoubleClick}
    onwheel={onWheel}
  ></canvas>
</div>

<style>
  .canvas-host {
    position: relative;
    width: 100%;
    height: 100%;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
