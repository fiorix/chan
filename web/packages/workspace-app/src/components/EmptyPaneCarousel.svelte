<script lang="ts">
  // Dashboard carousel surface.
  //
  // The carousel sits inside the Dashboard tab. It auto-rotates
  // every 5 s. Pointer hover and focus-within pause auto-rotate so
  // the user can read whichever slide they happen to be looking at;
  // the timer resumes when both signals clear. Left / right arrow
  // keys nudge manually when the carousel container has focus.
  //
  // No `oncontextmenu` forwarder prop: DashboardTab does NOT wire a
  // right-click handler through the carousel, so right-clicks fall
  // through to the tab strip's own context menu.
  //
  // Slide 0 mounts `WorkspaceInfoBody` so the workspace-root
  // inspector lives alongside the file-browser inspector surface.
  //
  // Slide 1 is a read-only mount of `GraphCanvas`, the same
  // renderer the main Graph tab uses, fed a synthesized
  // directory-only spine + per-directory `indexState` for the
  // green/grey/pulsing-orange palette. No depth slider, inspector,
  // filter chips or scope picker: this surface is purely a status
  // read-out.
  //
  // Slide 2 is an About widget (version, attributions, donation QR,
  // project links).

  import { onDestroy, onMount } from "svelte";
  import { api } from "../api/client";
  import { withTokenQuery } from "../api/transport";
  import type {
    BuildInfo,
    GraphViewEdge,
    GraphViewNode,
    IndexingStateResponse,
  } from "../api/types";
  import {
    workspace,
    currentPreferences,
    indexStatus,
    ui,
    openGraphForContact,
    openGraphForLanguage,
    revealPathInBrowser,
    openFsGraphForDirectory,
  } from "../state/store.svelte";
  import { layout, openTerminalInPane } from "../state/tabs.svelte";
  import { terminalFromHereTarget } from "../terminal/fromHere";
  import { indexingCache } from "../state/indexingStatus.svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import InspectorBody from "./InspectorBody.svelte";
  import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
  import {
    ChevronLeft,
    ChevronRight,
    Code2,
    Globe,
    Pause,
    Play,
  } from "lucide-svelte";

  /// `GraphCanvas` narrows folder/file/tag/mention/language nodes
  /// out of the broader `GraphViewNode` union. The Dashboard
  /// indexing slide only emits directory (folder) nodes, but the
  /// arrays still need to satisfy the wider canvas prop shape.
  type CanvasNode = Extract<
    GraphViewNode,
    { kind: "file" | "tag" | "mention" | "language" | "folder" }
  >;
  type CanvasEdgeKind =
    | "link"
    | "tag"
    | "mention"
    | "contains"
    | "language"
    | "group";
  type CanvasEdge = GraphViewEdge & { kind: CanvasEdgeKind };


  // ---- About slide -------------------------------------------------------
  //
  // Sole home for the version + attribution surface. The embeddings /
  // hybrid-search controls live in Settings > This workspace, not here,
  // so the About card stays "what + who".

  let buildInfo = $state<BuildInfo | null>(null);

  async function loadBuildInfo(): Promise<void> {
    try {
      buildInfo = await api.buildInfo();
    } catch {
      buildInfo = null;
    }
  }

  onMount(() => {
    void loadBuildInfo();
  });

  // ---- shared index status label (Search slide stub copy) --------------------

  const indexLabel = $derived.by<string | null>(() => {
    const s = indexStatus.value;
    if (!s) return null;
    if (s.state === "building") {
      if (s.total > 0) return `indexing ${s.current}/${s.total}`;
      return "indexing...";
    }
    if (s.state === "reindexing") return "reindexing...";
    if (s.state === "recovering") return "rebuilding search index...";
    if (s.state === "error") return "index error";
    return null;
  });

  // ---- Search slide (index 1) - indexing graph (read-only spine) ---------

  /// Indexing state response cache. Re-fetched whenever the Search
  /// slide becomes active and again every 3 s while it stays active so
  /// orange (in-flight) nodes can flip to green as the indexer
  /// makes progress. Polling stops the moment the slide hides; the
  /// effect cleanup clears the timer.
  // Seed from the shared cache so a flip-back remount renders the graph
  // immediately instead of flashing empty (the poll below still refreshes
  // it). A one-shot read of the cache value is exactly the desired
  // semantic; a live `$derived` link is not wanted here.
  // svelte-ignore state_referenced_locally
  let indexing = $state<IndexingStateResponse | null>(indexingCache.last);
  let indexingError = $state<string | null>(null);
  let indexingLoading = $state(false);

  async function refreshIndexing(): Promise<void> {
    indexingLoading = true;
    try {
      indexing = await api.indexingState();
      // Persist for the next flip-back so the remount has data on hand.
      indexingCache.last = indexing;
      indexingError = null;
    } catch (e) {
      indexingError = (e as Error).message;
    } finally {
      indexingLoading = false;
    }
  }

  /// Which directory states are actually present right now. The Search
  /// front legend always shows "indexed" (the steady state) but only
  /// surfaces "indexing" / "pending" while at least one directory is in
  /// that state, so a fully-indexed workspace reads as one clean legend
  /// entry instead of two dead ones.
  const hasIndexingNodes = $derived(
    indexing?.nodes.some((n) => n.state === "indexing") ?? false,
  );
  const hasPendingNodes = $derived(
    indexing?.nodes.some((n) => n.state === "pending") ?? false,
  );

  function basename(path: string): string {
    if (path === "") return "/";
    const slash = path.lastIndexOf("/");
    return slash < 0 ? path : path.slice(slash + 1);
  }

  function parentPath(path: string): string {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return "";
    return path.slice(0, slash);
  }

  /// Folder-node id matching chan-server's `directory_node_id`
  /// convention: workspace root is the empty string, every other
  /// directory uses `directory:<workspace-relative path>`. This
  /// has to match exactly so GraphCanvas's `workspace`-kind
  /// classification (id === "") fires on the root.
  function directoryId(path: string): string {
    return path === "" ? "" : `directory:${path}`;
  }

  /// Synthesize the read-only directory spine for GraphCanvas. We
  /// emit one `folder` node per indexed directory (plus the
  /// workspace root sentinel) and one `contains` edge per
  /// parent → child relationship. The `indexState` field on each
  /// folder node drives the green/grey/pulsing-orange palette
  /// inside GraphCanvas; the main Graph-tab view leaves
  /// `indexState` unset and falls back to the standard folder
  /// fill, so this surface owns the colour override.
  const indexingGraph = $derived.by<{
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  }>(() => {
    const data = indexing;
    if (!data) return { nodes: [], edges: [] };
    const nodes: CanvasNode[] = [];
    const known = new Set<string>();
    for (const n of data.nodes) known.add(n.path);
    for (const n of data.nodes) {
      // Omit `indexState` for the workspace-root node so
      // GraphCanvas's `indexFill` override does NOT replace the
      // workspace's standard `bgCard` disc fill. The hard-drive icon
      // is stroked in text-secondary to read against `bgCard`;
      // against an indexFill (accent / doc / textSec) the same
      // stroke colour disappears into the fill and the workspace
      // looks like a plain undrawn node, unlike the main Graph tab.
      // Children directories keep their indexState (that's what
      // drives the indexing legend on this slide).
      //
      // Label the workspace root with the workspace name (or
      // "workspace" as the steady-state fallback) the same way the
      // main Graph tab and the file browser title bar do, instead of
      // the literal "/" basename.
      const isWorkspaceRoot = n.path === "";
      const label = isWorkspaceRoot
        ? (workspace.info?.label ?? "workspace")
        : basename(n.path);
      nodes.push({
        kind: "folder",
        id: directoryId(n.path),
        label,
        path: n.path,
        files: 0,
        code: 0,
        ...(isWorkspaceRoot ? {} : { indexState: n.state }),
      });
    }
    const edges: CanvasEdge[] = [];
    for (const n of data.nodes) {
      if (n.path === "") continue;
      const parent = parentPath(n.path);
      if (!known.has(parent)) continue;
      edges.push({
        source: directoryId(parent),
        target: directoryId(n.path),
        kind: "contains",
      });
    }
    return { nodes, edges };
  });

  /// `visibleNodeIds` mirrors the full synthesized set: this
  /// surface is depth-max + spine-only, there's no filter chip /
  /// scope picker to thin it. Same for `visibleEdges`.
  const indexingNodeIds = $derived.by<Set<string>>(() => {
    const out = new Set<string>();
    for (const n of indexingGraph.nodes) out.add(n.id);
    return out;
  });

  /// Workspace root is the focal anchor so the spine grows
  /// upward from it (GraphCanvas's `hierarchyY` + `parentX`
  /// forces lay the depth tiers vertically with focal pinning
  /// at origin).
  const indexingFocal = ["" as string];

  /// Clicks toggle the selected node so GraphCanvas surfaces the
  /// clicked node's label plus its 1-hop neighbours (siblings +
  /// parent + children), matching the main Graph tab's
  /// selection-labeling rule.
  ///
  /// Selection ALSO surfaces a directory inspector on the right
  /// side of the slide (same FileInfoBody the File Browser + Graph
  /// tab use for folder rows). Clicking the canvas background clears
  /// the selection and dismisses the inspector. Clicking the
  /// inspector's close affordance does the same.
  let selectedIndexId = $state<string | null>(null);
  function onIndexingSelect(id: string | null): void {
    selectedIndexId = id;
  }
  /// Resolve the selected node id back to a workspace-relative
  /// path. `directoryId(path)` is the canonical mapping that
  /// generates the ids fed to GraphCanvas; this is its inverse.
  /// Returns null when nothing is selected or the id doesn't
  /// match a known folder node (defensive - the canvas only
  /// emits folder ids from the indexing spine).
  const selectedIndexPath = $derived.by<string | null>(() => {
    if (selectedIndexId === null) return null;
    if (selectedIndexId === "") return "";
    if (selectedIndexId.startsWith("directory:")) {
      return selectedIndexId.slice("directory:".length);
    }
    return null;
  });
  const selectedIndexLabel = $derived.by<string>(() => {
    if (selectedIndexPath === null) return "";
    if (selectedIndexPath === "") return workspace.info?.label ?? "workspace";
    return basename(selectedIndexPath);
  });

  // ---- carousel state ----------------------------------------------------

  /// DashboardTab passes the persisted slide cursor in (via the
  /// tabs.svelte.ts serialization round-trip) so a window reload
  /// restores the carousel to the slide the user was last on.
  /// `onSlideChange` lets the parent write the live cursor back to
  /// its DashboardTab.carouselSlide field so subsequent reloads keep
  /// the position aligned. Both props default to no-op for
  /// non-DashboardTab hosts.
  // DashboardTab passes the live slide cursor in (sourced from
  // tab.carouselSlide) plus `onSlideChange` to write moves back. The
  // carousel is CONTROLLED: tab.carouselSlide is the single source of
  // truth, so the dots stay in sync with no snapshot to drift. `active`
  // is false while the tab is hidden; the carousel then force-pauses
  // auto-rotate and the indexing poll.
  type Props = {
    slide?: number;
    onSlideChange?: (slide: number) => void;
    active?: boolean;
    /// Slide indices the user switched off in the Dashboard tab menu.
    /// Auto-rotate and arrow nav skip these, and the dots hide
    /// them. Empty (the default) means every slot participates.
    disabledSlots?: number[];
    /// Per-tab auto-rotate opt-out. False suppresses
    /// auto-advance for this tab even when the global cycling pref is on;
    /// manual nav (arrows / dots) still works. Default true.
    autoRotate?: boolean;
  };
  let {
    slide = 0,
    onSlideChange,
    active = true,
    disabledSlots = [],
    autoRotate = true,
  }: Props = $props();

  const slideCount = 3;
  function slotEnabled(i: number): boolean {
    return !disabledSlots.includes(i);
  }
  /// Enabled slide indices in order; backs the pagination dots so a
  /// disabled slot never gets a dot to click.
  const enabledSlots = $derived(
    Array.from({ length: slideCount }, (_, i) => i).filter(slotEnabled),
  );
  function firstEnabled(): number {
    return enabledSlots[0] ?? 0;
  }
  function nextEnabled(from: number): number {
    for (let step = 1; step <= slideCount; step++) {
      const cand = (from + step) % slideCount;
      if (slotEnabled(cand)) return cand;
    }
    return from;
  }
  function prevEnabled(from: number): number {
    for (let step = 1; step <= slideCount; step++) {
      const cand = (from - step + slideCount) % slideCount;
      if (slotEnabled(cand)) return cand;
    }
    return from;
  }
  // Clamp the controlled cursor to range, then off any disabled slot to
  // the first enabled one. Keeping the name `slideIndex` lets the
  // template read the current slot unchanged; it is a derived view of the
  // prop now, not local state, so there is nothing to keep in sync.
  const slideIndex = $derived.by(() => {
    const clamped = Math.min(Math.max(0, Math.floor(slide)), slideCount - 1);
    return slotEnabled(clamped) ? clamped : firstEnabled();
  });
  let hovering = $state(false);
  let focused = $state(false);
  /// `cycling` is the explicit, persisted preference. `hovering` /
  /// `focused` form the transient pause that lets users finish
  /// reading a slide; both axes independently suppress the timer.
  /// Defaults to true so `undefined` reads as "auto-rotate on".
  const cycling = $derived<boolean>(
    currentPreferences()?.empty_pane_carousel_cycling ?? true,
  );
  const paused = $derived(
    hovering || focused || !cycling || !active || !autoRotate,
  );
  let containerEl: HTMLDivElement | undefined = $state();

  /// Auto-rotate while neither hovered nor focused AND the user
  /// hasn't explicitly stopped the cycle. Reset the interval on
  /// every dependency change (slideIndex bumped by keyboard
  /// nudges, paused toggled by hover/focus/cycling) so manual nav
  /// doesn't lose the next-tick budget.
  $effect(() => {
    void slideIndex;
    void disabledSlots;
    if (paused) return;
    const handle = window.setInterval(() => {
      onSlideChange?.(nextEnabled(slideIndex));
    }, 5000);
    return () => window.clearInterval(handle);
  });

  async function toggleCycling(): Promise<void> {
    const next = !cycling;
    if (workspace.info) {
      workspace.info = {
        ...workspace.info,
        preferences: {
          ...workspace.info.preferences,
          empty_pane_carousel_cycling: next,
        },
      };
    }
    try {
      await api.setEmptyPaneCarouselCycling(next);
    } catch (err) {
      ui.status = `carousel toggle failed: ${(err as Error).message}`;
    }
  }

  function prev(): void {
    onSlideChange?.(prevEnabled(slideIndex));
  }
  function next(): void {
    onSlideChange?.(nextEnabled(slideIndex));
  }
  function goTo(i: number): void {
    if (!slotEnabled(i)) return;
    onSlideChange?.(((i % slideCount) + slideCount) % slideCount);
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      prev();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    }
  }

  /// Re-fetch indexing state when the Search slide (index 1) becomes
  /// active, and poll every 3 s while it stays visible so orange (in-flight)
  /// nodes can flip to green as the indexer makes progress. The
  /// cleanup clears the timer on slide change / unmount so we
  /// never hammer the server in the background.
  $effect(() => {
    if (slideIndex !== 1 || !active) return;
    void refreshIndexing();
    const handle = window.setInterval(() => {
      void refreshIndexing();
    }, 3000);
    return () => window.clearInterval(handle);
  });

  onDestroy(() => {
    // The $effect cleanup already clears the interval, but if the
    // component is unmounted mid-tick we make sure nothing
    // references a stale element.
    containerEl = undefined;
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="carousel"
  class:carousel-wide={slideIndex === 1}
  bind:this={containerEl}
  role="region"
  aria-label="empty pane carousel"
  aria-roledescription="carousel"
  tabindex="0"
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => (hovering = false)}
  onfocusin={() => (focused = true)}
  onfocusout={() => (focused = false)}
  onkeydown={onKeyDown}
>
  <!-- The indexing slide drops the 720px stage cap so the graph
       fills the tab width/height (minus a 10px breathing border).
       The About + Workspace slides keep the centered column: their
       content is text-shaped and centered reads better there. -->
  <div class="slide-stage" class:slide-stage-wide={slideIndex === 1}>
    <!-- Carousel slot order: 0 Workspace, 1 Search (indexing graph), 2
         About. The blocks below stay in their original source order
         (About, Workspace, indexing) but each guard now tests its NEW
         index, so the `{:else}` indexing block catches the remaining
         index 1. -->
    {#if slideIndex === 2}
      <!-- About slot (index 2 / last): version + attributions plus
           a "Fund the work" CTA with the donation QR + the website
           / source links, so the user has one self-contained
           surface to learn what chan is and how to support it. -->
      <div class="slide slide-about" aria-label="About">
        <div class="slide-title">About</div>
        <div class="about-grid">
          <span class="k">chan version</span>
          <span class="v mono">
            {buildInfo?.version ?? "n/a"}
            <a
              class="version-license"
              href="https://github.com/fiorix/chan/blob/main/LICENSE"
              target="_blank"
              rel="noopener">Apache 2.0</a>
          </span>
        </div>

        <div class="about-links">
          <a
            class="about-link"
            href="https://chan.app"
            target="_blank"
            rel="noopener"
            title="chan.app"
          >
            <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>chan.app</span>
          </a>
          <a
            class="about-link"
            href="https://github.com/fiorix/chan"
            target="_blank"
            rel="noopener"
            title="github.com/fiorix/chan"
          >
            <Code2 size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>github.com/fiorix/chan</span>
          </a>
        </div>

        <div class="about-fund">
          <div class="fund-copy">
            <div class="fund-title">Fund the work</div>
            <p class="fund-text">
              Chan is independent software. Small tips help cover time
              spent on releases, packaging, and documentation.
              Share the love, cheers!
            </p>
          </div>
          <img
            class="fund-qr"
            src={withTokenQuery("/qr-donate.png")}
            alt="Donation QR code"
            width="160"
            height="160"
          />
        </div>

        <!-- Separator below the Fund-the-work QR, above the
             free/open-source tagline. Chan's own Apache 2.0 license sits
             on the version row. -->
        <div class="about-sep" role="separator" aria-hidden="true"></div>

        <!-- A one-line statement that
             chan is built on open source + is itself free/open-source
             (Apache 2.0, on the version row above). The detailed dependency
             list was too much for the About page, so it was dropped. -->
        <div class="about-credits">
          <p class="credits-tagline">
            Built on a strong open-source foundation. Chan is free and
            open-source software.
          </p>
        </div>
      </div>
    {:else if slideIndex === 0}
      <!-- Workspace slot (index 0 / first) hosts `WorkspaceInfoBody`,
           the same inspector body the file browser shows when the
           workspace-root row is selected. Folder-mode parity content;
           the per-workspace config now lives on this slot's flip-back
           (WorkspaceSlotConfig). `WorkspaceInfoBody` owns its own scroll
           affordance via the slide's `overflow: auto`. -->
      <div class="slide slide-workspace" aria-label="Workspace info">
        <div class="slide-title">Workspace</div>
        <div class="workspace-info-host">
          <WorkspaceInfoBody
            variant="dashboard"
            onLanguageClick={openGraphForLanguage}
            onContactNavigate={openGraphForContact}
          />
        </div>
      </div>
    {:else}
      <!-- Search slot (index 1 / middle): the read-only, spine-only
           indexing graph. We synthesize a directory-only `folder`-node spine from
           `/api/indexing/state` and feed it to the same
           `GraphCanvas` the main Graph tab uses; the per-directory
           `indexState` drives the green / grey / pulsing-orange
           palette inside the canvas. No chrome (inspector / scope
           picker / depth slider / filter chips): the slide is purely
           a status read-out. -->
      <div class="slide slide-indexing" aria-label="Indexing graph">
        <!-- The slot is labelled "Search": the graph itself is the indexing
             spine, so its aria-label stays "Indexing graph". -->
        <div class="slide-title">Search</div>
        {#if indexingError}
          <div class="indexing-stub">
            <p>Couldn't load indexing state.</p>
            <p class="indexing-state">{indexingError}</p>
          </div>
        {:else if !indexing && indexingLoading}
          <div class="indexing-stub">
            <p>Loading indexing state...</p>
          </div>
        {:else if !indexing}
          <div class="indexing-stub">
            <p>Indexing state unavailable.</p>
          </div>
        {:else if indexingGraph.nodes.length === 0}
          <div class="indexing-stub">
            <p>No directories to graph yet.</p>
            {#if indexLabel}
              <p class="indexing-state">currently {indexLabel}</p>
            {/if}
          </div>
        {:else}
          <div class="indexing-row">
            <div class="indexing-graph-host">
              <GraphCanvas
                open={slideIndex === 1}
                paused={!active}
                nodes={indexingGraph.nodes}
                edges={indexingGraph.edges}
                visibleNodeIds={indexingNodeIds}
                visibleEdges={indexingGraph.edges}
                focalIds={indexingFocal}
                focalAnchor="bottom"
                selectedId={selectedIndexId}
                onSelect={onIndexingSelect}
              />
            </div>
            <!-- Selecting a directory node surfaces the same
                 FileInfoBody (via InspectorBody's directory arm)
                 that the File Browser + Graph tab use for folder
                 rows. Clicking the canvas background calls
                 onSelect(null) which clears `selectedIndexId`; the
                 inspector collapses with it. -->
            {#if selectedIndexPath !== null}
              <div class="indexing-inspector" role="complementary" aria-label="directory details">
                <div class="indexing-inspector-head">
                  <span class="indexing-inspector-title">{selectedIndexLabel}</span>
                  <button
                    type="button"
                    class="indexing-inspector-close"
                    aria-label="close inspector"
                    onclick={() => onIndexingSelect(null)}
                  >×</button>
                </div>
                <div class="indexing-inspector-body">
                  <!-- This index-graph inspector is directory-only and
                       read-only. Suppress Upload (allowUpload=false) and bind
                       the same dir helpers the File Browser tree menu uses, so
                       it offers Show Directory / Graph from here / New Terminal
                       (Download stays). Each guards on selectedIndexPath; the
                       block is already gated on it being non-null. -->
                  <InspectorBody
                    selection={{
                      kind: "directory",
                      path: selectedIndexPath,
                      label: selectedIndexLabel,
                    }}
                    showRefs={false}
                    allowUpload={false}
                    onReveal={() => {
                      if (selectedIndexPath === null) return;
                      revealPathInBrowser(selectedIndexPath, {
                        enter: true,
                        inspectorOpen: true,
                      });
                    }}
                    onSetAsScope={() => {
                      if (selectedIndexPath === null) return;
                      openFsGraphForDirectory(selectedIndexPath);
                    }}
                    onNewTerminal={() => {
                      if (selectedIndexPath === null) return;
                      openTerminalInPane(
                        layout.activePaneId,
                        terminalFromHereTarget(selectedIndexPath, true),
                      );
                    }}
                  />
                </div>
              </div>
            {/if}
          </div>
          <div class="indexing-legend" aria-hidden="true">
            <span class="legend-pair">
              <span class="dot" style="background: var(--accent);"></span>
              indexed
            </span>
            {#if hasIndexingNodes}
              <span class="legend-pair">
                <span class="dot pulse" style="background: var(--g-doc);"></span>
                indexing
              </span>
            {/if}
            {#if hasPendingNodes}
              <span class="legend-pair">
                <span class="dot" style="background: var(--text-secondary);"></span>
                pending
              </span>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="carousel-controls">
    <button
      class="nav-arrow"
      type="button"
      onclick={prev}
      aria-label="previous slide"
    >
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <div class="dots" role="tablist" aria-label="carousel slides">
      {#each enabledSlots as i (i)}
        <button
          type="button"
          class="dot-btn"
          class:active={slideIndex === i}
          role="tab"
          aria-selected={slideIndex === i}
          aria-label={`slide ${i + 1}`}
          onclick={() => goTo(i)}
        ></button>
      {/each}
    </div>
    <button
      class="nav-arrow"
      type="button"
      onclick={next}
      aria-label="next slide"
    >
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <!-- Persisted cycle toggle. Sits to the right of the dots so it
         doesn't compete with the navigation affordances; the icon
         mirrors the standard play/pause-while-cycling convention.
         Pointer-hover-pause and focus-pause stay independent (those
         are transient, this one is the explicit user choice). -->
    <button
      class="cycle-toggle"
      type="button"
      onclick={toggleCycling}
      aria-label={cycling ? "stop carousel cycle" : "resume carousel cycle"}
      title={cycling ? "Stop cycling" : "Resume cycling"}
    >
      {#if cycling}
        <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
      {:else}
        <Play size={14} strokeWidth={1.75} aria-hidden="true" />
      {/if}
    </button>
  </div>
</div>

<style>
  .carousel {
    /* The carousel must size to its tab host. `flex: 1` +
       `min-height: 0` lets it fill the Dashboard tab's flex column
       without trapping overflow at the carousel root. Slide-level
       scroll handles content that overflows the current size;
       resizing the host tab reflows naturally because the
       slide-stage uses the parent's box. */
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem 1rem 1rem;
    outline: none;
    gap: 1rem;
  }
  /* Slides use a centered-stack rhythm (soft type, secondary
     color). The stage fills the remaining vertical space inside the
     carousel; each slide scrolls independently when its content
     exceeds the stage. */
  .slide-stage {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 720px;
  }
  /* Indexing slide variant. The graph slide needs the full tab
     width/height to read; the column cap that suits About +
     Workspace text content makes the spine look constrained to a
     vertical band. `max-width: none` drops the 720px cap; the
     carousel-wide variant tightens the carousel's own padding so the
     breathing border around the canvas reads as ~10px instead of the
     16-32px the About/Workspace slides want. */
  .slide-stage-wide {
    max-width: none;
  }
  .carousel-wide {
    padding: 10px;
  }
  .slide {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    color: var(--text-secondary);
    flex: 1;
    min-height: 0;
    width: 100%;
    /* Slide owns the vertical overflow so the inspector / about
       content stays scrollable when the tab shrinks. Horizontal
       stays hidden so the dot/nav row below the stage never
       wraps. */
    overflow-y: auto;
    overflow-x: hidden;
  }
  .slide-title {
    font-size: 14px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-secondary);
    opacity: 0.7;
  }
  /* --- Slide 2 (About) --- */
  .slide-about {
    align-items: stretch;
    gap: 0.9rem;
    color: var(--text);
    opacity: 1;
    /* The bottom pad matches the carousel's own 2rem above the slide. The
       slide owns the vertical scroll, so without it the credits line ends
       flush against the stage edge whenever the About content is taller
       than the tab, while the top of the same card keeps its margin. */
    padding: 0 0.25rem 2rem;
  }
  .slide-about .slide-title {
    align-self: center;
  }
  .about-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 14px;
    font-size: 13px;
    width: 100%;
  }
  .about-grid .k {
    color: var(--text-secondary);
  }
  .about-grid .v {
    color: var(--text);
  }
  .about-grid .v.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  /* Chan's own license sits on the version row, spaced from the
     version string and styled as a link rather than mono text. */
  .about-grid .version-license {
    margin-left: 0.6rem;
    color: var(--link, var(--text));
    text-decoration: underline;
  }
  .about-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    font-size: 13px;
  }
  .about-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--link, var(--text));
    text-decoration: none;
  }
  .about-link:hover,
  .about-link:focus-visible {
    text-decoration: underline;
  }
  .about-fund {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--border);
    flex-wrap: wrap;
  }
  .fund-copy {
    flex: 1;
    min-width: 200px;
  }
  .fund-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
  }
  .fund-text {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.4;
  }
  .fund-qr {
    width: 160px;
    height: 160px;
    image-rendering: pixelated;
    border-radius: 6px;
    background: #fff;
    padding: 6px;
    flex-shrink: 0;
  }
  /* Separator between the Fund-the-work QR and the free/open-source
     tagline below it. */
  .about-sep {
    height: 1px;
    background: var(--border);
    opacity: 0.6;
    margin: 0.25rem 0;
  }
  /* Open-source attribution. A flowing credits paragraph rather
     than the k/v grid above, since the library list is long; same
     muted/underlined-link treatment as the licenses block. */
  .about-credits {
    width: 100%;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .about-credits .credits-tagline {
    color: var(--text);
    margin: 0;
  }
  /* --- Slide 0 (Workspace info) --- */
  .slide-workspace {
    align-items: stretch;
    padding: 0;
    gap: 0.5rem;
    color: var(--text);
    opacity: 1;
  }
  .slide-workspace .slide-title {
    align-self: center;
  }
  .workspace-info-host {
    flex: 1;
    min-height: 0;
    width: 100%;
  }
  /* --- Slide 1 (Indexing graph) --- */
  /* `slide` defaults to `align-items: center` which would collapse
     the canvas host to its intrinsic width. The indexing slide
     wants the spine to occupy the full slide width, so we stretch
     the cross-axis here. */
  .slide-indexing {
    align-items: stretch;
    gap: 0.5rem;
    color: var(--text);
    opacity: 1;
    overflow: hidden;
  }
  .slide-indexing .slide-title {
    align-self: center;
  }
  .indexing-stub {
    text-align: center;
    max-width: 360px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-secondary);
  }
  .indexing-stub p {
    margin: 0 0 0.5rem;
  }
  .indexing-state {
    color: var(--warn-text);
    font-size: 12px;
  }
  /* GraphCanvas fills its host. The host itself flex-grows inside
     the slide so the spine renders into the full available area and
     reflows with the Dashboard tab resize, just like the main Graph
     tab. `.indexing-row` wraps the canvas host + the inline
     inspector side-by-side; the host flex-grows so the inspector
     slides in without pushing the graph off-screen. */
  .indexing-row {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    flex-direction: row;
    gap: 0.5rem;
    align-items: stretch;
    min-width: 0;
  }
  .indexing-graph-host {
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
  }
  .indexing-inspector {
    flex: 0 0 320px;
    min-width: 0;
    max-width: 50%;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--bg-card, var(--bg));
    overflow: hidden;
  }
  .indexing-inspector-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
    gap: 0.5rem;
    font-size: 12px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .indexing-inspector-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .indexing-inspector-close {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
  }
  .indexing-inspector-close:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .indexing-inspector-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0.5rem 0.75rem;
  }
  .indexing-legend {
    display: flex;
    gap: 14px;
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 4px;
    align-self: center;
  }
  .indexing-legend .legend-pair {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .indexing-legend .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  /* Indexing-state legend pulse mirrors the GraphCanvas pulse on
     in-flight directory nodes (alpha modulation, ~1100ms cycle).
     The canvas paint loop handles the node-level animation in JS;
     this keyframe keeps the legend swatch in sync visually. */
  .indexing-legend .dot.pulse {
    animation: indexing-pulse 1.1s ease-in-out infinite;
  }
  @keyframes indexing-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }
  @media (prefers-reduced-motion: reduce) {
    .indexing-legend .dot.pulse {
      animation: none;
    }
  }
  /* --- Controls --- */
  .carousel-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 0.25rem;
  }
  .nav-arrow,
  .cycle-toggle {
    background: none;
    border: 0;
    padding: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    opacity: 0.5;
    transition: opacity 120ms ease, background 120ms ease;
  }
  .nav-arrow:hover,
  .cycle-toggle:hover {
    opacity: 1;
    background: var(--hover-bg);
  }
  /* Soft separator between the navigation cluster and the
     cycle toggle so they read as two control groups. */
  .cycle-toggle {
    margin-left: 6px;
    border-left: 1px solid var(--border);
    border-radius: 0 4px 4px 0;
    padding-left: 8px;
  }
  .dots {
    display: inline-flex;
    gap: 6px;
  }
  .dot-btn {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 0;
    padding: 0;
    background: var(--text-secondary);
    opacity: 0.35;
    cursor: pointer;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .dot-btn:hover {
    opacity: 0.7;
  }
  .dot-btn.active {
    opacity: 0.9;
    transform: scale(1.2);
  }
  /* No inset focus ring here. The surrounding `.pane.focused` style
     (Pane.svelte) already draws the focus indicator around the
     entire pane in the multi-pane case; a second 2px ring around
     just the carousel body would paint a visibly thicker border on
     the body than along the top-bar chrome. Single-pane empty
     carousels have no indicator either way (there's only one pane to
     be focused). */
</style>
