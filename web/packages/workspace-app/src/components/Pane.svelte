<script lang="ts">
  // One pane: a horizontal tab strip on top, an editor below.

  import {
    activeLayout,
    activeTabInPane,
    allPaneTabs,
    bumpTabFocusPulse,
    closeTab,
    enterPaneMode,
    enterPaneModeTransaction,
    flipHybrid,
    focusColorForWindow,
    isDirty,
    detachTabToPaneEdge,
    layout,
    markLocalTabDrop,
    markTerminalMovingOut,
    moveTab,
    openExtensionInPane,
    openInPane,
    openTerminalInPane,
    reattachTerminalInPane,
    paneMode,
    paneModeSplit,
    paneModeMoveGrabToEdge,
    paneModeRemoveStagedDraftEditor,
    paneModeSetGrab,
    paneModeSetHover,
    paneModeSetMouseSplit,
    paneModeStagedDraftEditorsFor,
    paneModeStagedTabIds,
    paneModeSwapWith,
    paneActiveTabId,
    paneSideToggleFlash,
    paneWobble,
    paneSide,
    paneTabs,
    reorderTab,
    reopenClosedTab,
    selectTabInPane,
    setActivePane,
    setWindowFocusColor,
    setTerminalActivity,
    shouldCloseTabAfterDragEnd,
    type PaneSide,
    type FocusColor,
    type LeafNode,
    type PaneDropEdge,
    type Tab,
  } from "../state/tabs.svelte";

  import {
    BarChart2,
    Blocks,
    Bug,
    Check,
    FileText,
    Folder,
    Command as CommandIcon,
    LayoutGrid,
    Network,
    Palette,
    Presentation,
    Radio,
    RefreshCw,
    Shapes,
    Terminal,
    User,
    Users,
    X,
  } from "lucide-svelte";

  import EmptyPaneWelcome from "./EmptyPaneWelcome.svelte";
  import ExtensionTab from "./ExtensionTab.svelte";
  import FileEditorTab from "./FileEditorTab.svelte";
  import DashboardTab from "./DashboardTab.svelte";
  import FileBrowserSurface from "./FileBrowserSurface.svelte";
  import GraphPanel from "./GraphPanel.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";
  import TerminalTab from "./TerminalTab.svelte";
  import {
    ui,
    workspaceDisplayName,
    tree,
  } from "../state/store.svelte";
  import { workspace } from "../state/workspace.svelte";
  import { isExcalidraw } from "../state/fileTypes";
  import {
    isTauriDesktop,
    openWebInspector,
    reloadWindow,
  } from "../api/desktop";
  import { notify } from "../state/notify.svelte";
  import {
    tabLabel,
    tabLabelInPane,
    tabTooltip,
    terminalBroadcastReachCount,
  } from "../state/tabs.svelte";
  import type { BrowserLabelCtx } from "../state/tabs.svelte";
  import { chordFor } from "../state/shortcuts";
  import { openTabMenu, tabMenu } from "../state/tabMenu.svelte";
  import {
    api,
    dragScopeMimeToken,
    sessionWindowId,
    windowDragScope,
    windowLibraryId,
  } from "../api/client";
  import { ApiError } from "../api/errors";
  import { applyNamedFocusColor } from "../state/paneColor";
  import {
    classifyMouseSplitZone,
    edgeSplitAllowed,
  } from "../state/paneMouseSplit";
  import { onDestroy, onMount } from "svelte";
  import { applyPageWidthToElement, pageWidth } from "../state/pageWidth.svelte";

  let { pane }: { pane: LeafNode } = $props();

  const visibleSide = $derived(paneSide(pane));
  const visibleTabs = $derived(paneTabs(pane, visibleSide));
  const visibleActiveTabId = $derived(paneActiveTabId(pane, visibleSide));
  const active = $derived(activeTabInPane(pane, visibleSide));
  const everyTab = $derived(allPaneTabs(pane));
  type PaneFlipAxis = "horizontal" | "vertical";

  function isVisibleTab(tab: Tab): boolean {
    return visibleTabs.some((candidate) => candidate.id === tab.id);
  }

  function isLiveActive(tab: Tab): boolean {
    return !paneMode.active && tab.id === visibleActiveTabId && isVisibleTab(tab);
  }

  function sideForTab(tab: Tab): PaneSide {
    return paneTabs(pane, "b").some((candidate) => candidate.id === tab.id)
      ? "b"
      : "a";
  }

  /// Per-row is_dir lookup for the active tree, keyed by path. Workspaces
  /// the File-Browser tab title which needs to render "the parent
  /// dir of the selected file" or "the selected directory" - and
  /// the only way to disambiguate file vs dir on a `selected` path
  /// is to consult the tree. Re-derives whenever the tree refreshes.
  const treeIsDir = $derived<Map<string, boolean>>(
    new Map(tree.entries.map((e) => [e.path, e.is_dir])),
  );
  function browserCtxFor(tab: Tab): BrowserLabelCtx {
    if (tab.kind !== "browser") return {};
    const sel = tab.selected ?? undefined;
    const selectedIsDir = sel ? treeIsDir.get(sel) : undefined;
    return { workspaceName: workspaceDisplayName(), selectedIsDir };
  }

  function tabPathOverflow(
    node: HTMLElement,
    label: string,
  ): { update(label: string): void; destroy(): void } {
    let frame: number | null = null;

    const measure = () => {
      frame = null;
      node.classList.toggle("overflowing", node.scrollWidth > node.clientWidth + 1);
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(node);
    void label;
    schedule();

    return {
      update(nextLabel: string) {
        void nextLabel;
        schedule();
      },
      destroy() {
        resizeObserver?.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
      },
    };
  }

  /// Per-path "is this file a contact?" lookup. Workspaces the tab-strip
  /// icon (User glyph for contacts, FileText otherwise) so a row of
  /// tabs reads as "person, file, file, person" rather than a wall
  /// of equally-weighted text. The kind comes from the tree listing's
  /// `chan.kind: contact` discriminator; re-derives whenever the
  /// tree refreshes.
  const contactPaths = $derived<Set<string>>(
    new Set(
      tree.entries
        .filter((e) => !e.is_dir && e.kind === "contact")
        .map((e) => e.path),
    ),
  );

  const paneFocusColors: FocusColor[] = ["blue", "orange", "green", "pink"];

  /// Resolve a command's chord for the pane chrome menus, override-aware
  /// (user assignment first, then the built-in), empty when unbound.
  function chordLabel(id: string | undefined): string {
    return id ? (chordFor(id) ?? "") : "";
  }
  const flipChord = $derived(chordLabel("app.pane.flip"));
  const sideToggleTitle = $derived(
    `Flip to side ${visibleSide === "a" ? "B" : "A"}${flipChord ? ` (${flipChord})` : ""}`,
  );

  /// Empty panes have no right-click context menu. The pane hamburger
  /// and the command launcher are the discovery surfaces for spawn
  /// actions; the hamburger also keeps the pane-local chrome controls.

  /// Pane chrome menu: the ⋮ in the tab strip that replaces the
  /// per-button split / close controls.
  let paneMenu: HamburgerMenu | undefined = $state();
  let paneMenuOpen = $state(false);
  let paneContextMenu: HamburgerMenu | undefined = $state();
  let paneContextMenuOpen = $state(false);

  /// Per-pane page-width cap. The ratio (state/pageWidth) is
  /// global, but the px cap is pane-relative so splitting one
  /// pane into two halves correctly halves the cap. A
  /// ResizeObserver on .editor-wrap fires whenever the pane
  /// resizes (split, close, window resize, browser zoom) and
  /// pushes a fresh `--chan-page-max-width` onto the wrapper as
  /// inline style. CSS cascade beats the document-root fallback.
  let editorWrapEl: HTMLDivElement | undefined = $state();
  let editorWrapWidth = $state(0);
  let resizeObs: ResizeObserver | null = null;
  $effect(() => {
    if (!editorWrapEl) return;
    resizeObs?.disconnect();
    const target = editorWrapEl;
    resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        editorWrapWidth = Math.round(entry.contentRect.width);
      }
    });
    resizeObs.observe(target);
    // Prime synchronously so the first paint already has the cap.
    editorWrapWidth = Math.round(target.getBoundingClientRect().width);
    return () => {
      resizeObs?.disconnect();
      resizeObs = null;
    };
  });
  $effect(() => {
    if (!editorWrapEl) return;
    applyPageWidthToElement(editorWrapEl, editorWrapWidth, pageWidth.ratio);
  });
  onDestroy(() => resizeObs?.disconnect());

  /// Transaction-mode (mouse-driven NAV) handlers.
  ///
  /// Two entry paths target the same dead zone on the top bar (the
  /// stretch between the last tab and the hamburger). Entry A is a
  /// drag-with-payload: mousedown + drag past the threshold enters
  /// NAV with the originating pane already grabbed. Entry B is a
  /// double-click: enter NAV in standby, the next click + drag
  /// inside any pane sets the grab.
  ///
  /// Once in transaction mode: pane-body mousedown sets grab + a
  /// pending start point; pane-body mouseenter (cursor under grab)
  /// tracks the drop target; pane-body mouseup commits a swap with
  /// the current drop target. Enter / Esc / Cmd+. exit through the
  /// same paths as keyboard NAV (handled at App.svelte).
  const DEAD_ZONE_DRAG_THRESHOLD_PX = 5;
  let deadZoneDragStart: { x: number; y: number } | null = null;

  function onDeadZoneMouseDown(e: MouseEvent): void {
    if (paneMode.stale) return;
    if (e.button !== 0) return;
    deadZoneDragStart = { x: e.clientX, y: e.clientY };
    window.addEventListener("mousemove", onDeadZoneMouseMove);
    window.addEventListener("mouseup", onDeadZoneMouseUp);
  }

  function onDeadZoneMouseMove(e: MouseEvent): void {
    if (!deadZoneDragStart) return;
    if (paneMode.stale) {
      onDeadZoneMouseUp();
      return;
    }
    const dx = e.clientX - deadZoneDragStart.x;
    const dy = e.clientY - deadZoneDragStart.y;
    if (Math.hypot(dx, dy) < DEAD_ZONE_DRAG_THRESHOLD_PX) return;
    deadZoneDragStart = null;
    window.removeEventListener("mousemove", onDeadZoneMouseMove);
    window.removeEventListener("mouseup", onDeadZoneMouseUp);
    enterPaneModeTransaction(pane.id);
  }

  function onDeadZoneMouseUp(): void {
    deadZoneDragStart = null;
    window.removeEventListener("mousemove", onDeadZoneMouseMove);
    window.removeEventListener("mouseup", onDeadZoneMouseUp);
  }
  // A mousedown that never reaches mouseup / the drag threshold (e.g. the
  // pane unmounts mid-press) would leak these window listeners; drop them
  // unconditionally on teardown.
  onDestroy(() => {
    window.removeEventListener("mousemove", onDeadZoneMouseMove);
    window.removeEventListener("mouseup", onDeadZoneMouseUp);
  });

  function onDeadZoneDblClick(): void {
    if (paneMode.stale) return;
    enterPaneModeTransaction(null);
  }

  /// Pane-body mousedown while in transaction mode. Two roles:
  /// (1) if no grab is held, set this pane as the grab (Entry B
  /// path picks up here when the user clicks + drags into a pane).
  /// (2) when a grab is held but on a different pane, treat the
  /// new mousedown as a re-grab (the user changed their mind).
  /// The hoverPaneId tracking on mouseenter handles the drop side.
  function onPaneBodyMouseDown(e: MouseEvent): void {
    if (paneMode.stale) return;
    if (!paneMode.transactionMode) return;
    if (e.button !== 0) return;
    paneModeSetGrab(pane.id);
  }

  function onPaneBodyMouseEnter(): void {
    if (paneMode.stale) return;
    if (!paneMode.transactionMode) return;
    if (!paneMode.grabPaneId) return;
    paneModeSetHover(pane.id);
  }

  function onPaneBodyMouseLeave(): void {
    if (paneMode.stale) return;
    if (!paneMode.transactionMode) return;
    if (paneMode.hoverPaneId === pane.id) paneModeSetHover(null);
    if (paneMode.mouseSplit?.paneId === pane.id) paneModeSetMouseSplit(null);
  }

  /// Zone tracking over a hovered pane while a grab is held. The pane
  /// divides into 25 percent edge zones plus a center: the center keeps
  /// the swap affordance, an allowed edge arms the split preview, and a
  /// refused edge (the split would violate the minimum pane size) drops
  /// the target entirely rather than falling back to a swap.
  function onPaneBodyMouseMove(e: MouseEvent): void {
    if (paneMode.stale) return;
    if (!paneMode.transactionMode) return;
    const grab = paneMode.grabPaneId;
    if (!grab || grab === pane.id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = classifyMouseSplitZone(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
    );
    if (zone !== "center" && edgeSplitAllowed(zone, rect.width, rect.height)) {
      paneModeSetHover(pane.id);
      paneModeSetMouseSplit({ paneId: pane.id, edge: zone });
      return;
    }
    paneModeSetMouseSplit(null);
    if (zone === "center") paneModeSetHover(pane.id);
    else paneModeSetHover(null);
  }

  /// Pane-body mouseup while in transaction mode with a grab held.
  /// If the cursor is over this pane (we are the drop target) and
  /// the grab is on a different pane, commit the armed action: an edge
  /// preview splits the target and moves the grabbed content into the
  /// new sibling, the center keeps the swap. A refused edge cleared the
  /// hover, so the mouseup is a no-op and the grab survives for the
  /// next attempt. Transaction stays active for chained drops until
  /// Enter / Esc.
  function onPaneBodyMouseUp(): void {
    if (paneMode.stale) return;
    if (!paneMode.transactionMode) return;
    const grab = paneMode.grabPaneId;
    if (!grab) return;
    if (grab === pane.id) {
      paneModeSetGrab(null);
      return;
    }
    const preview = paneMode.mouseSplit;
    if (preview && preview.paneId === pane.id) {
      paneModeMoveGrabToEdge(grab, pane.id, preview.edge);
    } else if (paneMode.hoverPaneId !== pane.id) {
      return;
    } else {
      paneModeSwapWith(grab, pane.id);
    }
    paneModeSetMouseSplit(null);
    paneModeSetGrab(null);
    paneModeSetHover(null);
  }

  /// True when this pane is the drop target under a held grab. Workspaces
  /// the outline cue. Distinct from the keyboard-NAV active-pane
  /// highlight so the user can tell drop-target apart from focus.
  const isTransactionGrab = $derived(
    paneMode.transactionMode && paneMode.grabPaneId === pane.id,
  );
  /// Edge zone currently previewed on this pane, or null. An armed edge
  /// replaces the full-pane swap cue with the split-half preview.
  const transactionSplitEdge = $derived(
    paneMode.transactionMode && paneMode.mouseSplit?.paneId === pane.id
      ? paneMode.mouseSplit.edge
      : null,
  );
  const isTransactionDropTarget = $derived(
    paneMode.transactionMode &&
      paneMode.grabPaneId !== null &&
      paneMode.grabPaneId !== pane.id &&
      paneMode.hoverPaneId === pane.id &&
      transactionSplitEdge === null,
  );

  /// Ids of tabs added by app-spawn chords during the current
  /// pane-mode session. Each entry is a "ghost tab": visible in the
  /// draft layout but not yet committed to the live one. Empty when
  /// pane mode is inactive.
  /// Derived so the tab strip rerenders the dimmed class as
  /// chords land and as commit / cancel clear the set.
  const paneModeStagedSet = $derived(paneModeStagedTabIds());
  const paneModeStagedEditors = $derived(
    paneModeStagedDraftEditorsFor(pane.id, visibleSide),
  );

  /// Subscribe to the structural-wobble bus. Each splitPane /
  /// closePane / paneModeSwap bumps `paneWobble.versions[pane.id]`;
  /// we mirror that into a class toggle so the CSS animation
  /// re-fires (CSS animations don't replay on a static class -   /// we briefly drop the class, then re-add it on rAF). The
  /// `onanimationend` handler clears the class so the next event
  /// can re-trigger cleanly.
  const wobbleVersion = $derived(paneWobble.versions[pane.id] ?? 0);
  let paneEl: HTMLDivElement | undefined = $state();
  let wobbleActive = $state(false);
  let lastWobbleVersion = 0;
  $effect(() => {
    if (wobbleVersion === lastWobbleVersion) return;
    lastWobbleVersion = wobbleVersion;
    if (wobbleVersion === 0) return;
    wobbleActive = false;
    requestAnimationFrame(() => {
      wobbleActive = true;
    });
  });

  const sideToggleFlashVersion = $derived(paneSideToggleFlash.versions[pane.id] ?? 0);
  let sideToggleFlashActive = $state(false);
  let lastSideToggleFlashVersion = 0;
  let sideToggleFlashFrame: number | null = null;

  function clearSideToggleFlashFrame(): void {
    if (sideToggleFlashFrame !== null) {
      cancelAnimationFrame(sideToggleFlashFrame);
      sideToggleFlashFrame = null;
    }
  }

  $effect(() => {
    if (sideToggleFlashVersion === lastSideToggleFlashVersion) return;
    lastSideToggleFlashVersion = sideToggleFlashVersion;
    if (sideToggleFlashVersion === 0) return;
    sideToggleFlashActive = false;
    clearSideToggleFlashFrame();
    sideToggleFlashFrame = requestAnimationFrame(() => {
      sideToggleFlashFrame = null;
      sideToggleFlashActive = true;
    });
  });

  /// Side flips animate on the axis that matches the pane's shape:
  /// wide panes turn horizontally, tall panes turn vertically, and a
  /// square pane chooses either axis so both orientations stay possible.
  // Tracks the 520ms CSS literal on the `pane-side-flip` animation below; a
  // cross-package share with the launcher's flip.ts is off the table (its
  // ?raw pins forbid extraction), so the two copies pin each other instead.
  const SIDE_FLIP_DURATION_MS = 520;
  let sideFlipActive = $state(false);
  let sideFlipAxis = $state<PaneFlipAxis>("horizontal");
  let sideFlipStartTransform = $state("rotateY(-180deg)");
  let sideFlipBackTransform = $state("rotateY(-180deg)");
  let lastSideForFlip: PaneSide | null = null;
  let sideFlipFrame: number | null = null;
  let sideFlipTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSideFlipHandles(): void {
    if (sideFlipFrame !== null) {
      cancelAnimationFrame(sideFlipFrame);
      sideFlipFrame = null;
    }
    if (sideFlipTimer !== null) {
      clearTimeout(sideFlipTimer);
      sideFlipTimer = null;
    }
  }

  function sideFlipAxisForPane(): PaneFlipAxis {
    const rect = paneEl?.getBoundingClientRect();
    const width = Math.round(rect?.width ?? 0);
    const height = Math.round(rect?.height ?? 0);
    if (height > width) return "vertical";
    if (width > height) return "horizontal";
    return Math.random() < 0.5 ? "vertical" : "horizontal";
  }

  function configureSideFlip(): void {
    const axis = sideFlipAxisForPane();
    const rotate = axis === "vertical" ? "rotateY" : "rotateX";
    sideFlipAxis = axis;
    sideFlipStartTransform = `${rotate}(-180deg)`;
    sideFlipBackTransform = `${rotate}(-180deg)`;
  }

  $effect(() => {
    const side = visibleSide;
    if (lastSideForFlip === null) {
      lastSideForFlip = side;
      return;
    }
    if (lastSideForFlip === side) return;
    lastSideForFlip = side;
    configureSideFlip();
    sideFlipActive = false;
    clearSideFlipHandles();
    sideFlipFrame = requestAnimationFrame(() => {
      sideFlipFrame = null;
      sideFlipActive = true;
      // animationend clears the class in a real browser; the timer covers
      // jsdom and reduced-motion environments where it never fires, so it
      // must OUTLAST the animation instead of cancelling it mid-turn.
      sideFlipTimer = setTimeout(() => {
        sideFlipActive = false;
        sideFlipTimer = null;
      }, SIDE_FLIP_DURATION_MS + 80);
    });
  });

  onDestroy(() => {
    clearSideFlipHandles();
    clearSideToggleFlashFrame();
  });

  function closePaneMenus(): void {
    paneMenu?.close();
    paneContextMenu?.close();
  }

  $effect(() => {
    if (paneMode.stale) closePaneMenus();
  });

  function closePaneContextMenus(): void {
    paneContextMenu?.close();
  }

  function closePaneHamburgerMenu(): void {
    paneMenu?.close();
  }

  async function doReloadPane(): Promise<void> {
    closePaneMenus();
    await reloadWindow();
  }

  async function doOpenInspector(): Promise<void> {
    closePaneMenus();
    if (await openWebInspector()) return;
    notify(
      isTauriDesktop()
        ? "Inspector unavailable in this build"
        : "Use the browser's built-in inspector (Right-click → Inspect Element)",
    );
  }

  function doSetFocusColor(color: FocusColor): void {
    closePaneMenus();
    // ONE shared apply path with the launcher's app.pane.focusColor.*
    // commands (applyNamedFocusColor): per-window preset + checkmark, then
    // the per-LIBRARY doc-root recolour, then persist to the window's own
    // serving host. The PUT fires the server's colour broadcast, so
    // every OTHER open window of this library live-updates via its
    // `/api/library/local-color/watch` subscription (App.svelte), and future
    // windows still mint with it via `?pane=`.
    applyNamedFocusColor(color, setWindowFocusColor, (hex) => {
      // Best-effort: a read-only / no-store serving surface answers 403/404.
      // Swallow it -- a failed persist must never break the menu or throw -- but LOG
      // the status so a persist FAILURE on a surface that DOES have a store (e.g. a
      // local desktop window whose per-tenant token is rejected by the launcher
      // bearer gate) is visible instead of silently lost.
      void api.setLocalColor(hex).catch((err: unknown) => {
        const status = err instanceof ApiError ? err.status : "?";
        console.warn(`setLocalColor failed (status ${status}); colour not persisted`, err);
      });
    });
  }

  function openPaneContextAt(e: MouseEvent): void {
    e.preventDefault();
    setActivePane(pane.id);
    closePaneHamburgerMenu();
    paneContextMenu?.openAtCursor(e.clientX, e.clientY);
  }

  /// Fire the same `chan:command` event the keymap layer uses so
  /// every shortcut row routes through the existing dispatcher in
  /// App.svelte. Avoids re-implementing the actions here.
  function dispatchCommand(id: string): void {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: id } }),
    );
  }

  type IconComponent = typeof LayoutGrid;
  type AppRow = { id: string; title: string; icon: IconComponent };

  // One row per spawnable app surface, alphabetical by title. Six ids are
  // the chorded spawn commands; New diagram / New slide deck are the
  // chordless catalog entries runCommand also routes (App.svelte).
  const appRows: AppRow[] = [
    { id: "app.dashboard.open", title: "New dashboard", icon: BarChart2 },
    { id: "app.diagram.new", title: "New diagram", icon: Shapes },
    { id: "app.draft.new", title: "New draft", icon: FileText },
    { id: "app.files.toggle", title: "New file browser", icon: Folder },
    { id: "app.graph.toggle", title: "New graph", icon: Network },
    { id: "app.slides.new", title: "New slide deck", icon: Presentation },
    { id: "app.terminal.teamWork", title: "New team", icon: Users },
    { id: "app.terminal.toggle", title: "New terminal", icon: Terminal },
  ];

  function runAppRow(id: string): void {
    closePaneHamburgerMenu();
    dispatchCommand(id);
  }
  // Single-pane layouts hide the focus highlight: it's only useful
  // when there's more than one pane to disambiguate. Re-derives on
  // every layout mutation so the highlight reappears the moment a
  // split is added and disappears the moment the second pane closes.
  const viewLayout = $derived(activeLayout());
  const multiPane = $derived.by(() => {
    void viewLayout.rootId;
    return Object.values(viewLayout.nodes).some((n) => n.kind === "split");
  });
  const isFocused = $derived(multiPane && viewLayout.activePaneId === pane.id);
  // Drag state: highlight the tab strip while another pane's tab is being
  // dragged over it. Keyed by pane id so we don't bleed state between
  // panes that share this Svelte 5 component instance.
  let dropActive = $state(false);
  let bodyDropEdge: PaneDropEdge | null = $state(null);
  // Index where a per-tab drop indicator (a thin vertical bar) is
  // currently shown. -1 means no indicator. We render a visual bar
  // before tab[idx]; idx === visibleTabs.length means "after the
  // last tab".
  let dropIndicator = $state<number>(-1);

  // No Cmd+S save keystroke. Autosave (debounced on idle +
  // tab-close + visibility hooks) is the canonical write path, so an
  // explicit save shortcut wouldn't pull its weight. Cmd+Shift+S
  // strikethrough is owned by the editor.

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && (paneMenuOpen || paneContextMenuOpen)) {
      e.preventDefault();
      closePaneMenus();
      return;
    }
    if (
      layout.activePaneId === pane.id &&
      e.ctrlKey &&
      e.altKey &&
      e.shiftKey &&
      !e.metaKey &&
      e.code === "KeyT"
    ) {
      e.preventDefault();
      reopenClosedTab();
    }
  }

  function onChanCommand(e: Event): void {
    if (viewLayout.activePaneId !== pane.id) return;
    const detail = (e as CustomEvent<{ name?: string }>).detail;
    if (detail?.name !== "app.tab.reopenClosed") return;
    reopenClosedTab();
  }
  onMount(() => window.addEventListener("chan:command", onChanCommand));
  onDestroy(() => window.removeEventListener("chan:command", onChanCommand));

  // ----- drag & drop ------------------------------------------------------

  // Custom mimes for the kinds of drops a pane accepts:
  //   - intra-window tab move (drop from another pane's tab strip in
  //     the same window): TAB_DRAG_MIME carries `{fromPaneId, tabId}`,
  //     resolved against the local layout.
  //   - cross-window tab move (drop from another Tauri window on the
  //     same chan-app instance): CROSS_TAB_MIME carries the full
  //     payload needed to reconstruct the tab in the target window.
  //     File tabs only; special tabs are window-bound on native.
  //   - file open (from the file tree): FILE_DRAG_MIME carries
  //     `{path}`.
  //
  // dragstart sets both TAB_DRAG_MIME and CROSS_TAB_MIME for file
  // tabs so the same drag works whether the user drops in the same
  // window (intra) or another (cross). The receiver tries intra
  // first; if `fromPaneId` is not in its layout, it falls through to
  // the cross path. The source's dragend handler removes the tab if
  // the drop happened cross-window (intra moves already mutated the
  // local layout).
  const TAB_DRAG_MIME = "application/x-md-tab";
  const CROSS_TAB_MIME = "application/x-chan-tab+json";
  const FILE_DRAG_MIME = "application/x-md-file";
  type TabDragPayload = {
    fromPaneId: string;
    fromSide?: PaneSide;
    tabId: string;
    fromWindow?: string;
  };
  const activeDragSourceSides = new Map<string, PaneSide>();
  // The drag's scope (window kind + workspace identity) is carried as a MIME
  // TYPE so a target can read it during `dragover` (when payload VALUES are
  // not readable). The human-readable scope carries `:`/`|`, which WKWebView
  // mangles in a MIME type, so it is hex-encoded (dragScopeMimeToken) into a
  // `[0-9a-f]` token that round-trips byte-identically through
  // `dataTransfer.types`. See windowDragScope + isTabDragScopeCompatible.
  const SCOPE_DRAG_MIME_PREFIX = "application/x-chan-tab-scope+";
  const scopeMime = (scope: string): string =>
    SCOPE_DRAG_MIME_PREFIX + dragScopeMimeToken(scope);
  /// This window's drag scope, computed from what the SPA loaded: the owning
  /// chan-library (`?lib=`), the window kind (terminal-only vs. workspace), and
  /// the active workspace's stable identity (`metadata_key`, falling back to the
  /// absolute `root`). Two windows of the same workspace in the same library
  /// resolve to the same scope; the opaque `?w=w-<hex>` window id is deliberately
  /// NOT used (it differs per window).
  const currentDragScope = (): string =>
    windowDragScope({
      libraryId: windowLibraryId(),
      terminalOnly: ui.terminalOnly,
      workspaceKey: workspace.info?.metadata_key ?? workspace.info?.root ?? null,
    });

  function dragHasType(e: DragEvent, mime: string): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    const bag = types as unknown as {
      includes?: (value: string) => boolean;
      contains?: (value: string) => boolean;
      length: number;
      [index: number]: string;
    };
    if (typeof bag.includes === "function" && bag.includes(mime)) return true;
    if (typeof bag.contains === "function" && bag.contains(mime)) return true;
    for (let i = 0; i < bag.length; i += 1) {
      if (bag[i] === mime) return true;
    }
    return false;
  }

  function onDragStart(e: DragEvent, tabId: string, fromSide: PaneSide): void {
    if (paneMode.stale) return;
    if (!e.dataTransfer) return;
    activeDragSourceSides.set(tabId, fromSide);
    e.dataTransfer.effectAllowed = "move";
    // `fromWindow` is what actually separates an intra-window move from a
    // cross-window one: pane IDs are a per-window counter (tabs.svelte.ts
    // makeId) and COLLIDE across Tauri windows, so a stranger pane id can
    // match a same-id local pane. See isIntraWindowDrag.
    e.dataTransfer.setData(
      TAB_DRAG_MIME,
      JSON.stringify({ fromPaneId: pane.id, fromSide, tabId, fromWindow: sessionWindowId() }),
    );
    const t = paneTabs(pane, fromSide).find((tab) => tab.id === tabId);
    if (t) {
      e.dataTransfer.setData(CROSS_TAB_MIME, JSON.stringify(crossWindowPayload(t)));
    }
    // Stamp our drag scope as a type so the target can reject a cross-kind /
    // cross-workspace drop at dragover (no-drop cursor) and on drop. Non-empty
    // data avoids empty-value quirks; only the type string matters.
    e.dataTransfer.setData(scopeMime(currentDragScope()), "1");
  }

  /// Build the CROSS_TAB_MIME payload for a dragged tab. File tabs carry the
  /// path + view state; terminal tabs carry the re-attach fields. All standalone
  /// terminal windows share one `/terminal` tenant (one PTY registry), so a
  /// terminal payload with a live `terminalSessionId` lets the target window
  /// re-attach to the SAME PTY by id (a true MOVE) instead of spawning a fresh
  /// shell; the seq cursors + cwd mirror the source so the re-attach
  /// replays from where this window left off. No session (never spawned /
  /// exited) omits those fields so the target opens fresh. Other tab kinds keep
  /// the historical title-only shape (window-bound on native).
  function crossWindowPayload(t: Tab): Record<string, unknown> {
    if (t.kind === "file") {
      return {
        kind: "file",
        path: t.path,
        mode: t.mode,
        inspectorOpen: t.inspectorOpen,
      };
    }
    if (t.kind === "terminal") {
      return {
        kind: "terminal",
        title: t.title,
        ...(t.terminalSessionId
          ? {
              terminalSessionId: t.terminalSessionId,
              // The moved shell's real CHAN_TAB_NAME, so the target can decide
              // whether a conflict-forced rename leaves the env stale (warning).
              terminalEnvTabName: t.terminalEnvTabName,
              lastAgentEchoSeq: t.lastAgentEchoSeq,
              group: t.group,
              cwd: t.cwd,
            }
          : {}),
      };
    }
    if (t.kind === "extension") {
      return {
        kind: "extension",
        extensionId: t.extensionId,
        title: t.title,
      };
    }
    return { kind: "terminal", title: t.title };
  }

  /// Fired on the SOURCE element after the drop completes (anywhere).
  /// `dropEffect === "move"` means a target accepted; for an
  /// intra-window move, the layout was already mutated by
  /// moveTab/reorderTab and the tab is no longer here. If the tab is
  /// still in this pane after a successful move, the drop must have
  /// landed in another window - close it locally so the visual
  /// matches the cross-window result.
  function onDragEnd(e: DragEvent, tabId: string, fallbackSide: PaneSide): void {
    const fromSide = activeDragSourceSides.get(tabId) ?? fallbackSide;
    activeDragSourceSides.delete(tabId);
    if (paneMode.stale) return;
    if (!shouldCloseTabAfterDragEnd(pane.id, tabId, e.dataTransfer?.dropEffect, fromSide)) {
      return;
    }
    const t = allPaneTabs(pane).find((tab) => tab.id === tabId);
    if (t?.kind === "terminal" && t.terminalSessionId) {
      // Session-preserving cross-window MOVE: the target window re-attached to
      // this SAME live PTY (shared `/terminal` registry), so remove the source
      // tab WITHOUT killing the shell. `markTerminalMovingOut` makes the
      // close-sink skip the WS `close` frame; `force` skips the "live terminal
      // still running, close anyway?" confirm (a move is not a destroy).
      markTerminalMovingOut(tabId);
      void closeTab(pane.id, tabId, { force: true });
      return;
    }
    void closeTab(pane.id, tabId);
  }

  /// Open a cross-window tab payload in this pane. Used by the
  /// drop handlers when the intra-window check fails (the source
  /// pane belongs to a different window). Drop position is not
  /// honoured for cross-window drops; the user can reorder within
  /// the strip afterwards.
  function acceptCrossWindowTab(payload: string): boolean {
    let parsed: {
      kind?: string;
      path?: string;
      title?: string;
      terminalSessionId?: string;
      extensionId?: string;
      terminalEnvTabName?: string;
      lastAgentEchoSeq?: number;
      group?: string;
      cwd?: string;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }
    if (parsed.kind === "terminal") {
      // A payload carrying a live `terminalSessionId` is a session-preserving
      // MOVE: re-attach to that SAME PTY in the shared `/terminal` registry,
      // keeping its name. No session id (never-spawned / exited source) opens
      // a fresh terminal as before.
      if (parsed.terminalSessionId) {
        reattachTerminalInPane(pane.id, {
          terminalSessionId: parsed.terminalSessionId,
          title: parsed.title,
          terminalEnvTabName: parsed.terminalEnvTabName,
          lastAgentEchoSeq: parsed.lastAgentEchoSeq,
          group: parsed.group,
          cwd: parsed.cwd,
        });
        return true;
      }
      openTerminalInPane(pane.id);
      return true;
    }
    if (parsed.kind === "extension" && parsed.extensionId) {
      openExtensionInPane(
        pane.id,
        parsed.extensionId,
        parsed.title?.trim() || parsed.extensionId,
      );
      return true;
    }
    if (!parsed.path) return false;
    void openInPane(pane.id, parsed.path);
    return true;
  }

  function isAcceptedDrag(e: DragEvent): boolean {
    return (
      dragHasType(e, TAB_DRAG_MIME) ||
      dragHasType(e, CROSS_TAB_MIME) ||
      dragHasType(e, FILE_DRAG_MIME)
    );
  }

  /// A tab MOVE (vs a file-tree drag, which is same-window and always allowed).
  function isTabMoveDrag(e: DragEvent): boolean {
    return dragHasType(e, TAB_DRAG_MIME) || dragHasType(e, CROSS_TAB_MIME);
  }

  /// Whether a tab move is scope-compatible with THIS window: it must carry our
  /// own scope type, which the source stamped at dragstart. Same window, or a
  /// window of the same kind+workspace, shares the scope (present → allowed);
  /// terminal↔workspace and different-workspace drags carry a different scope
  /// (absent → rejected). Blocks the cross-window drags that misbehave today.
  function isTabDragScopeCompatible(e: DragEvent): boolean {
    return dragHasType(e, scopeMime(currentDragScope()));
  }

  function rejectTabMoveDrag(e: DragEvent): void {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    dropActive = false;
    dropIndicator = -1;
  }

  function onDragOver(e: DragEvent): void {
    if (!isAcceptedDrag(e)) return;
    // Disallowed cross-window tab move (different kind / workspace): leave it
    // un-prevented so the browser shows the no-drop cursor. File drags pass.
    if (isTabMoveDrag(e) && !isTabDragScopeCompatible(e)) {
      rejectTabMoveDrag(e);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = isTabMoveDrag(e) ? "move" : "copy";
    }
    dropActive = true;
  }

  function onDragLeave(e: DragEvent): void {
    // Only clear the highlight when the cursor truly leaves the tab strip,
    // not when it crosses into a child element.
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as Node).contains(related)) {
      dropActive = false;
      dropIndicator = -1;
    }
  }

  function tabDragPayload(e: DragEvent): TabDragPayload | null {
    const raw = e.dataTransfer?.getData(TAB_DRAG_MIME);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        fromPaneId?: string;
        fromSide?: PaneSide;
        tabId?: string;
        fromWindow?: string;
      };
      if (!parsed.fromPaneId || !parsed.tabId) return null;
      return {
        fromPaneId: parsed.fromPaneId,
        fromSide: parsed.fromSide === "a" || parsed.fromSide === "b" ? parsed.fromSide : undefined,
        tabId: parsed.tabId,
        fromWindow: parsed.fromWindow,
      };
    } catch {
      return null;
    }
  }

  /// True when a tab-drag originated in THIS window. The discriminator is
  /// the originating window, NOT the pane id: pane ids are a per-window
  /// counter (tabs.svelte.ts makeId), so a cross-window drag's stranger
  /// pane id can collide with a same-id pane that happens to exist here.
  /// Relying on pane-id presence made cross-window drops take the intra
  /// moveTab path, which no-ops on the foreign tab while the source still
  /// closes on dragend, so the tab vanished instead of moving.
  function isIntraWindowDrag(fromWindow: string | undefined): boolean {
    return fromWindow === sessionWindowId();
  }

  function edgeForBodyDrop(e: DragEvent): PaneDropEdge {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const distances: Array<[PaneDropEdge, number]> = [
      ["left", x],
      ["right", rect.width - x],
      ["top", y],
      ["bottom", rect.height - y],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0]![0];
  }

  function onBodyDragOver(e: DragEvent): void {
    const payload = tabDragPayload(e);
    if (
      !payload ||
      !isIntraWindowDrag(payload.fromWindow) ||
      !paneInThisWindow(payload.fromPaneId)
    ) {
      if (isTabMoveDrag(e)) rejectTabMoveDrag(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    bodyDropEdge = edgeForBodyDrop(e);
  }

  function onBodyDragLeave(e: DragEvent): void {
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as Node).contains(related)) {
      bodyDropEdge = null;
    }
  }

  function onBodyDrop(e: DragEvent): void {
    const payload = tabDragPayload(e);
    const edge = bodyDropEdge ?? edgeForBodyDrop(e);
    bodyDropEdge = null;
    // Cross-window split-edge drops are not supported (acceptCrossWindowTab
    // adds a tab to the strip, not a split), so an intra-window check
    // both fixes the id-collision false-positive and keeps the boundary.
    if (
      !payload ||
      !isIntraWindowDrag(payload.fromWindow) ||
      !paneInThisWindow(payload.fromPaneId)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    markLocalTabDrop(payload.fromPaneId, payload.tabId, payload.fromSide);
    detachTabToPaneEdge(payload.fromPaneId, payload.tabId, pane.id, edge);
  }

  /// Compute the insertion index for a drop with cursor position `clientX`
  /// over a tab element. We split the tab in half: drop on the left half
  /// → insert before; right half → insert after.
  function indicatorIndexFor(tabIdx: number, e: DragEvent): number {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? tabIdx : tabIdx + 1;
  }

  /// Is the current drag from a tab in THIS pane? Affects both the
  /// visual indicator and the drop semantics: same-pane drops use a
  /// "drop on tab T = land at slot T" rule (a swap-like reorder, no
  /// half-tab logic), because users naturally expect dropping on a tab
  /// to displace it. Cross-pane drops keep the precise "insert before
  /// or after this tab" semantic since insertion between tabs is the
  /// useful action there.
  function isSamePaneDrag(e: DragEvent): boolean {
    const payload = tabDragPayload(e);
    return (
      !!payload &&
      isIntraWindowDrag(payload.fromWindow) &&
      payload.fromPaneId === pane.id &&
      (payload.fromSide ?? visibleSide) === visibleSide
    );
  }

  function onTabDragOver(e: DragEvent, tabIdx: number): void {
    if (!isAcceptedDrag(e)) return;
    // Disallowed cross-window tab move: bail before preventDefault so the
    // browser shows the no-drop cursor and no insertion indicator appears.
    // Returning before stopPropagation lets the strip-level handler also
    // reject it consistently. File drags pass.
    if (isTabMoveDrag(e) && !isTabDragScopeCompatible(e)) {
      rejectTabMoveDrag(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation(); // don't let the strip-level handler also fire
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = isTabMoveDrag(e) ? "move" : "copy";
    }
    dropActive = true;
    // For same-pane drags we show the indicator at the target tab's
    // slot (i.e., "this is where your tab will land"). For cross-pane
    // drags the half-tab heuristic gives precise insertion control.
    dropIndicator = isSamePaneDrag(e) ? tabIdx : indicatorIndexFor(tabIdx, e);
  }

  /// Whether a `fromPaneId` belongs to this window's layout. Cross-
  /// window drops carry a `fromPaneId` that doesn't exist in the
  /// receiving window; we use that to distinguish.
  function paneInThisWindow(paneId: string): boolean {
    const n = layout.nodes[paneId];
    return !!n && n.kind === "leaf";
  }

  function onTabDrop(e: DragEvent, tabIdx: number): void {
    const dt = e.dataTransfer;
    if (!dt) return;
    dropActive = false;
    dropIndicator = -1;
    const tabRaw = dt.getData(TAB_DRAG_MIME);
    if (tabRaw) {
      try {
        const { fromPaneId, fromSide, tabId, fromWindow } = JSON.parse(tabRaw) as TabDragPayload;
        if (isIntraWindowDrag(fromWindow) && paneInThisWindow(fromPaneId)) {
          e.preventDefault();
          e.stopPropagation();
          markLocalTabDrop(fromPaneId, tabId, fromSide);
          if (fromPaneId === pane.id && (fromSide ?? visibleSide) === visibleSide) {
            // Same-pane reorder: drop on tab T means source lands at
            // position T in the final array. No half-tab logic; drops
            // on either half of the target produce the same swap.
            reorderTab(pane.id, tabId, tabIdx, visibleSide);
          } else {
            moveTab(fromPaneId, tabId, pane.id, indicatorIndexFor(tabIdx, e), {
              fromSide,
              toSide: visibleSide,
            });
          }
          return;
        }
        // Fall through to cross-window path: the drag is from another
        // window (its pane id may coincidentally match a local one).
      } catch {
        // malformed payload; fall through.
      }
    }
    const crossRaw = dt.getData(CROSS_TAB_MIME);
    if (crossRaw) {
      // Reject a cross-window drop from a different kind/workspace (no
      // preventDefault ⇒ dropEffect "none" ⇒ the source keeps its tab).
      if (!isTabDragScopeCompatible(e)) return;
      e.preventDefault();
      e.stopPropagation();
      acceptCrossWindowTab(crossRaw);
      return;
    }
    const fileRaw = dt.getData(FILE_DRAG_MIME);
    if (fileRaw) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const { path } = JSON.parse(fileRaw) as { path: string };
        if (path) void openInPane(pane.id, path);
      } catch {
        // ignore
      }
    }
  }

  function onDrop(e: DragEvent): void {
    dropActive = false;
    dropIndicator = -1;
    const dt = e.dataTransfer;
    if (!dt) return;
    // Tab move takes precedence over file open if both are present.
    const tabRaw = dt.getData(TAB_DRAG_MIME);
    if (tabRaw) {
      try {
        const { fromPaneId, fromSide, tabId, fromWindow } = JSON.parse(tabRaw) as TabDragPayload;
        if (isIntraWindowDrag(fromWindow) && paneInThisWindow(fromPaneId)) {
          e.preventDefault();
          markLocalTabDrop(fromPaneId, tabId, fromSide);
          if (fromPaneId === pane.id && (fromSide ?? visibleSide) === visibleSide) {
            // Strip-level drop in the same pane (i.e., dropped on the
            // background or actions area, not directly on a tab). Treat
            // it as "move source to the end" so dragging a leftmost tab
            // rightward past the last tab does the obvious thing instead
            // of silently no-op'ing.
            reorderTab(pane.id, tabId, Math.max(0, visibleTabs.length - 1), visibleSide);
          } else {
            moveTab(fromPaneId, tabId, pane.id, undefined, {
              fromSide,
              toSide: visibleSide,
            });
          }
          return;
        }
        // Fall through to cross-window path (drag from another window).
      } catch {
        // malformed payload; fall through.
      }
    }
    const crossRaw = dt.getData(CROSS_TAB_MIME);
    if (crossRaw) {
      // Reject a cross-window drop from a different kind/workspace (no
      // preventDefault ⇒ dropEffect "none" ⇒ the source keeps its tab).
      if (!isTabDragScopeCompatible(e)) return;
      e.preventDefault();
      acceptCrossWindowTab(crossRaw);
      return;
    }
    const fileRaw = dt.getData(FILE_DRAG_MIME);
    if (fileRaw) {
      e.preventDefault();
      try {
        const { path } = JSON.parse(fileRaw) as { path: string };
        if (path) void openInPane(pane.id, path);
      } catch {
        // ignore
      }
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="pane"
  class:focused={isFocused}
  class:wobble={wobbleActive}
  class:sideFlipActive={sideFlipActive}
  class:sideFlipHorizontal={sideFlipAxis === "horizontal"}
  class:sideFlipVertical={sideFlipAxis === "vertical"}
  class:pane-mode-stale={paneMode.stale}
  class:transaction-active={paneMode.transactionMode}
  class:transaction-grab={isTransactionGrab}
  class:transaction-drop-target={isTransactionDropTarget}
  class:transaction-split-left={transactionSplitEdge === "left"}
  class:transaction-split-right={transactionSplitEdge === "right"}
  class:transaction-split-top={transactionSplitEdge === "top"}
  class:transaction-split-bottom={transactionSplitEdge === "bottom"}
  bind:this={paneEl}
  style:--pane-side-flip-start={sideFlipStartTransform}
  style:--pane-side-flip-back={sideFlipBackTransform}
  data-focus-color={focusColorForWindow()}
  data-pane-id={pane.id}
  onmousedown={(e) => {
    if (paneMode.stale) return;
    setActivePane(pane.id);
    onPaneBodyMouseDown(e);
  }}
  onmouseenter={onPaneBodyMouseEnter}
  onmouseleave={onPaneBodyMouseLeave}
  onmousemove={onPaneBodyMouseMove}
  onmouseup={onPaneBodyMouseUp}
  onanimationend={(e) => {
    // Svelte scopes keyframe names (svelte-<hash>-pane-wobble-once), so a
    // strict equality against the source name never matches in a real
    // browser; substring-match instead. No other keyframe name contains
    // these as a substring.
    if (e.animationName.includes("pane-wobble-once")) wobbleActive = false;
    if (e.animationName.includes("pane-side-flip")) sideFlipActive = false;
  }}
  role="region"
  aria-label="editor pane"
>
  <div class="pane-card">
    <div class="pane-card-inner" data-side-label={visibleSide.toUpperCase()}>
      <div class="pane-card-face">
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="tabs"
    class:drop-active={dropActive}
    class:control-hidden={ui.terminalControl}
    role="tablist"
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
    oncontextmenu={(e) => {
      if ((e.target as Element | null)?.closest(".tab, .actions")) return;
      // Empty panes have no right-click menu; only non-empty panes
      // get the Reload / Open Inspector context menu.
      if (visibleTabs.length === 0) return;
      openPaneContextAt(e);
    }}
  >
    {#each visibleTabs as t, i (t.id)}
      {@const label = tabLabelInPane(t, visibleTabs, browserCtxFor(t))}
      {#if dropIndicator === i}
        <div class="drop-bar" aria-hidden="true"></div>
      {/if}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="tab"
        class:active={t.id === visibleActiveTabId}
        class:staged={paneModeStagedSet.has(t.id)}
        class:stale={paneMode.stale && paneModeStagedSet.has(t.id)}
        onmousedown={() => {
          if (paneMode.stale) return;
          selectTabInPane(pane.id, t.id);
          if (t.kind === "terminal") setTerminalActivity(t, false);
          if (t.kind === "terminal" || t.kind === "file") bumpTabFocusPulse();
        }}
        onmouseup={(e) => {
          // Re-pulse on mouseup: the mousedown pulse above loses to the
          // browser's mousedown DEFAULT ACTION, which focuses this
          // tabindex="0" div AFTER the pulse's microtask ran (microtask
          // checkpoints sit between listeners and the default action).
          // Mouseup runs after focus has landed on the tab, so this
          // second pulse's microtask focus is the last word. Not
          // preventDefault on mousedown (kills HTML5 dragstart for tab
          // DnD in WebKit/Firefox) and not onclick (the .path span's
          // onclick stopPropagation()s label clicks away). A completed
          // drag fires dragend, not mouseup, so reorders don't re-bump.
          if (e.button !== 0) return;
          if (t.kind === "terminal" || t.kind === "file") bumpTabFocusPulse();
        }}
        oncontextmenu={(e) => {
          if (paneMode.stale) return;
          e.preventDefault();
          e.stopPropagation();
          selectTabInPane(pane.id, t.id);
          if (t.kind === "terminal") setTerminalActivity(t, false);
          layout.activePaneId = pane.id;
          openTabMenu(t.id, {
            left: e.clientX,
            top: e.clientY,
            right: e.clientX,
            bottom: e.clientY,
          });
        }}
        role="tab"
        tabindex={paneMode.stale ? -1 : 0}
        aria-selected={t.id === visibleActiveTabId}
        aria-disabled={paneMode.stale}
        title={tabTooltip(t)}
        draggable={!paneMode.stale}
        ondragstart={(e) => onDragStart(e, t.id, visibleSide)}
        ondragend={(e) => onDragEnd(e, t.id, visibleSide)}
        ondragover={(e) => onTabDragOver(e, i)}
        ondrop={(e) => onTabDrop(e, i)}
      >
        <!-- Spinner appears while the file is still loading from
             disk; once loaded the tab leads with a kind icon (User
             for contacts, FileText otherwise) so the row reads
             scannably. -->
        {#if t.kind === "file" && t.loading}
          <span class="marker spinner" aria-hidden="true"></span>
        {:else if t.kind === "file"}
          <span class="tab-icon" aria-hidden="true">
            {#if contactPaths.has(t.path)}
              <User size={14} strokeWidth={1.75} />
            {:else if isExcalidraw(t.path)}
              <Shapes size={14} strokeWidth={1.75} />
            {:else}
              <FileText size={14} strokeWidth={1.75} />
            {/if}
          </span>
        {:else if t.kind === "terminal"}
          <span class="tab-icon" aria-hidden="true">
            <Terminal size={14} strokeWidth={1.75} />
          </span>
          {#if t.broadcastEnabled}
            {@const reach = terminalBroadcastReachCount(t)}
            <span
              class="broadcast-marker"
              title={`Broadcasting to ${reach} tab(s)`}
              aria-label={`Broadcasting to ${reach} tab(s)`}
            >
              <Radio size={13} strokeWidth={1.9} aria-hidden="true" />
            </span>
          {/if}
        {:else if t.kind === "graph"}
          <span class="tab-icon" aria-hidden="true">
            <Network size={14} strokeWidth={1.75} />
          </span>
        {:else if t.kind === "browser"}
          <span class="tab-icon" aria-hidden="true">
            <Folder size={14} strokeWidth={1.75} />
          </span>
        {:else if t.kind === "extension"}
          <span class="tab-icon" aria-hidden="true">
            <Blocks size={14} strokeWidth={1.75} />
          </span>
        {/if}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="path"
          use:tabPathOverflow={label}
          aria-haspopup="menu"
          aria-expanded={tabMenu.openForTabId === t.id}
          onclick={(e) => {
            e.stopPropagation();
          }}
          oncontextmenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            selectTabInPane(pane.id, t.id);
            if (t.kind === "terminal") setTerminalActivity(t, false);
            layout.activePaneId = pane.id;
            openTabMenu(t.id, {
              left: e.clientX,
              top: e.clientY,
              right: e.clientX,
              bottom: e.clientY,
            });
          }}
        >{label}</span>
        {#if isDirty(t)}
          <span class="dirty unsaved" title="unsaved changes">●</span>
        {/if}
        {#if t.kind === "file" && (t.doc?.peers ?? 0) > 0}
          {@const peers = t.doc?.peers ?? 0}
          <span
            class="peers-pill"
            title={`${peers} collaborator(s) in this file`}
            aria-label={`${peers} collaborator(s) in this file`}
          >{peers}</span>
        {/if}
        {#if t.kind === "terminal" && t.terminalActivity}
          <span
            class="dirty activity"
            class:pulsing={t.terminalActivityPulsing}
            title="terminal output since last focus"
            aria-label="terminal output since last focus"
          >●</span>
        {/if}
        {#if t.kind === "terminal" && (t.queueDepth ?? 0) > 0}
          <span
            class="queue-pill"
            title="queued terminal messages"
            aria-label="queued terminal messages"
          >{t.queueDepth}</span>
        {/if}
        <button
          class="close"
          disabled={paneMode.stale}
          onclick={(e) => {
            e.stopPropagation();
            if (paneMode.stale) return;
            closeTab(pane.id, t.id);
          }}
          title="close"
          aria-label={`close ${label}`}
        >×</button>
      </div>
    {/each}
    {#if dropIndicator === visibleTabs.length}
      <div class="drop-bar" aria-hidden="true"></div>
    {/if}
    {#each paneModeStagedEditors as intent (intent.id)}
      {@const label = intent.kind === "diagram" ? "New diagram" : "New draft"}
      <div
        class="tab staged staged-editor"
        class:stale={paneMode.stale}
        aria-label={label}
      >
        <span class="tab-icon" aria-hidden="true">
          {#if intent.kind === "diagram"}
            <Shapes size={14} strokeWidth={1.75} />
          {:else}
            <FileText size={14} strokeWidth={1.75} />
          {/if}
        </span>
        <span class="path">{label}</span>
        <button
          class="close"
          disabled={paneMode.stale}
          onclick={(e) => {
            e.stopPropagation();
            paneModeRemoveStagedDraftEditor(intent.id);
          }}
          title={`remove ${label.toLowerCase()}`}
          aria-label={`remove ${label.toLowerCase()}`}
        >×</button>
      </div>
    {/each}
    <!-- Top-bar dead zone. The empty stretch between the last tab
         and the hamburger actions captures
         mousedown + double-click to enter Hybrid Nav in transaction
         mode. Manual mousedown + threshold tracking (not HTML5
         dragstart) avoids stomping the per-tab inter-pane DnD that
         lives on each .tab; that DnD remains unchanged. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="dead-zone"
      aria-hidden="true"
      onmousedown={onDeadZoneMouseDown}
      ondblclick={onDeadZoneDblClick}
    ></div>
    <div class="actions">
      <button
        class="side-toggle"
        class:side-toggle-flash={sideToggleFlashActive}
        disabled={paneMode.stale}
        onclick={() => flipHybrid(pane.id)}
        onanimationend={(e) => {
          if (e.animationName.includes("pane-side-toggle-flash")) sideToggleFlashActive = false;
        }}
        title={sideToggleTitle}
        aria-label={sideToggleTitle}
      >
        {visibleSide.toUpperCase()}
      </button>
      <!-- Pane chrome menu: command launcher and Hybrid Nav, the Apps
           spawn rows, pane-local focus border colour, then Close pane
           last (launcher parity). -->
      <HamburgerMenu
        bind:this={paneMenu}
        bind:open={paneMenuOpen}
        width={250}
        height={505}
        onBeforeOpen={closePaneContextMenus}
      >
        <li>
          <button role="menuitem" onclick={() => { dispatchCommand("app.launcher.toggle"); closePaneHamburgerMenu(); }}>
            <CommandIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            <span class="menu-row-label">Commands</span>
            <span class="menu-row-chord">{chordLabel("app.launcher.toggle")}</span>
          </button>
        </li>
        <li>
          <button role="menuitem" onclick={() => { closePaneHamburgerMenu(); enterPaneMode(); }}>
            <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
            <span class="menu-row-label">Hybrid Nav</span>
            <span class="menu-row-chord">{chordLabel("app.pane.mode")}</span>
          </button>
        </li>
        {#if !ui.terminalOnly}
          <!-- The app-spawn rows are workspace-window commands; runCommand's
               window-mode gate silently drops most of them in a terminal-only
               window, so the rows do not render there at all. -->
          <li class="sep" role="separator"></li>
          {#each appRows as row (row.id)}
            {@const Icon = row.icon}
            <li>
              <button role="menuitem" onclick={() => runAppRow(row.id)}>
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                <span class="menu-row-label">{row.title}</span>
                <span class="menu-row-chord">{chordLabel(row.id)}</span>
              </button>
            </li>
          {/each}
        {:else}
          <!-- The one spawn command a terminal-only window CAN run (the
               window-mode gate allows app.terminal.toggle). A hardcoded row,
               NOT an appRows entry: the appRows table is regex-pinned to the
               workspace-window set. -->
          <li class="sep" role="separator"></li>
          <li>
            <button role="menuitem" onclick={() => runAppRow("app.terminal.toggle")}>
              <Terminal size={16} strokeWidth={1.75} aria-hidden="true" />
              <span class="menu-row-label">New terminal</span>
              <span class="menu-row-chord">{chordLabel("app.terminal.toggle")}</span>
            </button>
          </li>
        {/if}
        <li class="sep" role="separator"></li>
        <li class="menu-label">
          <Palette size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>Focus border colour</span>
        </li>
        {#each paneFocusColors as color}
          <li>
            <button role="menuitem" onclick={() => doSetFocusColor(color)}>
              <span class={`color-dot ${color}`} aria-hidden="true"></span>
              <span>{color}</span>
              {#if focusColorForWindow() === color}
                <Check size={14} strokeWidth={2} aria-hidden="true" />
              {/if}
            </button>
          </li>
        {/each}
        <li class="sep" role="separator"></li>
        <li>
          <button role="menuitem" onclick={() => { dispatchCommand("app.pane.kill"); closePaneHamburgerMenu(); }}>
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
            <span class="menu-row-label">Close pane</span>
            <span class="menu-row-chord">{chordLabel("app.pane.kill")}</span>
          </button>
        </li>
      </HamburgerMenu>
      <HamburgerMenu
        bind:this={paneContextMenu}
        bind:open={paneContextMenuOpen}
        showTrigger={false}
        width={220}
        height={110}
        onBeforeOpen={closePaneHamburgerMenu}
      >
        <li>
          <!-- Window-level reload, like a browser Cmd+R. The
               SPA-level chord in App.svelte and this menu entry both
               route through `reloadWindow()` so the affordance reads
               as "one action, two entry points". chan-desktop's
               Tauri-side binding stays as a defense-in-depth
               fallback. -->
          <button role="menuitem" onclick={doReloadPane}>
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            <span class="menu-row-label">Reload</span>
            <span class="menu-row-chord">{chordLabel("app.window.reload")}</span>
          </button>
        </li>
        <li>
          <button role="menuitem" onclick={doOpenInspector}>
            <Bug size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>Open Inspector</span>
          </button>
        </li>
      </HamburgerMenu>
    </div>
  </div>

  <div
    class="editor-wrap"
    class:body-drop-left={bodyDropEdge === "left"}
    class:body-drop-right={bodyDropEdge === "right"}
    class:body-drop-top={bodyDropEdge === "top"}
    class:body-drop-bottom={bodyDropEdge === "bottom"}
    bind:this={editorWrapEl}
    ondragover={onBodyDragOver}
    ondragleave={onBodyDragLeave}
    ondrop={onBodyDrop}
    role="group"
    aria-label="pane content"
  >
    {#if paneMode.active}
          <div class="pane-mode-preview" aria-label="Hybrid Nav preview">
            {#if paneMode.stale && viewLayout.activePaneId === pane.id}
              <div class="pane-mode-stale-warning" role="status">Layout changed. Esc to discard.</div>
            {:else}
              <div class="pane-mode-title">{active ? tabLabel(active, browserCtxFor(active)) : "Empty pane"}</div>
              <div class="pane-mode-subtitle">
                {active?.kind === "file"
                  ? active.path
                  : active?.kind === "terminal"
                    ? "terminal"
                    : active?.kind === "graph"
                      ? active.scopeId
                      : active?.kind === "browser"
                        ? "file browser"
                        : active?.kind === "dashboard"
                          ? "dashboard"
                          : active?.kind === "extension"
                            ? `extension: ${active.extensionId}`
                          : "no active tab"}
              </div>
            {/if}
          </div>
    {:else if active?.kind === "browser"}
      <FileBrowserSurface
        variant="tab"
        tab={active}
        onClose={() => {
          void closeTab(pane.id, active.id);
        }}
        onFlip={() => flipHybrid(pane.id)}
      />
    {:else if !active}
      <div
        class="placeholder"
        aria-label="no tab open"
        role="presentation"
      >
            <!-- Single-pane lone-pane case renders the static welcome
                 surface: the chan mark over its decorative field. The
                 rotating carousel widget (About / Workspace metadata /
                 Indexing graph) lives inside the Dashboard tab.
                 Multi-pane empty panes and panes with tabs on their hidden
                 Hybrid side keep the minimal chrome (just the chan mark).
                 Empty panes have no right-click menu;
                 spawn actions live in the pane hamburger's Apps rows
                 and the command launcher, so right-clicking an empty
                 pane is a no-op.

                 Terminal-only windows skip the welcome entirely: they always
                 hold at least one terminal (boot opens one, close-on-last-tab
                 closes the window), so the lone Terminal spawn tile only ever
                 flashed during the transient empty boot layout. Fall through
                 to the minimal chan mark instead. -->
        {#if !multiPane && !ui.terminalOnly && everyTab.length === 0}
          <EmptyPaneWelcome />
        {:else}
          <div class="placeholder-stack">
            <div class="placeholder-mark"></div>
          </div>
        {/if}
      </div>
    {/if}
        <!--
          Keep terminal tabs mounted across Hybrid Nav (pane mode) and
          side flips so xterm.js's 20k-line scrollback buffer survives.
          Unmounting a terminal would dispose the EditorView and drop the
          buffer, losing every line that had scrolled off screen. The
          active terminal is hidden by `class:active` flipping to false
          during pane mode or while the tab is on the hidden side (the existing
          `visibility: hidden; pointer-events: none` rule does the
          hiding).
        -->
    {#each everyTab.filter((t) => t.kind === "terminal") as t (t.id)}
      <TerminalTab
        tab={t}
        paneId={pane.id}
        side={sideForTab(t)}
        active={isLiveActive(t)}
        focused={isLiveActive(t) && viewLayout.activePaneId === pane.id}
      />
    {/each}
        <!--
          File tabs are kept mounted for the same reason as terminals
          above: unmounting destroys the CM6 EditorView, and on remount
          the decoration walker computes from a pre-layout viewport --
          on WKWebView the document then shows raw un-decorated
          markdown until a click, and scroll/caret/undo/FindBar state
          is rebuilt from scratch. Keeping the editor alive (hidden via
          the same visibility contract, never display:none, so layout
          geometry stays real) removes that whole race category. The
          inactive `active`/`focused` gates mirror the terminal ones;
          `focused` additionally feeds the editors' autoFocus so a
          session restore of N background tabs never steals the caret.
        -->
    {#each everyTab.filter((t) => t.kind === "file") as t (t.id)}
      <FileEditorTab
        tab={t}
        active={isLiveActive(t)}
        focused={isLiveActive(t) && viewLayout.activePaneId === pane.id}
      />
    {/each}
        <!--
          Graph tabs join the keep-alive family: rendering GraphPanel
          inside the active-tab if-chain remounted it on every switch,
          and GraphCanvas.start() refetches + re-lays-out from scratch
          (transform reset, sim rebuilt)
          on activation, cheap on small workspaces but painful on a
          large source tree. Kept mounted + hidden via the same
          visibility contract, pan/zoom/selection survive a switch, and
          GraphPanel gates its first load lazily on activation (not
          mount, so N restored graph tabs don't all fetch at once). No
          `focused` prop: a graph owns no keyboard caret (the canvas
          focuses on click, the menu is portal-anchored).
        -->
    {#each everyTab.filter((t) => t.kind === "graph") as t (t.id)}
      <GraphPanel
        tab={t}
        active={isLiveActive(t)}
        onClose={() => {
          void closeTab(pane.id, t.id);
        }}
      />
    {/each}
        <!--
          Dashboard tabs join the keep-alive family for the same reason as
          graphs: the Indexing carousel slide hosts a GraphCanvas whose force
          layout + 3s indexer poll were torn down and rebuilt on every tab
          switch when DashboardTab rendered inside the active-tab if-chain, so
          the graph visibly reloaded/re-laid-out each time it was re-shown.
          Kept mounted + hidden via the same visibility contract, the graph
          keeps its layout across switches and only refreshes in place; a
          reload is now an explicit user action (Cmd+R or the right-click
          Reload row). The `active` gate also pauses the carousel + poll while
          the tab is hidden. No `focused` prop: a dashboard owns no
          keyboard caret.
        -->
    {#each everyTab.filter((t) => t.kind === "dashboard") as t (t.id)}
      <DashboardTab
        tab={t}
        active={isLiveActive(t)}
      />
    {/each}
        <!-- Extension iframes stay mounted so switching tabs does not reload
             the subprocess-owned page or discard its in-page state. The
             component resolves its credentialed URL from the memory-only
             catalog; the tab itself carries only a stable id. -->
    {#each everyTab.filter((t) => t.kind === "extension") as t (t.id)}
      <ExtensionTab
        tab={t}
        paneId={pane.id}
        active={isLiveActive(t)}
      />
    {/each}
  </div>
      </div>
    </div>
  </div>
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    flex: 1;
    position: relative;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    /* Pane chrome - floating shade. Margin keeps panes off the
       workspace edge and off each other (the split divider is
       4px; with 4px margin on each side the inter-pane gap reads
       as one clean 12px channel). The card face clips the tabs
       strip + editor body; the drop shadow paints inside the
       margin space so it isn't clipped by the .half wrapper. */
    margin: 4px;
    border-radius: 6px;
    overflow: visible;
    -webkit-perspective: 1200px;
    perspective: 1200px;
    box-shadow: var(--pane-shadow);
    transition:
      border-color 100ms ease,
      box-shadow 120ms ease;
  }
  .pane[data-focus-color="blue"] { --pane-active-focus: var(--pane-focus); }
  .pane[data-focus-color="orange"] { --pane-active-focus: #f97316; }
  .pane[data-focus-color="green"] { --pane-active-focus: #22c55e; }
  .pane[data-focus-color="pink"] { --pane-active-focus: #ff5fb7; }
  .pane.pane-mode-stale {
    pointer-events: none;
  }
  /* Focus ring is the pane's own border swapping to the focus
     colour. The transparent 1px border on `.pane` reserves the
     space at the outer edge so swapping the colour never shifts
     layout. Single source: no inset shadow, no chrome pseudo
     layer - child elements (tab strip, terminal, editor) can't
     cover the border the way they cover inset shadows, so the
     ring reads uniformly 1px around all four sides instead of
     thicker at the body than at the top bar. */
  .pane.focused {
    /* `--pane-highlight-color` is the per-window library colour the desktop
       carries on the URL (`?pane=<hex>`, applied to the document root at
       boot). When present it overrides the `data-focus-color` preset;
       absent, the preset / default blue accent applies. */
    border-color: var(--pane-highlight-color, var(--pane-active-focus));
  }
  /* Single-shot wobble fires on the newly focused pane when the
     active pane CHANGES (keyboard/click pane-switch via
     setActivePane, plus split / close / pane-move which all land
     on a focused pane). Outer halo pulse via box-shadow only - no
     transform on `.pane` so xterm's WebGL glyph atlas is
     unaffected during focus changes. Same easeOutBack curve as the
     tab-pill / right-click-menu pop. The halo expands to ~6px
     into the inter-pane margin then dissipates back to no halo;
     the steady-state focus ring (the border) stays put underneath
     throughout, so the visual reads as "the focus ring just
     popped". */
  .pane.focused.wobble {
    animation: pane-wobble-once 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes pane-wobble-once {
    0%, 100% {
      box-shadow: 0 0 0 0 transparent, var(--pane-shadow);
    }
    40% {
      box-shadow:
        0 0 0 6px color-mix(in srgb, var(--pane-highlight-color, var(--pane-active-focus)) 55%, transparent),
        var(--pane-shadow);
    }
  }
  .pane-card {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    border-radius: inherit;
    -webkit-transform-style: preserve-3d;
    transform-style: preserve-3d;
  }
  .pane-card-inner {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    border-radius: inherit;
    -webkit-transform-style: preserve-3d;
    transform-style: preserve-3d;
  }
  .pane-card-inner::before {
    content: attr(data-side-label);
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-items: center;
    border-radius: inherit;
    background:
      radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--pane-highlight-color, var(--pane-active-focus)) 18%, transparent), transparent 34%),
      var(--bg-card);
    color: color-mix(in srgb, var(--text) 70%, transparent);
    font-size: 44px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
    pointer-events: none;
    transform: var(--pane-side-flip-back);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }
  .pane-card-face {
    position: relative;
    z-index: 1;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-radius: inherit;
    overflow: hidden;
    background: var(--bg);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }
  .pane.sideFlipActive .pane-card-inner {
    transform-origin: center center;
    will-change: transform;
    animation: pane-side-flip 520ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  @keyframes pane-side-flip {
    0% {
      transform: var(--pane-side-flip-start);
    }
    100% {
      transform: rotateX(0deg) rotateY(0deg);
    }
  }
  /* iTerm-style strip: a dark bar with no per-tab dividers. The
     active tab is a rounded pill sitting on the bar rather than a
     beveled cap that "merges" with the editor below. */
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 4px 6px;
    overflow-x: auto;
    flex-shrink: 0;
    transition: box-shadow 0.1s;
  }
  .tabs.drop-active {
    box-shadow: inset 0 0 0 2px var(--pane-focus);
  }
  /* The control terminal is a chromeless singleton: hide the whole tab strip
     (tab name + dead-zone + pane hamburger) so the connect-script PTY fills the
     window like a plain terminal. Closing is the native red dot; there is no
     in-page tab or split affordance. */
  .tabs.control-hidden {
    display: none;
  }
  .tab[draggable="true"] { -webkit-user-drag: element; }
  /* Vertical bar between tabs that shows where a drop will land. */
  .drop-bar {
    width: 2px;
    align-self: stretch;
    background: var(--pane-focus);
    flex-shrink: 0;
  }
  .tab {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 3px 10px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    background: transparent;
    user-select: none;
    /* `transform-origin: center bottom` anchors the hover wobble to
       the tab strip's baseline so the tab lifts upward rather than
       drifting sideways. Same easeOutBack curve as the tab-menu
       bubble, bottom pill, and style toolbar so the motion language
       reads as one set. */
    transform-origin: center bottom;
    transition:
      background 80ms ease,
      color 80ms ease,
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .tab:hover {
    color: var(--text);
    transform: scale(1.04);
  }
  .tab.active {
    background: var(--bg-elev);
    color: var(--text);
    font-weight: 500;
    box-shadow: 0 0 0 1px var(--border);
  }
  /* Ghost tab styling for the T/O/P/G/E spawn staging inside Hybrid
     Nav. Tabs added to the draft
     layout but not yet committed render with a dashed border +
     reduced opacity so the user can scan the staged additions
     before pressing Enter to materialize. Class lifts on commit
     (set is empty) or on cancel (whole tab removed with the
     draft). */
  .tab.staged {
    opacity: 0.65;
    border: 1px dashed var(--border);
    background: transparent;
  }
  .tab.staged.active {
    opacity: 0.85;
  }
  .tab.staged.stale {
    opacity: 0.35;
    filter: saturate(0.4);
  }
  .tab.staged-editor {
    cursor: default;
  }
  .tab.staged-editor:hover {
    transform: none;
  }
  /* CSS-only spinner shown while a tab's content is loading. Inherits
     color from the tab's text-secondary so it sits at the same
     visual weight as the surrounding label. */
  .tab .marker.spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: tab-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes tab-spin {
    to { transform: rotate(360deg); }
  }
  /* Close button stays invisible until the row is hovered or the
     tab is active; matches iTerm / Chrome's behavior so the strip
     reads cleanly with many tabs open. */
  .tab .close {
    background: none;
    border: 0;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    color: var(--text-secondary);
    padding: 0 2px;
    opacity: 0;
    transition: opacity 80ms ease, color 80ms ease;
    flex-shrink: 0;
  }
  .tab:hover .close,
  .tab.active .close { opacity: 1; }
  .tab.staged-editor .close { opacity: 1; }
  .tab .close:hover { color: var(--text); }
  .tab .close:disabled {
    color: var(--text-secondary);
    cursor: not-allowed;
  }
  .dirty {
    font-size: 10px;
    line-height: 1;
    color: var(--info-text);
  }
  .dirty.activity {
    color: var(--warn-text, #d29922);
  }
  /* Queued-message count for terminal tabs (Rich Prompt submits +
     teammate pokes share the queue); same affordance family as the
     activity dot, but a count needs a pill to read at 9px. */
  .queue-pill {
    flex: 0 0 auto;
    min-width: 14px;
    padding: 1px 4px;
    border-radius: 7px;
    font-size: 9px;
    line-height: 1.2;
    text-align: center;
    color: var(--bg-card);
    background: var(--info-text);
  }
  /* Live collaborator count on a co-edited file tab. Queue-pill's
     shape, but link-blue so presence never reads as the green
     unsaved dot it sits beside. */
  .peers-pill {
    flex: 0 0 auto;
    min-width: 14px;
    padding: 1px 4px;
    border-radius: 7px;
    font-size: 9px;
    line-height: 1.2;
    text-align: center;
    color: var(--bg-card);
    background: var(--link);
  }
  /* The unseen-output dot PULSES while output is actively arriving,
     then holds SOLID once it stops (still unseen). A smooth opacity
     breathe, distinct from the steppy watcher blink. */
  .dirty.activity.pulsing {
    animation: terminal-activity-pulse 1100ms ease-in-out infinite;
  }
  @keyframes terminal-activity-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  /* Chrome-style tab-name clipping. The overflow action adds
     `.overflowing` only when scrollWidth exceeds the rendered label box;
     short titles stay unmasked so their final glyphs render at full opacity.
     The tooltip on the parent `<button>` (`title={tabTooltip(t)}`) still
     surfaces the full path on hover so truncation never costs the user
     disambiguation.
     `max-width` caps the visible width without forcing a hard
     box around shorter titles; `white-space: nowrap` keeps the
     edge straight; `overflow: hidden` is what clips when the text
     is wider than the cap. */
  .path {
    display: inline-block;
    max-width: 22ch;
    overflow: hidden;
    white-space: nowrap;
  }
  .path.overflowing {
    /* The fade covers the last 1.25rem of the BOX, and the box
       only receives the extra width when it actually overflows. */
    padding-right: 5px;
    mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
  }
  /* Per-tab kind icon: User for contact-kind files, FileText
     otherwise. Sized to the tab font and stroked with text-secondary
     so it sits one step below the label. */
  .tab-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .tab.active .tab-icon { color: var(--text); }
  .broadcast-marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #ff5fb7;
    width: 15px;
    height: 15px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .actions { margin-left: auto; display: flex; align-items: center; gap: 6px; padding-left: 4px; }
  .side-toggle {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-card);
    color: var(--text);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .side-toggle:hover {
    background: var(--hover-bg);
  }
  .side-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .side-toggle.side-toggle-flash {
    animation: pane-side-toggle-flash 620ms ease-in-out;
  }
  @keyframes pane-side-toggle-flash {
    0%,
    100% {
      border-color: var(--border);
      color: var(--text);
      background: var(--bg-card);
      box-shadow: none;
    }
    50% {
      border-color: #e3b341;
      color: #e3b341;
      background: color-mix(in srgb, #e3b341 18%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, #e3b341 24%, transparent);
    }
  }
  /* Dead zone on the top bar: the stretch between the last tab and
     the hamburger. mousedown + drag past 5 px
     enters transaction-mode NAV (Entry A, drag-with-payload);
     dblclick enters transaction-mode NAV with no originating grab
     (Entry B). flex: 1 fills any remaining horizontal space; the
     min-width guard keeps the affordance hittable even when the
     tab strip is fully packed. The `grab` cursor advertises the
     drag-to-rearrange interaction; switches to `grabbing` while
     a transaction is in flight. */
  .dead-zone {
    flex: 1;
    min-width: 12px;
    align-self: stretch;
    cursor: grab;
  }
  .dead-zone:active,
  .pane.transaction-active .dead-zone {
    cursor: grabbing;
  }
  /* Transaction-mode visual cues. `.transaction-active` is set on
     every pane while transaction
     mode is in flight; the body cursor flips to `grabbing` so the
     mouse-grab affordance reads from anywhere in the pane.
     `.transaction-grab` outlines the pane currently held; the
     dotted-orange ring distinguishes the held pane from focus
     (which uses the solid coloured ring per `.pane.focused`).
     `.transaction-drop-target` is set on the pane currently under
     the cursor while a grab is held; a brighter inset overlay
     signals the drop will land here. */
  .pane.transaction-active { cursor: grabbing; }
  .pane.transaction-grab {
    outline: 2px dashed #f97316;
    outline-offset: -3px;
  }
  .pane.transaction-drop-target::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: 2px solid var(--pane-focus);
    background: color-mix(in srgb, var(--pane-focus) 8%, transparent);
    z-index: 5;
  }
  /* Edge-split preview: an armed edge replaces the full-pane swap cue
     and tints the half the moved content would occupy after the 50/50
     split, so the user sees the resulting geometry before mouseup. */
  .pane.transaction-split-left::before,
  .pane.transaction-split-right::before,
  .pane.transaction-split-top::before,
  .pane.transaction-split-bottom::before {
    content: "";
    position: absolute;
    pointer-events: none;
    border: 2px solid var(--pane-focus);
    background: color-mix(in srgb, var(--pane-focus) 12%, transparent);
    z-index: 5;
  }
  .pane.transaction-split-left::before { inset: 0 50% 0 0; }
  .pane.transaction-split-right::before { inset: 0 0 0 50%; }
  .pane.transaction-split-top::before { inset: 0 0 50% 0; }
  .pane.transaction-split-bottom::before { inset: 50% 0 0 0; }
  :global(.hamburger-menu .menu-label) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  :global(.hamburger-menu .color-dot) {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px var(--border);
  }
  :global(.hamburger-menu .color-dot.blue) { background: var(--pane-focus); }
  :global(.hamburger-menu .color-dot.orange) { background: #f97316; }
  :global(.hamburger-menu .color-dot.green) { background: #22c55e; }
  :global(.hamburger-menu .color-dot.pink) { background: #ff5fb7; }
  .editor-wrap {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .editor-wrap::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 80ms ease;
    z-index: 20;
  }
  .editor-wrap.body-drop-left::after,
  .editor-wrap.body-drop-right::after,
  .editor-wrap.body-drop-top::after,
  .editor-wrap.body-drop-bottom::after {
    opacity: 1;
  }
  .editor-wrap.body-drop-left::after {
    border-left: 4px solid var(--pane-focus);
    background: linear-gradient(90deg, color-mix(in srgb, var(--pane-focus) 14%, transparent), transparent 34%);
  }
  .editor-wrap.body-drop-right::after {
    border-right: 4px solid var(--pane-focus);
    background: linear-gradient(270deg, color-mix(in srgb, var(--pane-focus) 14%, transparent), transparent 34%);
  }
  .editor-wrap.body-drop-top::after {
    border-top: 4px solid var(--pane-focus);
    background: linear-gradient(180deg, color-mix(in srgb, var(--pane-focus) 14%, transparent), transparent 34%);
  }
  .editor-wrap.body-drop-bottom::after {
    border-bottom: 4px solid var(--pane-focus);
    background: linear-gradient(0deg, color-mix(in srgb, var(--pane-focus) 14%, transparent), transparent 34%);
  }
  .pane-mode-preview {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 20px;
    text-align: center;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-card) 36%, transparent);
  }
  .pane-mode-title {
    max-width: 100%;
    color: var(--text);
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-mode-subtitle {
    max-width: 100%;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-mode-stale-warning {
    color: var(--warn-text);
    font-size: 14px;
    font-weight: 600;
  }
  /* Empty pane shell. Single-pane lone-pane case is hosted by the
     EmptyPaneCarousel component (welcome / metadata / indexing
     slides) which owns its own layout. Multi-pane empty case
     keeps the bare-logo placeholder-stack rhythm since adding
     a full carousel to a setup pane would just clutter. */
  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    overflow: auto;
  }
  .placeholder-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    color: var(--text-secondary);
    opacity: 0.6;
  }
  .placeholder-mark {
    width: 160px;
    height: 160px;
    background-color: var(--text-secondary);
    -webkit-mask: url('/chan-mark.png') center / contain no-repeat;
            mask: url('/chan-mark.png') center / contain no-repeat;
    opacity: 0.45;
  }
  @media (prefers-reduced-motion: reduce) {
    .pane {
      transition: border-color 100ms ease, box-shadow 120ms ease;
    }
    .pane.focused.wobble {
      animation: none;
    }
    .pane.sideFlipActive .pane-card-inner {
      animation: none;
    }
    .tab,
    .tab:hover {
      transition: background 80ms ease, color 80ms ease;
      transform: none;
    }
  }
</style>
