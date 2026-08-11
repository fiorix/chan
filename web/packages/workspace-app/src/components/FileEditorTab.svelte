<script lang="ts">
  // Body of a file tab. Editor formatting lives in the floating style
  // toolbar; the tab menu is intentionally small chrome: name, page
  // width, close.

  import { onDestroy, tick, untrack } from "svelte";
  import type { Extension } from "@codemirror/state";
  import Wysiwyg from "../editor/Wysiwyg.svelte";
  import Source from "../editor/Source.svelte";
  import {
    cancelPendingBufferWrite,
    clearEditorBuffer,
    divergentBufferOrNull,
    queueBufferWrite,
    type EditorBuffer,
  } from "../state/editorBuffer";
  import JsonPretty from "../editor/JsonPretty.svelte";
  import CsvTable from "../editor/CsvTable.svelte";
  import { openExternalUrl } from "../editor/external_links";
  import {
    internalLinkAtPoint,
    openLinkPreview,
    type InternalLinkHit,
  } from "../editor/link_preview";
  import {
    ClipboardPaste,
    Copy,
    ExternalLink,
    Eye,
    Files,
    Folder,
    Link as LinkIcon,
    Pencil,
    RefreshCw,
    Save,
    Scissors,
    Search as SearchIcon,
    Trash2,
    X,
  } from "lucide-svelte";
  import { chordFor, currentOS } from "../state/shortcuts";
  import { builtInChordSuperseded } from "../state/keymapOverrides.svelte";
  import FindBar from "./FindBar.svelte";
  import Inspector from "./Inspector.svelte";
  import OutlineBody, { type Heading } from "./OutlineBody.svelte";
  import FileInfoBody from "./FileInfoBody.svelte";
  import StyleToolbar from "./StyleToolbar.svelte";
  import { clampMenu } from "./menuClamp";
  import { portal } from "./portal";
  import {
    layout,
    allPaneTabs,
    attemptInPlaceReopen,
    beginMissingFileReopen,
    closeTab,
    dismissExternalChange,
    forceReloadFromDisk,
    isDocAttached,
    openFind,
    overwriteDiskConflict,
    reloadTabFromDisk,
    setMode,
    clearTabCaretCommand,
    setTabCaret,
    setTabInspectorOpen,
    setTabCodeBlocksCollapsed,
    setTabOutlineOpen,
    setTabSlidePreviewIndex,
    setTabSlidePreviewMode,
    setTabSlidePreviewOpen,
    type FileTab,
  } from "../state/tabs.svelte";
  import WikiStatusBar from "./WikiStatusBar.svelte";
  import {
    renderedCaretForSourceCaret,
    sourceCaretForRenderedCaret,
  } from "../editor/caret_mapping";
  import { parseSlidesSpec } from "../editor/slides";

  import {
    copyTextToClipboard,
    effectiveHybridSurfaceTheme,
    fileOps,
    isDraftPath,
    openFsGraphForFile,
    openGraphForFile,
    openGraphForMention,
    openGraphForTag,
    searchPanel,
    openGraphAtNode,
    paneWidths,
    persistPaneWidths,
    revealPathInBrowser,
    setTransientStatus,
    surfaceThemeOverride,
    ui,
  } from "../state/store.svelte";
  import {
    openInActivePane,
    openLinkTarget,
    openTerminalInPane,
    saveDraftTabToWorkspace,
    tabFocusPulse,
  } from "../state/tabs.svelte";
  import { terminalFromHereTarget } from "../terminal/fromHere";
  import { csvDelimiter, isCsv, isExcalidraw, isJson } from "../state/fileTypes";
  import {
    acquireDocSession,
    isDocSyncEligible,
    releaseDocSession,
    type DocSession,
  } from "../state/docSync.svelte";
  import {
    acquireSceneSession,
    isSceneSyncEligible,
    releaseSceneSession,
    type SceneSession,
  } from "../state/sceneSync.svelte";
  import {
    registerEditorCommands,
    unregisterEditorCommands,
  } from "../state/mountedEditors";
  import {
    PAGE_WIDTH_MAX_PCT,
    PAGE_WIDTH_MIN_PCT,
    PAGE_WIDTH_STEP_PCT,
    pageWidth,
    setPageWidth,
  } from "../state/pageWidth.svelte";
  import {
    openSlidePreview,
    type SlidePreviewHandle,
    type SlidePreviewMode,
  } from "../state/slidePreview";
  import {
    tabMenu,
    closeTabMenu,
    openTabMenu,
  } from "../state/tabMenu.svelte";
  // The Editor right-click menu carries no Open Inspector entry (the
  // pane chrome context menu has it) and no window-reload entry
  // (Cmd+R). "Reload from disk" below is different: it force-adopts
  // the on-disk content over the buffer/authority, the escape hatch
  // for external writers.

  // Keep-alive: Pane.svelte keeps every file tab mounted (terminal
  // precedent) and flips `active` -- true only when this tab is the
  // pane's selected, front-facing, non-pane-mode tab. It drives the
  // visibility CSS on the root below. `focused` additionally requires
  // the pane to be the active pane; it gates the focus effect below so
  // a global tab-focus pulse never pulls the caret into a NON-active
  // pane's (or a hidden) editor, and feeds the editors' autoFocus so
  // background mounts at session restore never steal the caret. Both
  // default false for any other mount site.
  let { tab, active = false, focused = false }: {
    tab: FileTab;
    active?: boolean;
    focused?: boolean;
  } = $props();
  let editorTabEl: HTMLDivElement | undefined = $state();

  // Editor refs so the outline body can call scrollToHeading /
  // scrollToLine on whichever editor variant is showing, and so
  // the toolbar can call into the Wysiwyg formatting API.
  let wysiwygRef: Wysiwyg | undefined = $state();
  let sourceRef: Source | undefined = $state();
  let slidePreviewHandle: SlidePreviewHandle | null = null;
  const editorTheme = $derived(effectiveHybridSurfaceTheme("editor"));
  const slidePreviewOpen = $derived(tab.slidePreview?.open === true);

  // Excalidraw canvas body. Kept out of the eager bundle: the wrapper is
  // dynamic-imported on first activation, then latched, so N restored
  // whiteboards do not all spin up a React root at once (Pane keeps every
  // file-tab body mounted). The typeof import(...) below is a type-only
  // query and does not pull the module into the eager graph.
  let canvasRef: { focusCanvas: () => void } | undefined = $state();
  let ExcalidrawCanvas =
    $state<typeof import("../editor/ExcalidrawCanvas.svelte").default | null>(null);
  $effect(() => {
    if (active && tab.mode === "canvas" && !ExcalidrawCanvas) {
      void import("../editor/ExcalidrawCanvas.svelte").then((m) => {
        ExcalidrawCanvas = m.default;
      });
    }
  });

  // Pull keyboard focus into the editor whenever this pane is the
  // active one. `focused` is read first so it is a tracked dependency:
  // the effect re-runs when the pane gains focus (keyboard pane nav,
  // flip back to the front face) and lands the caret here. Reading
  // `tabFocusPulse.value` adds the within-pane tab-switch trigger
  // (Cmd+Shift+[/], Ctrl+Alt+1..9). The `!focused` gate is what stops a
  // pulse from focusing a sibling pane's editor and desyncing the caret
  // from the focus highlight. queueMicrotask defers past the
  // synchronous chord-handler stack so the editor view has had a tick to
  // take the activeElement back from `<body>` (which `bumpTabFocusPulse`
  // parks us on by blurring the prior focus).
  $effect(() => {
    if (!focused) return;
    tabFocusPulse.value;
    queueMicrotask(() => {
      if (!focused) return;
      focusActiveEditor();
    });
  });

  function focusActiveEditor(): void {
    if (tab.mode === "wysiwyg") wysiwygRef?.focus();
    else if (tab.mode === "canvas") canvasRef?.focusCanvas();
    else sourceRef?.focus();
  }

  function refocusAfterSlidePreviewClose(): void {
    void tick().then(() => {
      if (!active || !focused) return;
      focusActiveEditor();
    });
  }

  // Imperative caret-command channel. A kept-alive tab's editor snapshots
  // `initialCaret` once at mount and then latches, so re-opening an already-
  // mounted tab (File-Browser reclick, `cs open` twice, a link that restores
  // a saved caret) cannot move the caret through the prop. `openInPane` sets a
  // fresh `tab.caretCommand` on such an open; this effect drives the live
  // editor to it via `resetCaret`. Tracking `tab.caretCommand` only (NOT
  // `tab.caret`, which is rewritten on every keystroke) keeps this from
  // re-firing while typing. The microtask defers past the open stack and reads
  // `tab.mode` untracked, mirroring the focus effect above, so a later mode
  // toggle (which remaps the caret itself) does not replay a stale command.
  $effect(() => {
    const cmd = tab.caretCommand;
    if (!cmd) return;
    queueMicrotask(() => {
      if (tab.mode === "wysiwyg") wysiwygRef?.resetCaret(cmd.from, cmd.to);
      else sourceRef?.resetCaret(cmd.from, cmd.to);
      // One-shot: clear so a later remount of this kept-alive tab (a move /
      // detach to another pane) does not replay a stale command and yank the
      // caret. Reassigning to undefined just re-runs this effect to a no-op.
      clearTabCaretCommand(tab);
    });
  });

  // Active-flip recovery, mirroring TerminalTab: a kept-alive tab can
  // become active WITHOUT gaining focus (flip-back, pane-mode exit, a
  // tab switch in a non-active pane), so the focus effect above never
  // runs. Nudge CM6 to re-measure so any viewport work deferred while
  // hidden converges as soon as the tab is visible again.
  $effect(() => {
    if (!active) return;
    wysiwygRef?.remeasure();
    sourceRef?.remeasure();
  });

  // Hang-recovery via localStorage (editorBuffer.ts). A force-reload
  // skips Svelte component cleanups, so the debounce + flush machinery
  // lives in that module where App.svelte's `beforeunload` / `pagehide`
  // listeners can drain it. Here we decide, once per disk load, whether
  // a stored buffer is recoverable work, and keep the persisted buffer
  // in step with the editor's clean/dirty state. The buffer is keyed on
  // `tab.path` because tab ids regenerate on every page load; the path
  // is what survives the reload the recovery exists for.
  let recoveredBuffer: EditorBuffer | null = $state(null);

  $effect(() => {
    // Recovery decision. Deliberately depends on the on-disk content
    // (`tab.saved`), NOT `tab.content`: it re-runs on load / save /
    // reload but never on keystrokes, so it cannot mistake the user's
    // own in-progress edits for a prior session. divergentBufferOrNull
    // offers a buffer only when it came from a different page load,
    // diverges from disk, and postdates the last save; on a save it
    // resolves to null, which dismisses the banner with no extra
    // bookkeeping. Declared before the persistence effect so it
    // captures the buffer before that effect can touch storage.
    const saved = tab.saved;
    if (saved === undefined || tab.loading) return;
    recoveredBuffer = divergentBufferOrNull(
      tab.path,
      tab.path,
      saved,
      tab.savedMtimeNs,
    );
  });

  $effect(() => {
    // Cancel any pending debounced write when the tab unmounts
    // gracefully (Cmd+W close / tab swap). Force-reload doesn't reach
    // this path; App.svelte's unload listeners flush instead.
    const path = tab.path;
    return () => cancelPendingBufferWrite(path);
  });

  $effect(() => {
    // Keep the persisted buffer in step with the editor. Wait for the
    // disk content to load (`saved` defined) so the placeholder empty
    // content can't queue a write that races the fetch. While the
    // editor is dirty, persist a debounced copy; once it returns to
    // clean state, drop the buffer so a stale entry can't outlive the
    // edit. A pending recovery buffer is left alone: it belongs to a
    // previous load and its banner is still being offered, so clearing
    // it here would lose unsaved work if the user switches tabs before
    // acting. The recovery effect above drops that banner on the next
    // save, after which this branch clears normally.
    const content = tab.content;
    const saved = tab.saved;
    if (saved === undefined || tab.loading) return;
    if (content === saved) {
      cancelPendingBufferWrite(tab.path);
      if (recoveredBuffer === null) clearEditorBuffer(tab.path);
      return;
    }
    queueBufferWrite(tab.path, content, tab.path);
  });

  function restoreFromBuffer(): void {
    if (!recoveredBuffer) return;
    tab.content = recoveredBuffer.content;
    recoveredBuffer = null;
    // The restored content now diverges from disk, so the persistence
    // effect re-persists it under the current session on the next tick.
  }

  function discardBuffer(): void {
    clearEditorBuffer(tab.path);
    recoveredBuffer = null;
  }

  /// Read-only mode for this tab. The status bar's lamp toggle
  /// workspaces `tab.readMode` directly; an OS-level read-only file
  /// (no user-write bit) is reflected through `tab.fsWritable`
  /// and overrides the lamp so the user can't try to write.
  /// Per-tab so multi-pane layouts can mix read/write without
  /// a global signal fighting between panes.
  const readOnly = $derived(
    tab.loading || tab.readMode || !tab.fsWritable || slidePreviewOpen,
  );
  const loadingText = $derived(
    tab.loadProgress?.totalBytes
      ? `loading ${formatBytes(tab.loadProgress.loadedBytes)} / ${formatBytes(tab.loadProgress.totalBytes)}`
      : "loading...",
  );

  /// 0-indexed source line under the caret. Workspaces the outline's
  /// active-heading marker (Google-Docs-style "you are here" bar
  /// on the guide line). Counts newlines up to tab.caret.from in
  /// O(n) which is fine for the buffer sizes chan deals with.
  const caretLine = $derived.by((): number | null => {
    if (!tab.caret) return null;
    const upto = tab.content.slice(0, tab.caret.from);
    let n = 0;
    for (let i = 0; i < upto.length; i++) if (upto.charCodeAt(i) === 10) n++;
    return n;
  });
  const slidesSpec = $derived(parseSlidesSpec(tab.content));
  const slideShortcutOS = currentOS();

  /// Live doc-session lifecycle. The effect tracks ONLY the eligibility
  /// inputs (path, mode, loading, fileMissing via isDocSyncEligible);
  /// the acquire itself runs untracked so its size-gate read of
  /// tab.content does not re-fire the effect on every keystroke (which
  /// would release + reacquire the session and re-mint the editor's
  /// extension per character). The cleanup release lingers briefly so a
  /// cross-pane move (a full remount) keeps the socket + shadow. Tab
  /// close and rename release immediately through the tabs hook instead.
  let docSession: DocSession | null = $state(null);
  $effect(() => {
    const eligible = isDocSyncEligible(tab);
    const tabId = tab.id;
    untrack(() => {
      docSession = eligible ? acquireDocSession(tab) : null;
      if (!eligible) releaseDocSession(tabId);
    });
    return () =>
      untrack(() => {
        docSession = null;
        releaseDocSession(tabId);
      });
  });
  /// Live scene-session lifecycle for canvas tabs, the exact shape of
  /// the doc effect above: eligibility inputs tracked, the acquire
  /// untracked (its size gate reads tab.content), release lingering so
  /// a cross-pane move keeps the socket + shadow.
  let sceneSession: SceneSession | null = $state(null);
  $effect(() => {
    const eligible = isSceneSyncEligible(tab);
    const tabId = tab.id;
    untrack(() => {
      sceneSession = eligible ? acquireSceneSession(tab) : null;
      if (!eligible) releaseSceneSession(tabId);
    });
    return () =>
      untrack(() => {
        sceneSession = null;
        releaseSceneSession(tabId);
      });
  });
  /// Per-editor-mount collab + presence extension bundle, minted ONCE
  /// per (session, mode) and memoized. session.extension() mints a fresh
  /// compartment + ViewPlugin every call, and the ViewPlugin's
  /// constructor drives bindView -> tryAttach -> dispatch; returning a
  /// fresh bundle on every derived recompute would reconstruct the
  /// plugin on each attach-driven state write and storm microtasks. A
  /// stable reference per (session, mode) means the editors'
  /// extraExtensions compartment only reconfigures on a real change (new
  /// session, or a mode toggle that mounts a fresh editor - the toggle
  /// is where collab genuinely needs a fresh compartment).
  let docExtCache: { key: string; ext: Extension[] } | null = null;
  const docExtensions = $derived.by((): Extension[] => {
    const key = docSession ? `${docSession.token}:${tab.mode}` : "none";
    if (docExtCache?.key === key) return docExtCache.ext;
    const ext = docSession ? [docSession.extension()] : [];
    docExtCache = { key, ext };
    return ext;
  });

  // Bumped on every selection / doc change in the WYSIWYG editor so
  // the StyleToolbar's active-mark / current-block derivations re-run.
  // The value itself doesn't matter; the dependency does. Toolbar
  // lives in a child component now; we still own the signal so any
  // sibling (status bar, outline) can hook into it later.
  let selVer = $state(0);

  function jumpTo(h: Heading): void {
    if (tab.mode === "wysiwyg") wysiwygRef?.scrollToHeading(h.index);
    else sourceRef?.scrollToLine(h.line);
  }

  function previewSlides(): void {
    setTabSlidePreviewMode(tab, "preview");
    setTabSlidePreviewOpen(tab, true);
    openOrUpdateSlidePreview(false, "preview");
  }

  function playSlides(): void {
    setTabSlidePreviewMode(tab, "play");
    setTabSlidePreviewOpen(tab, true);
    openOrUpdateSlidePreview(false, "play");
  }

  function onSlideShortcutKeydown(e: KeyboardEvent): void {
    if (!slidesSpec || tab.loading || e.key !== "Enter" || e.altKey) return;
    if (!slideShortcutModifierPressed(e)) return;
    if (shouldIgnoreSlideShortcutTarget(e.target)) return;

    // The capture claim covers ONLY the built-in chord shape, and only
    // while that built-in is still in force: a user assignment for the
    // deck action supersedes it, and the assigned chord dispatches
    // through App.svelte's override path into the catalog command and
    // the mountedEditors seam. Never match by resolved chord here -
    // that would claim whatever the user assigned in the capture phase,
    // ahead of CodeMirror, where conflict detection cannot see a single
    // CM6 binding (assigning Shift+Tab would silently delete list
    // outdent on every deck).
    const slideAction = e.shiftKey ? "app.slides.present" : "app.slides.preview";
    if (builtInChordSuperseded(slideAction)) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) playSlides();
    else previewSlides();
  }

  function slideShortcutModifierPressed(e: KeyboardEvent): boolean {
    return slideShortcutOS === "mac" ? e.metaKey : e.ctrlKey;
  }

  function shouldIgnoreSlideShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target.closest(".cm-editor")) return false;
    return target.closest("input, textarea, select, button, [role='button']") !== null;
  }

  function openOrUpdateSlidePreview(
    fromStoredIndex: boolean,
    mode: SlidePreviewMode = tab.slidePreview?.mode ?? "preview",
  ): void {
    const initialIndex = fromStoredIndex ? (tab.slidePreview?.index ?? 0) : null;
    const updateOpts = {
      source: tab.content,
      fromPath: tab.path,
      initialIndex,
      styleSource: editorTabEl ?? null,
      theme: editorTheme,
      mode,
    };
    if (slidePreviewHandle) {
      slidePreviewHandle.update(updateOpts);
      return;
    }
    const handle = openSlidePreview({
      ...updateOpts,
      currentLine: caretLine,
      onSlideChange: (index) => setTabSlidePreviewIndex(tab, index),
      onClose: () => {
        setTabSlidePreviewOpen(tab, false);
        slidePreviewHandle = null;
        refocusAfterSlidePreviewClose();
      },
    });
    if (!handle) {
      setTabSlidePreviewOpen(tab, false);
      return;
    }
    slidePreviewHandle = handle;
  }

  $effect(() => {
    const open = slidePreviewOpen;
    const loading = tab.loading;
    const activeTab = active;
    const content = tab.content;
    const path = tab.path;
    const theme = editorTheme;
    const index = tab.slidePreview?.index ?? 0;
    const mode = tab.slidePreview?.mode ?? "preview";
    const styleSource = editorTabEl ?? null;
    if (!open || loading || !activeTab) {
      slidePreviewHandle?.close({ notify: false });
      slidePreviewHandle = null;
      return;
    }
    void content;
    void path;
    void theme;
    void index;
    void mode;
    void styleSource;
    openOrUpdateSlidePreview(true, mode);
  });

  // Find-on-page adapter for whichever editor is mounted. Both
  // editors expose `findAdapter` (see editor/find.ts FindAdapter)
  // with the same shape; FindBar.svelte workspaces it. We re-derive
  // on mode flip so a Wysiwyg <-> Source toggle while the bar is
  // open re-paints highlights against the new view.
  const findAdapter = $derived(
    tab.mode === "wysiwyg" ? wysiwygRef?.findAdapter : sourceRef?.findAdapter,
  );

  /// Reveal the open file in a File Browser tab. Expand every
  /// ancestor directory so the row is visible, set the browser
  /// selection to this file, then focus/create the tab. Mirrors the
  /// post-create/move "land next to the thing you just produced"
  /// flow in `revealAndSelect`.
  function revealInBrowser(): void {
    revealPathInBrowser(tab.path, { inspectorOpen: true });
    closeTabMenu();
  }

  // In-tab find was removed; the browser's native ⌘F applies. The
  // editor's selectable text (WYSIWYG and source) is plain DOM, so
  // browser find lights up matches the way users already expect.

  /// True while the popover for THIS tab is open. The tab-menu state
  /// is shared so the trigger button (in Pane.svelte's tab strip) can
  /// open it; the bubble itself renders here so it has direct access
  /// to `wysiwygRef` + the reactive `selVer` signal.
  const menuOpen = $derived(tabMenu.openForTabId === tab.id);

  /// Bubble positioning. The desired anchor is the trigger's bottom-
  /// left; the actual placement runs through `clampMenu` so a tab
  /// docked near the right or bottom edge still renders fully on-
  /// screen (clamp re-flips to the left / above as needed).
  const menuPos = $derived.by(() => {
    const a = tabMenu.anchor;
    if (!a) return { x: 0, y: 0 };
    return { x: Math.round(a.left), y: Math.round(a.bottom + 4) };
  });

  function onMenuKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeTabMenu();
    }
  }

  /// Dismiss when the click lands outside the bubble AND outside any
  /// tab row (the row's own click handler already toggles the state,
  /// so we ignore clicks that bubble up from it - without this guard
  /// the global handler closes the menu before the row handler has a
  /// chance to reopen it, and a second click on the active tab feels
  /// dead).
  function onDocPointerDown(e: PointerEvent): void {
    if (!menuOpen) return;
    const t = e.target as Node | null;
    if (!t) return;
    const bubble = document.querySelector(".tab-menu-bubble");
    if (bubble && bubble.contains(t)) return;
    const trigger = (t as Element).closest?.(".tab");
    if (trigger) return;
    closeTabMenu();
  }

  function onPageWidthSlider(e: Event): void {
    const pct = Number((e.currentTarget as HTMLInputElement).value);
    setPageWidth(pct / 100);
  }

  function paneIdForTab(): string | null {
    for (const [paneId, node] of Object.entries(layout.nodes)) {
      if (node.kind === "leaf" && allPaneTabs(node).some((candidate) => candidate.id === tab.id)) {
        return paneId;
      }
    }
    return null;
  }

  function doCloseTab(): void {
    closeTabMenu();
    const paneId = paneIdForTab();
    if (paneId) void closeTab(paneId, tab.id);
  }

  function parentPath(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
  }

  /// In-menu inline rename (an editable Name input in the
  /// right-click menu). Commits on Enter + blur, NOT every keystroke
  /// (file rename is destructive + cross-tree, can't fire on each
  /// character). Uses `fileOps.renameInPlace` which handles path
  /// traversal (`../other/dir/`), extension preservation, and link
  /// rewriting.
  let nameDraft = $state("");
  const isDraftEditorTab = $derived(isDraftPath(tab.path));
  $effect(() => {
    // Sync the draft to the tab path when the underlying file
    // changes (e.g. external rename, or another menu surface).
    // Fires on mount so the input starts seeded; fires again on
    // tab.path mutation so external renames stay reflected.
    nameDraft = tab.path;
  });
  async function commitTabName(): Promise<void> {
    const next = nameDraft.trim();
    if (!next || next === tab.path) {
      nameDraft = tab.path;
      return;
    }
    await fileOps.renameInPlace(tab.path, next, false);
  }
  function onTabNameKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      nameDraft = tab.path;
      (e.currentTarget as HTMLInputElement).blur();
    }
  }
  async function doSaveDraftToWorkspace(): Promise<void> {
    closeTabMenu();
    await saveDraftTabToWorkspace(tab);
  }

  /// True for tabs that have a structured render mode alongside
  /// source mode. Markdown (wysiwyg), JSON (pretty), CSV/TSV (table).
  /// Arbitrary text tabs do not (source is the only sensible
  /// surface for a .py / .toml / Makefile).
  const hasRenderedMode = $derived(
    tab.fileKind !== "text" ||
      isJson(tab.path) ||
      isCsv(tab.path) ||
      isExcalidraw(tab.path),
  );

  /// Which render mode this tab pairs with source mode. Workspaces the
  /// toggle button copy + the icon picker below.
  const renderedModeForTab = $derived<"wysiwyg" | "pretty" | "table" | "canvas">(
    isExcalidraw(tab.path)
      ? "canvas"
      : isJson(tab.path)
        ? "pretty"
        : isCsv(tab.path)
          ? "table"
          : "wysiwyg",
  );

  function doToggleMode(): void {
    if (!hasRenderedMode) return;
    const rendered = renderedModeForTab;
    const next = tab.mode === "source" ? rendered : "source";
    if (tab.caret && rendered === "wysiwyg") {
      const mapped =
        next === "wysiwyg"
          ? renderedCaretForSourceCaret(tab.content, tab.caret)
          : sourceCaretForRenderedCaret(tab.content, tab.caret);
      setTabCaret(tab, mapped.from, mapped.to);
    }
    setMode(tab, next);
    closeTabMenu();
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  const markdownToolsEnabled = $derived(tab.fileKind !== "text");

  function doToggleCodeBlocks(): void {
    if (!markdownToolsEnabled) return;
    const changed =
      tab.mode === "wysiwyg"
        ? wysiwygRef?.toggleCodeBlocksInEditor()
        : sourceRef?.toggleCodeBlocksInEditor();
    if (changed) setTabCodeBlocksCollapsed(tab, !tab.codeBlocksCollapsed);
    closeTabMenu();
  }

  // ---- right-click context menu --------------------------------------

  // Link state for the body menu, captured at right-click time BEFORE
  // the menu portal covers the click point. `bodyLinkUrl` = the external
  // URL under the cursor; `bodyPreviewHit` = the internal wiki link
  // under the cursor. Both null when the click was off a link.
  let bodyLinkUrl = $state<string | null>(null);
  let bodyPreviewHit = $state<InternalLinkHit | null>(null);

  function onEditorContext(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    bodyLinkUrl =
      activeEditorRef()?.externalUrlAtCoords(e.clientX, e.clientY) ?? null;
    bodyPreviewHit = internalLinkAtPoint(e.clientX, e.clientY);
    openTabMenu(
      tab.id,
      {
        left: e.clientX,
        top: e.clientY,
        right: e.clientX,
        bottom: e.clientY,
      },
      "body",
    );
  }

  /// The editor instance for the active mode. Source and Wysiwyg expose
  /// the same clipboard surface; the body menu routes to whichever is
  /// rendered.
  function activeEditorRef(): Wysiwyg | Source | undefined {
    return tab.mode === "source" ? sourceRef : wysiwygRef;
  }

  /// Selection text in the active editor, sampled whenever the body menu
  /// (re)opens (tabMenu.anchor changes per open) and whenever the
  /// Wysiwyg selection moves (selVer). Gates the body-context Cut / Copy
  /// / Search entries.
  const bodySelectionText = $derived.by(() => {
    void selVer;
    void tabMenu.anchor;
    return activeEditorRef()?.selectionText() ?? "";
  });
  const bodyHasSelection = $derived(bodySelectionText.trim().length > 0);
  // A ring-selected image carries no text selection, so its markdown source
  // is read separately (Wysiwyg only; source mode selects the image text
  // like any other run). It gates Copy alone, not Cut / Search.
  const bodyImageMarkdown = $derived.by<string | null>(() => {
    void selVer;
    void tabMenu.anchor;
    return tab.mode === "wysiwyg"
      ? (wysiwygRef?.selectedImageMarkdown() ?? null)
      : null;
  });
  const bodyCanCopy = $derived(bodyHasSelection || bodyImageMarkdown !== null);

  // Expose this editor's imperative surface (code-block fold, live
  // selection, slide-deck actions) to the command catalog, keyed by tab
  // id. Every mounted file tab registers; the catalog reaches the
  // focused one through activeFileTab().id. Cleared on destroy. The
  // deck actions gate on the same slidesSpec the capture handler and the
  // Outline buttons key off, so a catalog run on a non-deck is a no-op.
  $effect(() => {
    registerEditorCommands(tab.id, {
      toggleCodeBlocks: () => doToggleCodeBlocks(),
      selectionText: () => activeEditorRef()?.selectionText() ?? "",
      previewSlides: () => {
        if (slidesSpec && !tab.loading) previewSlides();
      },
      playSlides: () => {
        if (slidesSpec && !tab.loading) playSlides();
      },
    });
    return () => unregisterEditorCommands(tab.id);
  });

  function doCopySelection(): void {
    closeTabMenu();
    void activeEditorRef()?.copySelection();
  }
  function doCutSelection(): void {
    closeTabMenu();
    void activeEditorRef()?.cutSelection();
  }
  function doPasteClipboard(): void {
    closeTabMenu();
    void activeEditorRef()?.pasteClipboard();
  }

  function doOpenLink(): void {
    const url = bodyLinkUrl;
    closeTabMenu();
    if (url) void openExternalUrl(url);
  }
  async function doCopyLink(): Promise<void> {
    const url = bodyLinkUrl;
    closeTabMenu();
    if (!url) return;
    await copyTextToClipboard(url, {
      onSuccess: () => setTransientStatus("Copied link"),
      onError: (msg) => {
        ui.status = `copy failed: ${msg}`;
        // Persistent so the error pill is dismissable; a null statusKind
        // would leave it stuck with no x and no auto-clear.
        ui.statusKind = "persistent";
      },
    });
  }

  async function doCopyPathToFile(): Promise<void> {
    closeTabMenu();
    await copyTextToClipboard(tab.path, {
      onSuccess: () => setTransientStatus("Copied file path"),
      onError: (msg) => {
        ui.status = `copy failed: ${msg}`;
        ui.statusKind = "persistent";
      },
    });
  }

  async function doDeleteFile(): Promise<void> {
    closeTabMenu();
    await fileOps.remove(tab.path, false);
  }

  async function doDuplicateFile(): Promise<void> {
    closeTabMenu();
    await fileOps.duplicateFile(tab.path);
  }

  /// Open the read-only markdown preview for the internal wiki link
  /// under the cursor. The popover's Open button navigates to the
  /// target in the active pane.
  function doPreviewLink(): void {
    const hit = bodyPreviewHit;
    closeTabMenu();
    if (!hit) return;
    openLinkPreview({
      hit,
      fromPath: tab.path,
      onOpen: () => void openInActivePane(hit.target),
    });
  }

  async function doReload(): Promise<void> {
    closeTabMenu();
    await reloadTabFromDisk(tab.id);
  }

  async function doForceReload(): Promise<void> {
    closeTabMenu();
    await forceReloadFromDisk(tab.id);
  }

  /// Find opens the per-tab find bar via the `openFind(tabId)`
  /// helper that the `app.find.open` chord also routes to.
  function doFind(): void {
    closeTabMenu();
    openFind(tab.id);
  }

  function doOpenSearch(): void {
    closeTabMenu();
    // SearchPanel's open-effect calls extractSearchSeed() on the
    // open transition, which reads window.getSelection() and pre-
    // fills `searchPanel.query` when the user had text highlighted.
    // Same flow as the Mod+Shift+F chord - no extra wiring needed
    // beyond setting the open bit here.
    searchPanel.open = true;
  }

  // The "choose the moved file" reopen instruction (set in
  // doReopenMissing) is a deliberately persistent status (see
  // toastAutoDismissSweep.test). Clear it when this tab unmounts, so an
  // abandoned reopen (the user closes the tab instead of picking the
  // moved file) does not leave the status stuck in the bar. The literal
  // must match the one set below.
  onDestroy(() => {
    slidePreviewHandle?.close({ notify: false });
    if (ui.status === "Choose the moved file in Files to re-open this tab") {
      ui.status = null;
    }
  });

  async function doReopenMissing(): Promise<void> {
    // First try to restore the SAME file at its original path -     // covers the false-positive case where the panel surfaced
    // briefly because of an atomic-write race that's since
    // resolved. If the file is genuinely gone, fall through to
    // the FB-navigation flow so the user can pick the moved file
    // manually.
    if (await attemptInPlaceReopen(tab.id)) return;
    const parent = parentPath(tab.path);
    beginMissingFileReopen(tab.id);
    revealPathInBrowser(parent || tab.path, { inspectorOpen: true });
    ui.status = "Choose the moved file in Files to re-open this tab";
  }

  function doReopenAtSuggested(): void {
    const suggested = tab.fileMissing?.suggestedPath;
    if (!suggested) return;
    beginMissingFileReopen(tab.id);
    void openInActivePane(suggested);
  }

  function doFindMissing(): void {
    const fragment = tab.fileMissing?.fragment;
    if (fragment) searchPanel.query = fragment;
    searchPanel.open = true;
  }

  function doOpenGraph(): void {
    closeTabMenu();
    // "Graph from here" from a file's menu scopes the graph to that
    // file (file:<path>), not the whole workspace. Hashtags etc. still
    // route through openGraphAtNode at workspace scope.
    openGraphForFile(tab.path);
  }

  function doTerminalFromHere(): void {
    closeTabMenu();
    openTerminalInPane(layout.activePaneId, terminalFromHereTarget(tab.path, false));
  }

  /// Chord lookup for the editor menu rows, override-aware (user
  /// assignment first, then the built-in). Rows without a chord render an
  /// empty cell so the right column stays aligned.
  function chordLabel(id: string | undefined): string {
    return id ? (chordFor(id) ?? "") : "";
  }

  // The Outline's slide-action buttons advertise the live chord so a
  // rebind is reflected in the tooltip. Derived (not a plain call) so
  // the label re-resolves when the override store changes.
  const slidePreviewChord = $derived(chordLabel("app.slides.preview"));
  const slidePresentChord = $derived(chordLabel("app.slides.present"));

  const showPageWidthMenuRow = $derived(tab.mode !== "canvas");

  function closeTabMenuChordLabel(): string {
    // The canvas surface keeps Ctrl+D for Excalidraw's duplicate gesture, so
    // the macOS menu should advertise the working app-level close path.
    if (tab.mode === "canvas" && currentOS() === "mac") return "Cmd+W";
    return chordLabel("app.tab.close");
  }
</script>

<svelte:window onkeydown={onMenuKeydown} onpointerdown={onDocPointerDown} />

<div
  class="editor-tab"
  class:active
  bind:this={editorTabEl}
  role="tabpanel"
  aria-hidden={!active}
  data-theme={surfaceThemeOverride("editor")}
>
  {#if recoveredBuffer}
    <!-- Hang-recovery banner. Surfaces when a previous page load left
         unsaved content for this file that diverges from disk. The user
         picks Restore (replace the editor content with the buffer) or
         Discard (keep the disk content). Either choice dismisses it. -->
    <div class="recovery-banner" role="alert">
      <span class="recovery-banner-text">
        Unsaved changes from a previous session were found.
      </span>
      <button
        type="button"
        class="recovery-banner-btn recovery-banner-restore"
        onclick={restoreFromBuffer}
      >
        Restore
      </button>
      <button
        type="button"
        class="recovery-banner-btn"
        onclick={discardBuffer}
      >
        Discard
      </button>
    </div>
  {/if}
  {#if tab.externalChange && !isDocAttached(tab) && !tab.diskConflicted}
    <!-- An external (non-self) write to this file landed on disk
         while the tab is open. We never auto-reload (that would
         replace the buffer and snap the caret to 1:1 mid-edit); the
         user opts into the reload here or keeps typing (their next
         save hits the 409 conflict modal). Attached tabs never show
         it: the authority merges external writes live. Reuses the
         recovery-banner palette + layout. -->
    <div class="recovery-banner" role="alert">
      <span class="recovery-banner-text">
        This file changed on disk.
      </span>
      <button
        type="button"
        class="recovery-banner-btn recovery-banner-restore"
        onclick={() => void reloadTabFromDisk(tab.id)}
      >
        Reload
      </button>
      <button
        type="button"
        class="recovery-banner-btn"
        aria-label="Dismiss changed-on-disk notice"
        onclick={() => dismissExternalChange(tab.id)}
      >
        ✕
      </button>
    </div>
  {/if}
  {#if tab.diskConflicted}
    <!-- The live session's authority and an external disk write both
         changed the same region: the server paused flushing and holds
         both sides. Not dismissable -- the divergence is real until
         one side is picked (reload adopts the disk; keep-mine
         overwrites it). Reuses the recovery-banner palette + layout. -->
    <div class="recovery-banner" role="alert">
      <span class="recovery-banner-text">
        This file changed on disk and conflicts with your edits.
      </span>
      <button
        type="button"
        class="recovery-banner-btn recovery-banner-restore"
        onclick={() => void forceReloadFromDisk(tab.id)}
      >
        Reload from disk
      </button>
      <button
        type="button"
        class="recovery-banner-btn"
        onclick={() => void overwriteDiskConflict(tab.id)}
      >
        Keep mine
      </button>
    </div>
  {/if}
  {#if menuOpen}
    <!-- Tab menu bubble. Anchored to the tab title in the pane's
         tab strip; rendered here so it has direct access to the
         live Wysiwyg ref + selVer signal that workspaces the
         formatting buttons' "on" states. -->
    <div
      class="tab-menu-bubble"
      role="menu"
      tabindex="-1"
      aria-label="tab menu"
      use:portal
      use:clampMenu={menuPos}
      onmousedown={(e) => e.stopPropagation()}
    >
      <!-- Editor tab menu: editable name, page width, and close.
           Editing and navigation actions live in the command launcher
           or body-context menu. -->
      {#if tabMenu.source === "body"}
        <!-- Body-context menu (right-click in the editor body): a
             tight, selection-aware set. Cut/Copy gate on a selection;
             Paste is plain text (rich paste stays on Cmd+V). Find is
             always present; Search appears only with a selection
             (doOpenSearch auto-seeds from the highlighted text). Link
             actions appear only when the click landed on a link. -->
        <div class="action-list">
          <button
            class="mbtn"
            onclick={doCutSelection}
            disabled={!bodyHasSelection}
          >
            <span class="mbtn-icon">
              <Scissors size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Cut</span>
            <span class="mbtn-chord"></span>
          </button>
          <button
            class="mbtn"
            onclick={doCopySelection}
            disabled={!bodyCanCopy}
          >
            <span class="mbtn-icon">
              <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Copy</span>
            <span class="mbtn-chord"></span>
          </button>
          <button class="mbtn" onclick={doPasteClipboard}>
            <span class="mbtn-icon">
              <ClipboardPaste size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Paste</span>
            <span class="mbtn-chord"></span>
          </button>
          {#if bodyLinkUrl || bodyPreviewHit}
            <div class="msep" role="separator"></div>
            {#if bodyLinkUrl}
              <button class="mbtn" onclick={doOpenLink}>
                <span class="mbtn-icon">
                  <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span class="mbtn-label">Open link</span>
                <span class="mbtn-chord"></span>
              </button>
              <button class="mbtn" onclick={doCopyLink}>
                <span class="mbtn-icon">
                  <LinkIcon size={16} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span class="mbtn-label">Copy link</span>
                <span class="mbtn-chord"></span>
              </button>
            {/if}
            {#if bodyPreviewHit}
              <button class="mbtn" onclick={doPreviewLink}>
                <span class="mbtn-icon">
                  <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span class="mbtn-label">Preview</span>
                <span class="mbtn-chord"></span>
              </button>
            {/if}
          {/if}
          <div class="msep" role="separator"></div>
          <button class="mbtn" onclick={doFind}>
            <span class="mbtn-icon">
              <SearchIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Find</span>
            <span class="mbtn-chord">{chordLabel("app.find.open")}</span>
          </button>
          {#if bodyHasSelection}
            <button class="mbtn" onclick={doOpenSearch}>
              <span class="mbtn-icon">
                <SearchIcon size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span class="mbtn-label">Search selection</span>
              <span class="mbtn-chord">{chordLabel("app.search.toggle")}</span>
            </button>
          {/if}
          <div class="msep" role="separator"></div>
          <button class="mbtn" onclick={() => void doForceReload()}>
            <span class="mbtn-icon">
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Reload from disk</span>
            <span class="mbtn-chord"></span>
          </button>
        </div>
      {:else}
      <div class="action-list">
        {#if isDraftEditorTab}
          <button class="mbtn" type="button" onclick={doSaveDraftToWorkspace}>
            <span class="mbtn-icon">
              <Save size={18} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="mbtn-label">Save to Workspace</span>
          </button>
        {:else}
          <!-- Editable Name input, like the Terminal tab's. Commits
               on Enter/blur via fileOps.renameInPlace which handles
               path traversal, extension preservation, and link
               rewriting. -->
          <label class="name-row">
            <span class="name-label">
              <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>Name</span>
            </span>
            <input
              class="name-input"
              bind:value={nameDraft}
              spellcheck="false"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              onkeydown={onTabNameKey}
              onblur={commitTabName}
              aria-label="file path"
            />
          </label>
        {/if}
        {#if showPageWidthMenuRow}
          <div class="msep" role="separator"></div>
          <!-- Page-width slider: ratio of the current window width.
               100 % is the "no cap" sentinel (drag all the way right).
               Stored as a ratio so window resize and browser zoom both
               keep the cap proportional to the viewport. -->
          <div class="page-width-row">
            <span class="page-width-label">Page width</span>
            <input
              class="page-width-slider"
              type="range"
              min={PAGE_WIDTH_MIN_PCT}
              max={PAGE_WIDTH_MAX_PCT}
              step={PAGE_WIDTH_STEP_PCT}
              value={Math.round(pageWidth.ratio * 100)}
              oninput={onPageWidthSlider}
              onmousedown={(e) => e.stopPropagation()}
              aria-label="page width"
            />
            <span class="page-width-value">{Math.round(pageWidth.ratio * 100)}%</span>
          </div>
        {/if}
        <div class="msep" role="separator"></div>
        <button class="mbtn" onclick={() => void doCopyPathToFile()}>
          <span class="mbtn-icon">
            <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Copy path to file</span>
          <span class="mbtn-chord">{chordLabel("app.editor.copyPath")}</span>
        </button>
        <!-- No chord hint: `app.files.delete` (Backspace) only binds in
             FileTree's rows; nothing in the editor tab dispatches it. -->
        <button class="mbtn" onclick={() => void doDeleteFile()}>
          <span class="mbtn-icon">
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Delete</span>
        </button>
        <button class="mbtn" onclick={() => void doDuplicateFile()}>
          <span class="mbtn-icon">
            <Files size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Duplicate</span>
          <span class="mbtn-chord">{chordLabel("app.file.duplicate")}</span>
        </button>
        <button class="mbtn" onclick={() => void doForceReload()}>
          <span class="mbtn-icon">
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Reload from disk</span>
          <span class="mbtn-chord"></span>
        </button>
        <div class="msep" role="separator"></div>
        <button class="mbtn" onclick={doCloseTab}>
          <span class="mbtn-icon">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span class="mbtn-label">Close</span>
          <span class="mbtn-chord">{closeTabMenuChordLabel()}</span>
        </button>
      </div>
      {/if}
    </div>
  {/if}

  {#if tab.fileMissing}
    <div class="editor-toolbar missing-toolbar">
      <span>File moved or deleted</span>
    </div>
  {:else if tab.loading}
    <div class="editor-toolbar loading-toolbar">
      <span>{loadingText}</span>
      <button type="button" onclick={doReload}>Reload</button>
    </div>
  {:else if tab.error}
    <div class="editor-toolbar">
      <span class="error">{tab.error}</span>
    </div>
  {/if}
  {#if tab.fileMissing}
    <div class="missing-file-state">
      <div class="missing-title">File moved or deleted</div>
      <div class="missing-path">{tab.fileMissing.path}</div>
      {#if tab.fileMissing.suggestedPath}
        <div class="missing-suggest">
          Looks like it moved to
          <code>{tab.fileMissing.suggestedPath}</code>
        </div>
      {/if}
      <div class="missing-actions">
        {#if tab.fileMissing.suggestedPath}
          <button
            type="button"
            class="suggest-reopen"
            onclick={doReopenAtSuggested}
          >
            <Folder size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>Re-open there</span>
          </button>
        {/if}
        <button type="button" onclick={doReopenMissing}>
          <Folder size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Re-open</span>
        </button>
        <button type="button" onclick={doFindMissing}>
          <SearchIcon size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Find</span>
        </button>
        <button type="button" onclick={doCloseTab}>
          <X size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>Close</span>
        </button>
      </div>
    </div>
  {:else if tab.error}
    <div class="placeholder error-placeholder">{tab.error}</div>
  {:else}
    <div class="editor-inspector-row">
    {#if tab.outlineOpen}
      <Inspector
        title="Outline"
        side="left"
        bind:width={
          () => tab.outlineWidth ?? paneWidths.outline,
          (v) => (tab.outlineWidth = v)
        }
        onResize={persistPaneWidths}
        onClose={() => setTabOutlineOpen(tab, false)}
      >
        <OutlineBody
          content={tab.content}
          {caretLine}
          onSelect={jumpTo}
          onPreview={previewSlides}
          onPlay={playSlides}
          previewChord={slidePreviewChord}
          playChord={slidePresentChord}
        />
      </Inspector>
    {/if}
    {#if tab.mode === "wysiwyg"}
      <!-- Wysiwyg + floating style toolbar share a positioned
           host so the toolbar can pin to the top-left of the
           editor canvas. Without `position: relative` here the
           absolute toolbar would escape to the next ancestor
           (the pane) and end up over the tab strip. The find
           bar shares the same host so it can pin to the
           top-right of the same canvas. -->
      <div
        class="editor-host"
        style:--editor-top-pad={tab.styleToolbarOpen ? "2.5rem" : "0.5rem"}
        oncontextmenu={onEditorContext}
        onkeydowncapture={onSlideShortcutKeydown}
        role="presentation"
      >
        <Wysiwyg
          bind:this={wysiwygRef}
          bind:value={tab.content}
          autoFocus={focused}
          readonly={readOnly}
          extraExtensions={docExtensions}
          highlightTrailingWhitespace={tab.highlightTrailingWhitespace}
          initialCaret={tab.caret ?? null}
          onCaretChange={(from, to) => setTabCaret(tab, from, to)}
          onSelectionChange={() => (selVer = selVer + 1)}
          wikiPickerPrefix={tab.repoRoot}
          currentPath={tab.path}
          onWikiClick={(args) => {
            // Navigation: click on a wikilink pill opens the
            // target in the active pane. `args.target` is the raw
            // link target (a `[[note]]` stem carries no extension),
            // so resolve it through the same `.md`/`.txt`/bare probe
            // the pill used before opening -- otherwise an
            // extension-less stem 404s and flashes a false
            // "document not found" for a file that's on disk.
            void openLinkTarget(args.target);
          }}
          onTagClick={(name) => openGraphForTag(`#${name}`, name)}
          onMentionClick={(args) => {
            // Mention widget resolved the contact via api.contacts
            // and (in read-only contexts) already opened the preview
            // popover. We get here on commit (Cmd/Ctrl+Enter from
            // the popover) or on a writable plain click. A resolved
            // contact opens its file; a standalone `@@name` with no
            // contact file routes to the mention lens (focused graph
            // around the `@@Name` meta-node), mirroring how a tag
            // pill opens the tag lens.
            if (args.path) void openInActivePane(args.path);
            else openGraphForMention(`@@${args.name}`, args.name);
          }}
        />
        {#if tab.styleToolbarOpen}
          <!-- Parity with the team-work toolbar: separator +
               rendered/source toggle next to the formatting
               buttons. `mode` + `onModeToggle` pass through to the
               shared StyleToolbar component (the toggle is gated on
               these props being defined). The toggle calls
               `doToggleMode()` which swaps between source and the
               tab's rendered mode (wysiwyg / pretty / table). -->
          <StyleToolbar
            wysiwyg={wysiwygRef}
            selVer={selVer}
            disabled={readOnly}
            mode="wysiwyg"
            onModeToggle={hasRenderedMode ? () => doToggleMode() : undefined}
          />
        {/if}
        {#if tab.find?.open}
          <FindBar
            find={tab.find}
            adapter={findAdapter}
            docText={tab.content}
            tabId={tab.id}
          />
        {/if}
      </div>
    {:else if tab.mode === "pretty"}
      <!-- Pretty / structured renderer (JSON tree today). The
           buffer stays authoritative; we don't mount FindBar
           here because the renderer is read-only -- edits happen
           in source mode. -->
      <div
        class="editor-host"
        oncontextmenu={onEditorContext}
        role="presentation"
      >
        <JsonPretty value={tab.content} />
      </div>
    {:else if tab.mode === "table"}
      <!-- Tabular renderer (CSV / TSV). Cell commits flow back
           through the bound value prop; the autosave debouncer
           picks them up like any other text edit. -->
      <div
        class="editor-host"
        oncontextmenu={onEditorContext}
        role="presentation"
      >
        <CsvTable
          bind:value={tab.content}
          delimiter={csvDelimiter(tab.path)}
          readonly={readOnly}
        />
      </div>
    {:else if tab.mode === "canvas"}
      <!-- Interactive Excalidraw board. The React island lazy-loads on
           first activation and stays mounted; no oncontextmenu so the
           board keeps its own right-click menu. onSceneChange writes the
           serialized scene into the buffer, which autosave persists like
           any other edit. -->
      <div class="editor-host" role="presentation">
        {#if ExcalidrawCanvas}
          <ExcalidrawCanvas
            bind:this={canvasRef}
            {active}
            content={tab.content}
            dark={effectiveHybridSurfaceTheme("editor") === "dark"}
            onSceneChange={(json) => (tab.content = json)}
            session={sceneSession}
          />
        {/if}
      </div>
    {:else}
      <!-- Source mode gets its own positioned host so FindBar
           can pin to the same top-right spot it occupies in the
           Wysiwyg view. -->
      <div
        class="editor-host"
        oncontextmenu={onEditorContext}
        onkeydowncapture={onSlideShortcutKeydown}
        role="presentation"
      >
        <Source
          bind:this={sourceRef}
          bind:value={tab.content}
          autoFocus={focused}
          path={tab.path}
          readonly={readOnly}
          extraExtensions={docExtensions}
          syntaxHighlight={tab.syntaxHighlight}
          highlightTrailingWhitespace={tab.highlightTrailingWhitespace}
          initialCaret={tab.caret ?? null}
          onCaretChange={(from, to) => setTabCaret(tab, from, to)}
        />
        {#if tab.styleToolbarOpen && hasRenderedMode}
          <!-- Also mount the StyleToolbar in source mode so the
               rendered/source toggle stays reachable from inside
               source mode. `disabled` is on (the formatting row
               collapses) but the toggle sits OUTSIDE the formatting
               row (see the StyleToolbar's own design comment around
               its `.fbtn-row`) and stays clickable. Only mount for
               tabs with a rendered mode (markdown / JSON / CSV);
               plain `.py` / `.toml` source has no rendered
               counterpart, so there's no useful toggle
               direction. -->
          <StyleToolbar
            wysiwyg={undefined}
            selVer={selVer}
            disabled={true}
            mode="source"
            onModeToggle={() => doToggleMode()}
          />
        {/if}
        {#if tab.find?.open}
          <FindBar
            find={tab.find}
            adapter={findAdapter}
            docText={tab.content}
            tabId={tab.id}
          />
        {/if}
      </div>
    {/if}
    {#if tab.inspectorOpen}
      <Inspector
        title="Details"
        bind:width={
          () => tab.inspectorWidth ?? paneWidths.inspector,
          (v) => (tab.inspectorWidth = v)
        }
        onResize={persistPaneWidths}
        onClose={() => setTabInspectorOpen(tab, false)}
      >
        <FileInfoBody
          path={tab.path}
          showRefs
          onNavigate={(p) => void openInActivePane(p)}
          onReveal={revealInBrowser}
          onSetAsScope={() => openFsGraphForFile(tab.path)}
        />
      </Inspector>
    {/if}
    </div>
    {#if tab.mode === "wysiwyg"}
      <WikiStatusBar
        path={tab.path}
        content={tab.content}
        fsWritable={tab.fsWritable}
        bind:readMode={tab.readMode}
      />
    {/if}
  {/if}
</div>


<style>
  /* Keep-alive contract, copied from .terminal-tab: every file tab in
     the pane stays mounted; inactive ones hide via visibility (NEVER
     display:none) so CM6 keeps real layout geometry while hidden and
     a re-shown editor never recomputes decorations from a pre-layout
     viewport (the WKWebView raw-markdown flash). pointer-events: none
     keeps hidden editors out of hit-testing (clicks, OS-file drop
     targets). No `flex: 1` any more: the host is absolutely positioned
     in the pane's .face.front now, not a flex child. */
  .editor-tab {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    visibility: hidden;
    pointer-events: none;
  }
  .editor-tab.active {
    visibility: visible;
    pointer-events: auto;
  }
  /* Hang-recovery banner. Sits at the very top of the editor-tab
     body, above the menu bubble + the editor host. Uses the
     `--warn-text` palette so it reads as an attention-needed
     affordance without competing with the editor's content area
     below. Stays compact (single row) so it doesn't push the
     document down dramatically. */
  .recovery-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: color-mix(in srgb, var(--warn-text) 12%, var(--bg));
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-size: 0.875rem;
  }
  .recovery-banner-text {
    flex: 1;
    min-width: 0;
  }
  .recovery-banner-btn {
    padding: 0.25rem 0.75rem;
    background: var(--btn-bg);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    color: var(--text);
    font-size: 0.875rem;
    cursor: pointer;
  }
  .recovery-banner-btn:hover {
    border-color: var(--btn-hover);
  }
  .recovery-banner-restore {
    background: var(--warn-text);
    color: var(--bg);
    border-color: var(--warn-text);
  }
  .recovery-banner-restore:hover {
    opacity: 0.9;
    border-color: var(--warn-text);
  }
  /* Tab menu bubble. Fixed-position so it anchors to the trigger
     button regardless of which pane the user clicked in; the
     translateX clamp keeps it on-screen for tabs that sit near the
     right edge. Width matches the longest action label plus the
     icon column so the buttons read as a tidy list.

     Bouncy reveal: the bubble enters via a `bubble-pop` keyframe
     using the same easeOutBack curve as the BottomPill (small
     overshoot on the way in so the menu reads as alive rather than
     mechanical). Hover gives a tiny scale-up for the same reason. */
  .tab-menu-bubble {
    position: fixed;
    z-index: 25500;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    padding: 6px;
    min-width: 220px;
    max-width: calc(100vw - 16px);
    /* Pull back if the anchor pushes us past the viewport. */
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    color: var(--text);
    font-size: 13px;
    /* Anchor the bouncy reveal to the top-left of the bubble so the
       overshoot grows away from the trigger button rather than from
       the center of the popover (which would visually drift it
       sideways during the bounce). */
    transform-origin: top left;
    animation: bubble-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .tab-menu-bubble:hover {
    transform: scale(1.015);
  }
  @keyframes bubble-pop {
    0% {
      opacity: 0;
      transform: scale(0.92);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
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
  .page-width-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
  }
  .page-width-label {
    color: var(--text-secondary);
    font-size: 12px;
    min-width: 64px;
  }
  .page-width-slider {
    flex: 1;
    accent-color: var(--btn-hover);
  }
  .page-width-value {
    min-width: 40px;
    text-align: right;
    color: var(--text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .action-list {
    display: flex;
    flex-direction: column;
    padding-top: 4px;
  }
  .mbtn {
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
  .mbtn:hover {
    background: var(--hover-bg);
    transform: scale(1.02);
  }
  @media (prefers-reduced-motion: reduce) {
    .mbtn {
      transition: background 80ms ease, color 80ms ease;
    }
    .mbtn:hover {
      transform: none;
    }
  }
  .mbtn-icon {
    width: 18px;
    text-align: center;
    color: var(--text);
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .mbtn-label { flex: 1; }
  /* Chord column on the right edge. Matches the tab-menu family so
     editor, terminal, and graph bubbles read consistently. Empty cells
     still occupy the slot so the column stays aligned even on
     rows that don't have a registered shortcut. */
  .mbtn-chord {
    margin-left: 1.5rem;
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
  }
  /* Group separator inside the action list. Same shape as the other
     tab menus so the overlay menus and file tab menu read alike. */
  .msep {
    height: 1px;
    background: var(--separator, var(--border));
    margin: 4px 2px;
  }

  /* One-off error surfacing for the active tab. Save is implicit
     via Cmd/Ctrl+S handled at the pane level. */
  .editor-toolbar {
    padding: 0.25rem 0.5rem;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
    font-size: 14px;
    color: #d33;
  }
  .missing-toolbar {
    color: var(--text-primary);
    font-weight: 600;
  }
  .loading-toolbar {
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .loading-toolbar button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.2rem 0.6rem;
    font: inherit;
    cursor: pointer;
  }
  /* Menu-top inline rename input. */
  .name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0 6px;
  }
  .name-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }
  .name-input {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    padding: 3px 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .name-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-style: italic;
  }
  .error-placeholder {
    color: var(--danger-text, #d33);
    padding: 1rem;
    text-align: center;
  }
  .missing-file-state {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 1.25rem;
    text-align: center;
    color: var(--text-secondary);
  }
  .missing-title {
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 650;
  }
  .missing-path {
    max-width: min(42rem, 90%);
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .missing-suggest {
    max-width: min(42rem, 90%);
    overflow-wrap: anywhere;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .missing-suggest code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--text-primary);
  }
  .missing-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }
  .missing-actions button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    height: 2rem;
    padding: 0 0.7rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }
  .missing-actions button:hover {
    background: var(--bg-hover, var(--bg-card));
  }
  .missing-actions button.suggest-reopen {
    border-color: var(--link);
    background: var(--link);
    color: var(--bg-card);
  }
  .missing-actions button.suggest-reopen:hover {
    filter: brightness(1.08);
  }
  /* Row that holds the editor + (optional) inspector. The Inspector
     component renders a ResizeHandle as its previous sibling so
     this row sees handle + inspector as siblings at the same level. */
  .editor-inspector-row {
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  /* Wraps the WYSIWYG editor and its floating style toolbar so the
     toolbar can pin to the top-left of the editor canvas. position:
     relative establishes the toolbar's containing block; flex:1 +
     min-height:0 lets the editor inside take its full slot in the
     surrounding flex row. */
  .editor-host {
    position: relative;
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  /* `--editor-top-pad` is read by .md-wysiwyg (Wysiwyg.svelte) to
     set its padding-top. We bump it to 1.5rem while the style
     toolbar is enabled in the tab menu so the first line clears
     the floating toolbar pill (top: 8px, ~30px tall); when the
     toolbar is hidden we reclaim that space back to the 1rem
     baseline so the first line sits at the top of the doc. */
</style>
