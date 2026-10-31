<script lang="ts">
  // Recursive tree view of the workspace.
  //
  // Builds a nested directory structure from the flat tree the API returns,
  // then renders rows with expand/collapse, click-to-open, and a context
  // menu for create/rename/delete.

  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    Download,
    Eye,
    FilePlus,
    FileText,
    Folder,
    FolderOpen,
    Network,
    Pencil,
    Settings2,
    Terminal as TerminalIcon,
    Trash,
    Upload,
  } from "@lucide/svelte";
  import { tick, untrack } from "svelte";
  import { directoryEntries, type BrowserSort } from "../state/browserEntries";
  import { browserKeys } from "../state/browserKeys.svelte";
  import { browserKeyCommand, browserCommandChord, type BrowserCommand } from "../state/browserKeymap";
  import { api } from "../api/client";
  import DraftsGroup from "./DraftsGroup.svelte";
  import { clampMenu } from "./menuClamp";
  import { portal } from "./portal";
  import type { TreeEntry } from "../api/types";
  import { isEditableText } from "../state/fileTypes";
  import { defaultCreateDirectory } from "../state/fileContext.svelte";
  import { basename, parentDir, formatSize, formatMtime } from "../state/format";
  import { openMediaViewer } from "../state/mediaOpen";
  import { classifyFile, iconFor, isOpenableTextKind } from "../state/kinds";
  import { windowCaps } from "../state/windowCaps";
  import {
    classifyFileActions,
    fileMediaKind,
    type FileActionId,
  } from "../state/fileActions";
  import { exportPathToPdf } from "../state/fileActionExecutors";
  import {
    dirtyPaths,
    layout,
    openBrowserInActivePane,
    openInActivePane,
    openTerminalInPane,
  } from "../state/tabs.svelte";
  import { terminalFromHereTarget } from "../terminal/fromHere";
  import { chordFor } from "../state/shortcuts";
  import {
    browserSelection,
    fbActivateInstance,
    fbActiveInstanceId,
    clearTreeDirError,
    clearTreeLoadingForPath,
    copyTextToClipboard,
    draftsDir,
    isDraftPath,
    workspace,
    fbClearSelection as fbClearSelectionFor,
    fbClipboard,
    fbClipboardClear,
    fbClipboardPaste,
    fbClipboardSet,
    fbSelectRange as fbSelectRangeFor,
    fbSelectSet as fbSelectSetFor,
    fbSelectSingle as fbSelectSingleFor,
    fbToggle as fbToggleFor,
    fileOps,
    loadTreeDir,
    openFsGraphForDirectory,
    openFsGraphForFile,
    ensureFbTreeInstance,
    fbTreeInstance,
    persistFbTreeInstanceExpansion,
    tree,
  } from "../state/store.svelte";
  import { notify } from "../state/notify.svelte";

  // Full filesystem path for a tree entry, for the row hover
  // tooltip. Falls back to the workspace-relative path when the
  // server hasn't surfaced a root (tunnel-public mode) so the title
  // is never empty.
  function fullPath(relPath: string): string {
    const root = workspace.info?.root?.replace(/\/+$/, "") ?? "";
    if (!root) return relPath;
    return `${root}/${relPath}`;
  }

  // `dockSide` is set by FileBrowserSidePane / FileBrowserSurface when
  // the tree renders inside a right-docked side pane. The right-dock
  // variant mirrors the row layout (icons + chevrons on the right
  // edge, text right-aligned, indent guide growing right-to-left) so
  // the tree anchors against whichever viewport edge it's pinned to.
  // Overlay and tab variants leave this undefined.
  let {
    instanceId,
    dockSide,
    onClickRow,
    onFlip,
    view = "tree",
    directory = "",
    filter = "",
    sort = "name",
    descending = false,
    showHidden = true,
    selectionMode = $bindable(false),
    onNavigate,
    onPreview,
    onFind,
    onCount,
  }: {
    /// Stable id of the owning File Browser surface (`fb-tab-<id>` /
    /// `fb-dock-<side>` / `fb-overlay`). Keys this tree's expand/collapse
    /// map in the per-instance `fbTreeInstances` registry so two visible
    /// surfaces don't share expansion state.
    instanceId: string;
    view?: "tree" | "list";
    directory?: string;
    filter?: string;
    sort?: BrowserSort;
    descending?: boolean;
    showHidden?: boolean;
    selectionMode?: boolean;
    onNavigate?: (path: string) => void;
    onPreview?: () => void;
    onFind?: () => void;
    onCount?: (count: number) => void;
    dockSide?: "left" | "right";
    /// Surface-owned hook fired when the user clicks a row. Lets the
    /// surface decide whether to auto-open the DETAILS inspector (tab
    /// + overlay variants do; dock variants don't). Keyboard
    /// navigation writes to `browserSelection` directly without
    /// firing this hook.
    onClickRow?: (path: string) => void;
    /// Surface-owned hook for the Settings (flip) entry in the
    /// in-tree selection menu. FBSurface passes this through from its
    /// own `onFlip` (which Pane.svelte wires to
    /// `flipHybrid(pane.id)`); dock + overlay variants don't pass it
    /// so the Settings entry hides for those variants.
    onFlip?: () => void;
  } = $props();
  const rightDock = $derived(dockSide === "right");
  const selection = $derived(fbTreeInstance(instanceId)?.selection ?? browserSelection);
  function fbSelectSingle(path: string | null): void { fbSelectSingleFor(path, selection); }
  function fbSelectSet(paths: string[], active?: string): void { fbSelectSetFor(paths, active, selection); }
  function fbSelectRange(path: string, order: string[]): void { fbSelectRangeFor(path, order, selection); }
  function fbClearSelection(): void { fbClearSelectionFor(selection); }
  function fbToggle(path: string): void { fbToggleFor(path, selection); }
  function activate(): void { fbActivateInstance(instanceId); }
  function rowId(path: string): string { return instanceId + "-entry-" + encodeURIComponent(path); }
  const entryByPath = $derived(new Map(tree.entries.map((entry) => [entry.path, entry])));
  let keyPrefix = "";
  let prefixAt = 0;
  let typeAhead = "";
  let typedAt = 0;


  // Mime type recognized by Pane.onDrop. Keep in sync with Pane.svelte.
  const FILE_DRAG_MIME = "application/x-md-file";
  // Mime type used for intra-tree moves. Separate from FILE_DRAG_MIME
  // so Pane.onDrop (open-in-pane) does not pick up directory drags, and
  // so tree drops only react to drags that originated in the tree.
  const TREE_MOVE_MIME = "application/x-chan-tree-move";

  // Per-file unsaved-buffer indicator. Color comes from --info-text
  // in the global palette (see App.svelte).
  const editorDirty = $derived(dirtyPaths());

  // Path of the row currently highlighted as a drop target during DnD.
  // Empty string means the root <ul> (drop at workspace root). null means
  // no row is being hovered.
  let dropTarget = $state<string | null>(null);

  function downloadFilename(path: string, isDir: boolean): string {
    const name = path.split("/").filter(Boolean).pop() || "download";
    const safe = name.replace(/[:\r\n]/g, "_");
    if (isDir && !safe.toLowerCase().endsWith(".tar")) return `${safe}.tar`;
    return safe;
  }

  // File Browser native drag IN and OUT is not supported: the
  // user exports via the Download button and imports via the Upload
  // button. So `onFileDragStart` does not write the `DownloadURL` /
  // `text/uri-list` browser drag-out payload, does not invoke a
  // desktop native drag-out Tauri command, and the row drop handlers
  // do not accept external OS files. Only the APP-INTERNAL drag is
  // supported: tree-move (relocate a node within the tree) and the
  // file-into-editor-pane open. Those never cross the OS boundary.
  function onFileDragStart(e: DragEvent, path: string, isDir: boolean): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    // Multi-drag: if the grabbed row is part of the current
    // multi-selection, drag the WHOLE selection; otherwise the drag
    // implicitly selects just this row (desktop behavior - grabbing an
    // unselected row drops the old selection).
    let dragPaths: string[];
    if (selection.paths.includes(path) && selection.paths.length > 1) {
      dragPaths = [...selection.paths];
    } else {
      fbSelectSingle(path);
      dragPaths = [path];
    }
    // Carry the full set; the single-entry {path,isDir} stays for the
    // editor-pane drop target (one file opens; a multi-drag into a pane
    // still resolves the primary file).
    const payload = JSON.stringify({ path, isDir, paths: dragPaths });
    e.dataTransfer.setData(TREE_MOVE_MIME, payload);
    if (!isDir) {
      // Files are also droppable into editor panes (open in tab).
      // Directories are not, so they only carry the tree-move mime.
      e.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify({ path }));
    }
    // A plain-text fallback (the path string, not a file export) is
    // friendly to internal drop targets and pasting the path into a
    // code editor. It does not trigger an OS file download.
    e.dataTransfer.setData("text/plain", path);
    // Drag image: when moving many, show the count so the user knows
    // the whole selection travels. Built off-screen and revoked next tick.
    if (dragPaths.length > 1) setMultiDragImage(e, dragPaths.length);
  }

  /// Build a small "N items" drag image so a multi-drag reads as the
  /// whole selection moving, not just the grabbed row.
  function setMultiDragImage(e: DragEvent, count: number): void {
    const ghost = document.createElement("div");
    ghost.textContent = `${count} items`;
    // Inline styles: the ghost lives on document.body, outside this
    // component's scoped CSS, so a scoped class would not apply.
    ghost.style.cssText = [
      "position:absolute",
      "top:-1000px",
      "left:-1000px",
      "padding:2px 8px",
      "font-size:13px",
      "border-radius:4px",
      "background:var(--accent, #3b82f6)",
      "color:#fff",
      "pointer-events:none",
    ].join(";");
    document.body.append(ghost);
    e.dataTransfer?.setDragImage(ghost, 10, 10);
    requestAnimationFrame(() => ghost.remove());
  }

  /// Resolve the move source(s) from a DragEvent. Returns null if the
  /// drag did not originate in the tree (e.g. external file drop). The
  /// `paths` array carries the full multi-selection; it falls back
  /// to the single `path` for a payload that carries no `paths`.
  function readTreeDrag(
    e: DragEvent,
  ): { path: string; isDir: boolean; paths: string[] } | null {
    const raw = e.dataTransfer?.getData(TREE_MOVE_MIME);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as {
        path: string;
        isDir: boolean;
        paths?: string[];
      };
      if (typeof v.path === "string") {
        const paths = Array.isArray(v.paths) && v.paths.length > 0 ? v.paths : [v.path];
        return { path: v.path, isDir: v.isDir, paths };
      }
    } catch {
      // fall through
    }
    return null;
  }

  function hasTreeMove(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes(TREE_MOVE_MIME);
  }

  /// True when dropping `src` into `destDir` is a no-op or invalid:
  /// same parent already, dropping a directory into itself or a
  /// descendant, or dropping at the same location.
  function isInvalidDrop(src: { path: string; isDir: boolean }, destDir: string): boolean {
    if (src.path === destDir) return true;
    if (src.isDir && (destDir === src.path || destDir.startsWith(`${src.path}/`))) {
      return true;
    }
    const srcParent = parentDir(src.path);
    return srcParent === destDir;
  }

  /// Compute the target path for dropping `src` into `destDir`.
  /// destDir == "" means the workspace root.
  function dropTargetPath(src: string, destDir: string): string {
    const base = basename(src);
    return destDir === "" ? base : `${destDir}/${base}`;
  }

  function onRowDragOver(e: DragEvent, destDir: string): void {
    // Only the app-internal tree-move is a valid drop; external OS
    // file drops (drag-IN) are not accepted (use the Upload
    // button). So we only opt in when the drag carries the tree-move
    // mime.
    if (!hasTreeMove(e)) return;
    e.preventDefault();
    // Stop the event from bubbling to the root <ul>'s ondragover,
    // which would otherwise overwrite our selection with the root.
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropTarget = destDir;
  }

  function onRowDragLeave(destDir: string): void {
    // Clear only if we're leaving the row we currently highlight, so
    // a child row's dragenter doesn't briefly unhighlight its parent.
    if (dropTarget === destDir) dropTarget = null;
  }

  async function onRowDrop(e: DragEvent, destDir: string): Promise<void> {
    dropTarget = null;
    // External OS file drops (drag-IN) are not accepted; only the
    // app-internal tree-move resolves. Importing files is the Upload
    // button's job.
    const src = readTreeDrag(e);
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    // Multi-drag: move every dragged entry that is a valid drop
    // into destDir. A directory cannot drop into itself or a descendant;
    // an entry already in destDir is a no-op the server skips. We map
    // each path to its isDir via the visible rows for the self/descendant
    // guard (the payload only carries the grabbed row's isDir bit).
    const candidates = src.paths.filter((p) => {
      const isDir = p === src.path ? src.isDir : isDirPath(p);
      return !isInvalidDrop({ path: p, isDir }, destDir);
    });
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      // Single move keeps the link-rewrite move path with its richer
      // outcome (fileOps.moveTo notifies on conflicts).
      const target = dropTargetPath(candidates[0], destDir);
      await fileOps.moveTo(candidates[0], target);
      return;
    }
    // Many: one atomic multi-entry move, through the same helper the clipboard
    // paste uses, so a drop onto an occupied name is refused by name the way a
    // single move is and the moved files' open tabs follow them.
    const landed = await fileOps.moveManyTo(candidates, destDir);
    if (landed.length > 0) fbSelectSet(landed);
  }

  /// Best-effort isDir lookup for a path from the visible rows (used by
  /// the multi-drop self/descendant guard). Unknown paths (not currently
  /// rendered) are treated as files, which is safe: the server still
  /// sandboxes and the self/descendant guard is the only consumer.
  function isDirPath(path: string): boolean {
    return visibleRows.find((r) => r.path === path)?.isDir ?? false;
  }

  type Folder = {
    kind: "dir";
    name: string;
    path: string;
    children: Node[];
  };
  type File = {
    kind: "file";
    fileKind?: TreeEntry["kind"];
    name: string;
    path: string;
    size: number;
    mtime: number | null;
  };
  type Node = Folder | File;

  // Per-instance expand/collapse map. Each File Browser surface owns its
  // own record in `fbTreeInstances` keyed by `instanceId`, so expanding a
  // directory in one surface does not fan out to every other visible
  // surface. The instance is CREATED in an effect (ensureFbTreeInstance
  // mutates $state, which is illegal inside a $derived - it throws
  // state_unsafe_mutation); the $derived only READS it (reactively
  // re-pointing once the effect registers the instance, and on remount
  // under a different id). The workspace root (`""`) is kept expanded.
  $effect(() => {
    ensureFbTreeInstance(instanceId);
    untrack(() => { if (!fbActiveInstanceId()) activate(); });
  });
  const expanded = $derived(fbTreeInstance(instanceId)?.expanded ?? { "": true });
  let menu = $state<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  let uploadInput = $state<HTMLInputElement | null>(null);
  let uploadTarget = $state<{ path: string; isDir: boolean } | null>(null);

  /// `<ul>` element handles keyboard navigation. Focused at mount
  /// so arrows / Enter are live as soon as the browser opens; the
  /// host overlay also re-focuses it on open via `focusTree`.
  let treeRootEl: HTMLUListElement | undefined = $state();

  /// Row -> DOM element map, populated via `bind:this` on each row.
  /// Used to scroll the active selection into view after keyboard
  /// movement so long lists don't lose the cursor off-screen.
  const rowEls = new Map<string, HTMLElement>();

  const root = $derived<Folder>(view === "tree" ? buildTree(tree.entries) : {
    kind: "dir", name: basename(directory), path: directory,
    children: directoryEntries(tree.entries, directory, filter, sort, descending, showHidden).map((entry): Node =>
      entry.is_dir
        ? { kind: "dir", name: basename(entry.path), path: entry.path, children: [] }
        : { kind: "file", name: basename(entry.path), path: entry.path, fileKind: entry.kind, size: entry.size, mtime: entry.mtime }),
  });

  /// Membership set for the multi-selection, O(1) per row. The whole
  /// set highlights as `.selected`; the active cursor (`browserSelection
  /// .path`) additionally gets `.active-cursor` so it reads as the
  /// keyboard/inspector focus within a multi-select.
  const selectedSet = $derived(new Set(selection.paths));

  /// Rows marked for a pending CUT render dimmed ("marked for move")
  /// until the paste lands or the clipboard is replaced. Copy is not
  /// dimmed (the source stays put). Empty when the clipboard is empty
  /// or holds a copy.
  const cutSet = $derived(
    fbClipboard.mode === "cut" ? new Set(fbClipboard.paths) : new Set<string>(),
  );

  /// Paths of contact-kind files (those with `chan.kind: contact`
  /// frontmatter). The server sets the discriminator on the listing
  /// payload; we lift it into a set so the row renderer doesn't have
  /// to walk the flat entries every time.
  const contactPaths = $derived<Set<string>>(
    new Set(
      tree.entries
        .filter((e) => !e.is_dir && e.kind === "contact")
        .map((e) => e.path),
    ),
  );

  /// Visible-row list in display order. Mirrors the walk in
  /// `rowIndexByPath` but keeps the per-node depth + isDir bits we
  /// need for keyboard navigation. Recomputed when the tree or the
  /// expansion set changes.
  type VisibleRow = { path: string; isDir: boolean; depth: number };
  const visibleRows = $derived.by(() => {
    const rows: VisibleRow[] = [];
    function walk(nodes: Node[], depth: number): void {
      for (const n of nodes) {
        rows.push({ path: n.path, isDir: n.kind === "dir", depth });
        if (view === "tree" && n.kind === "dir" && expanded[n.path]) walk(n.children, depth + 1);
      }
    }
    walk(root.children, 0);
    return rows;
  });

  /// Visible row index by path, in display order. Walked the same
  /// way the renderer walks (pre-order, recursing into directories that
  /// are currently expanded). Workspaces zebra striping: even rows get
  /// the default background, odd rows pick up `--zebra-bg`. The map
  /// rebuilds whenever the tree or the expansion set changes; for
  /// thousands of nodes this is still cheaper than the layout pass
  /// that follows.
  const rowIndexByPath = $derived.by(() => {
    const m = new Map<string, number>();
    let i = 0;
    function walk(nodes: Node[]): void {
      for (const n of nodes) {
        m.set(n.path, i++);
        if (view === "tree" && n.kind === "dir" && expanded[n.path]) walk(n.children);
      }
    }
    walk(root.children);
    return m;
  });

  $effect(() => {
    if (view === "list") return;
    const pending: string[] = [];
    function collect(nodes: Node[]): void {
      for (const n of nodes) {
        if (n.kind !== "dir" || !expanded[n.path]) continue;
        // A directory that FAILED is not retried here. This effect re-runs on
        // every `loadingDirs` write, and a failed load leaves the directory
        // neither loaded nor loading -- so without this the effect requeues it
        // the instant it fails, and an unreadable directory becomes a hot
        // retry loop that renders a permanent "Loading..." and hammers the
        // server. A macOS TCC directory (`Operation not permitted` even for
        // root) reaches this on any machine, and so does any directory the
        // server's uid cannot read.
        //
        // Retry stays available and explicit: collapsing clears the error, so
        // re-expanding tries again.
        if (
          !tree.loadedDirs[n.path] &&
          !tree.loadingDirs[n.path] &&
          !tree.dirErrors[n.path]
        ) {
          pending.push(n.path);
        }
        collect(n.children);
      }
    }
    collect(root.children);
    // loadTreeDir records the failure in tree.dirErrors and rethrows. The row
    // below the directory renders that record, so the rejection has a reader
    // and does not need to reach the window as an unhandled one.
    for (const path of pending) void loadTreeDir(path).catch(() => {});
  });

  function buildTree(entries: TreeEntry[]): Folder {
    const root: Folder = { kind: "dir", name: "", path: "", children: [] };
    const dirs = new Map<string, Folder>([["", root]]);
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      const parts = e.path.split("/");
      const name = parts.pop()!;
      const parentPath = parts.join("/");
      let parent = dirs.get(parentPath);
      if (!parent) {
        parent = ensureDir(root, dirs, parentPath);
      }
      if (e.is_dir) {
        if (dirs.has(e.path)) continue;
        const dir: Folder = { kind: "dir", name, path: e.path, children: [] };
        parent.children.push(dir);
        dirs.set(e.path, dir);
      } else {
        parent.children.push({
          kind: "file",
          fileKind: e.kind,
          name,
          path: e.path,
          size: e.size,
          mtime: e.mtime,
        });
      }
    }
    sortRecursive(root);
    return root;
  }

  function ensureDir(
    root: Folder,
    dirs: Map<string, Folder>,
    path: string,
  ): Folder {
    if (dirs.has(path)) return dirs.get(path)!;
    const parts = path.split("/");
    let cur = root;
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      let next = dirs.get(acc);
      if (!next) {
        next = { kind: "dir", name: p, path: acc, children: [] };
        cur.children.push(next);
        dirs.set(acc, next);
      }
      cur = next;
    }
    return cur;
  }

  function sortRecursive(f: Folder): void {
    f.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of f.children) if (c.kind === "dir") sortRecursive(c);
  }

  function toggle(path: string): void {
    setExpanded(path, !expanded[path]);
  }

  function setExpanded(path: string, value: boolean): void {
    expanded[path] = value;
    // Collapsing forgets a previous failure, so re-expanding is the retry
    // gesture for a directory that could not be listed. The load effect skips
    // errored directories to avoid a retry loop, so without this a transient
    // failure would stick for the life of the window.
    if (!value) clearTreeDirError(path);
    // Persist this surface's expansion (tab variant writes through to the
    // layout tab's `expanded` field for reload restore; dock/overlay is
    // session-scoped). FileBrowserSurface's per-instance effects mirror
    // the map into the tab record; this just workspaces the reload snapshot.
    persistFbTreeInstanceExpansion(instanceId);
    // Same reader as the load effect above: an expansion that cannot be listed
    // says so on the directory's own row.
    if (value) void loadTreeDir(path).catch(() => {});
  }

  function onOpen(path: string): void {
    // Explicit user open (double-click / Open button): land at document top,
    // overriding any persisted caret.
    void openInActivePane(path, { landAtTop: true });
  }

  /// The double-click / Enter funnel for file rows. Media (image, svg,
  /// video, PDF) opens its viewer overlay - the same routing the
  /// inspector's main action uses; everything else attempts the editor
  /// open, which peeks the content and refuses a binary file.
  function openFileRow(path: string): void {
    if (openMediaViewer(path)) return;
    void onOpen(path);
  }

  /// Single-click selects an entry; the file browser's inspector
  /// then renders its details. Files do not open on click;
  /// double-click (or the Open button in the panel) is the path
  /// to actually opening a file.
  ///
  /// A click also forces the inspector open: the user expects the
  /// metadata pane to surface the selection. If they explicitly
  /// closed the inspector earlier and then click another row, the
  /// click takes precedence (and reopens it on next reload via the
  /// URL hash). The inspector-open call sits behind `onClickRow` so
  /// the surface can gate it per variant (tab + overlay auto-open;
  /// dock doesn't).
  function selectPath(path: string, ev?: MouseEvent): void {
    activate();
    ev?.stopPropagation();
    treeRootEl?.focus({ preventScroll: true });
    // Desktop-file-browser click semantics:
    //   - cmd/ctrl+click toggles one entry in the set.
    //   - shift+click extends the range from the anchor over the
    //     visible rows (display order).
    //   - plain click = single select (resets set + anchor).
    // `path` always becomes the active cursor the inspector + single-
    // target actions read off `selection.path`.
    if (ev?.metaKey || ev?.ctrlKey || selectionMode) {
      fbToggle(path);
    } else if (ev?.shiftKey) {
      fbSelectRange(path, visibleRows.map((r) => r.path));
    } else {
      fbSelectSingle(path);
    }
    onClickRow?.(path);
  }

  function showMenu(ev: MouseEvent, path: string, isDir: boolean): void {
    activate();
    ev.preventDefault();
    // Row right-click stays row-scoped (rename, delete, new under
    // here); only empty-area right-clicks reach the parent surface.
    ev.stopPropagation();
    menu = { x: ev.clientX, y: ev.clientY, path, isDir };
  }

  /// Per-type menu rows from the shared classifier
  /// (state/fileActions): the same applicability policy the inspector
  /// pill/dropdown consumes, so a video right-clicked in the tree
  /// offers the same View / Download actions its inspector would.
  /// Every handler is tree-local and variant-independent. Copy Path /
  /// Rename / Delete are NOT part of this model (the tree's separate
  /// destructive and path-mutation policy below).
  type IconComponent = typeof Upload;
  type MenuActionRow = {
    id: FileActionId;
    label: string;
    icon: IconComponent;
    chord?: string;
    onClick: () => void;
  };

  function menuRowFor(id: FileActionId, path: string, isDir: boolean): MenuActionRow {
    switch (id) {
      case "open":
        return {
          id,
          label: isDir ? "Open in File Browser" : "Open",
          icon: isDir ? FolderOpen : FileText,
          onClick: () => {
            menu = null;
            if (isDir) openSelectionInFileBrowser(path);
            else openFileRow(path);
          },
        };
      case "showFile":
        return {
          id,
          label: "Open in File Browser",
          icon: FolderOpen,
          onClick: () => openSelectionInFileBrowser(path),
        };
      case "viewMedia": {
        const media = fileMediaKind(path);
        return {
          id,
          label:
            media === "image"
              ? "View / Zoom"
              : media === "video"
                ? "View Video"
                : media === "audio"
                  ? "View Audio"
                  : "View PDF",
          icon: Eye,
          onClick: () => {
            menu = null;
            void openMediaViewer(path);
          },
        };
      }
      case "download":
        return {
          id,
          label: "Download",
          icon: Download,
          onClick: () => downloadSelection(path, isDir),
        };
      case "upload":
        return {
          id,
          label: "Upload",
          icon: Upload,
          onClick: () => uploadSelection(path, isDir),
        };
      case "newTerminal":
        return {
          id,
          label: "New Terminal",
          icon: TerminalIcon,
          chord: chordFor("app.terminal.toggle") ?? "",
          onClick: () => terminalFromHere(path, isDir),
        };
      case "exportPdf":
        return {
          id,
          label: "Export to PDF",
          icon: FileText,
          onClick: () => {
            menu = null;
            void exportPathToPdf(path);
          },
        };
      case "graphFromHere":
        return {
          id,
          label: "New Graph",
          icon: Network,
          chord: chordFor("app.graph.toggle") ?? "",
          onClick: () => graphThis(path, isDir),
        };
    }
  }

  const menuActions = $derived.by<MenuActionRow[]>(() => {
    if (!menu) return [];
    // The server-projected kind (content-sniffed on per-directory
    // listings) decides editable-vs-binary, matching the inspector;
    // rows missing from the flat listing fall back to path
    // classification inside the classifier.
    const entryKind = tree.entries.find((e) => e.path === menu!.path)?.kind;
    const set = classifyFileActions(
      {
        path: menu.path,
        isDir: menu.isDir,
        serverKind: entryKind,
        isDraft: menu.path === draftsDir() || isDraftPath(menu.path),
      },
      // The graph is built from the workspace index, so a window with no
      // workspace behind it has nothing to graph FROM: the row would spawn a
      // tab that can never load.
      { open: true, reveal: true, graph: windowCaps.workspace, upload: true },
    );
    return [set.main, ...set.secondary].map((id) =>
      menuRowFor(id, menu!.path, menu!.isDir),
    );
  });

  /// Unified "New File or Directory" entry. Opens a single
  /// PathPromptModal with `kind: "either"`; trailing slash → dir,
  /// otherwise → file.
  async function newFileOrDir(parentPath: string): Promise<void> {
    menu = null;
    await fileOps.createFileOrDir(parentPath);
  }
  function expandedAncestors(path: string): string[] {
    const parts = path.split("/");
    const ancestors: string[] = [];
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (acc) ancestors.push(acc);
    }
    return ancestors;
  }
  function openSelectionInFileBrowser(path: string): void {
    const ancestors = expandedAncestors(path);
    const tab = openBrowserInActivePane({ select: path });
    tab.directory = tree.entries.find((entry) => entry.path === path)?.is_dir ? path : parentDir(path);
    tab.inspectorOpen = true;
    tab.showWorkspace = false;
    // The new tab's surface seeds its own per-instance expansion from
    // `tab.expanded` on mount, so there is no global singleton to prime
    // here.
    tab.expanded = ancestors.length > 0 ? ancestors : undefined;
    menu = null;
  }
  /// Flip routes through the surface-supplied `onFlip`
  /// callback (FBSurface → Pane.svelte → `flipHybrid(pane.id)`).
  /// Gated on `onFlip` existence so dock + overlay variants don't
  /// surface the entry.
  function flipFromMenu(): void {
    menu = null;
    onFlip?.();
  }

  async function rename(path: string, isDir: boolean): Promise<void> {
    await fileOps.rename(path, isDir);
    menu = null;
  }
  async function copyPath(path: string): Promise<void> {
    try {
      await copyTextToClipboard(path, {
        onSuccess: () => notify("Copied path"),
        onError: (message) => notify(`copy failed: ${message}`),
      });
    } finally {
      clearTreeLoadingForPath(path);
    }
    menu = null;
  }
  function downloadSelection(path: string, isDir: boolean): void {
    const link = document.createElement("a");
    link.href = api.downloadUrl(path);
    link.download = downloadFilename(path, isDir);
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    menu = null;
  }
  function uploadSelection(path: string, isDir: boolean): void {
    uploadTarget = { path, isDir };
    uploadInput?.click();
    menu = null;
  }
  async function onUploadPicked(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const target = uploadTarget;
    uploadTarget = null;
    try {
      if (!target || !input.files || input.files.length === 0) return;
      if (target.isDir) {
        await fileOps.uploadFilesTo(target.path, input.files);
      } else {
        await fileOps.replaceFileAt(target.path, input.files[0]!);
      }
    } finally {
      input.value = "";
    }
  }
  /// Delete from the key or the row menu. A row inside a multi-selection
  /// deletes the whole selection, the way a drag of it moves the whole
  /// selection; any other row is deleted alone.
  async function remove(path: string, isDir: boolean): Promise<void> {
    if (selection.paths.length > 1 && selection.paths.includes(path)) {
      await fileOps.removeSelection(selection.paths);
    } else {
      await fileOps.remove(path, isDir);
    }
    menu = null;
  }

  function graphThis(path: string, isDir: boolean): void {
    menu = null;
    if (isDir) openFsGraphForDirectory(path);
    else openFsGraphForFile(path);
  }

  function terminalFromHere(path: string, isDir: boolean): void {
    const target = terminalFromHereTarget(path, isDir);
    openTerminalInPane(layout.activePaneId, target);
    menu = null;
  }

  function queueScrollIntoView(path: string): void {
    // After Svelte re-renders the row (selection class swap), pull
    // it into view. requestAnimationFrame defers past the current
    // microtask so the DOM has the latest layout.
    requestAnimationFrame(() => {
      const el = rowEls.get(path);
      if (el) el.scrollIntoView({ block: "nearest" });
    });
  }

  /// Auto-scroll when the selection changes from outside (e.g.
  /// store.revealAndSelect after a successful directory create).
  /// Keyboard nav already calls queueScrollIntoView directly, so
  /// re-scrolling here is benign - the second rAF resolves on the
  /// same frame without flicker. Wait one more rAF than usual to
  /// give Svelte a chance to expand any newly-uncollapsed ancestor
  /// directories so the row's DOM element exists.
  $effect(() => {
    const path = selection.path;
    if (!path) return;
    requestAnimationFrame(() => {
      const el = rowEls.get(path);
      if (el) el.scrollIntoView({ block: "nearest" });
    });
  });

  /// Walk to the parent directory of `path`. Returns "" for top-level
  /// rows; the caller decides whether to act on root selection.
  function findFirstChildOf(path: string): string | null {
    const rows = visibleRows;
    const idx = rows.findIndex((r) => r.path === path);
    if (idx === -1 || idx + 1 >= rows.length) return null;
    const parent = rows[idx];
    const next = rows[idx + 1];
    return next.depth > parent.depth ? next.path : null;
  }

  function moveCursor(index: number, extend = false, focusOnly = false): void {
    const order = visibleRows.map((row) => row.path);
    const path = order[Math.max(0, Math.min(order.length - 1, index))];
    if (!path) return;
    if (extend) fbSelectRange(path, order);
    else if (focusOnly || selectionMode) selection.path = path;
    else fbSelectSingle(path);
    queueScrollIntoView(path);
  }

  export function runCommand(command: BrowserCommand, shift = false, focusOnly = false): void {
    activate();
    const rows = visibleRows;
    const index = rows.findIndex((row) => row.path === selection.path);
    const row = rows[index];
    const selected = menu ? { path: menu.path, isDir: menu.isDir } : row;
    const page = Math.max(1, Math.floor((treeRootEl?.parentElement?.clientHeight ?? 300) / 30) - 1);
    if (command === "previous") return moveCursor(index < 0 ? rows.length - 1 : index - 1, shift, focusOnly);
    if (command === "next") return moveCursor(index + 1, shift, focusOnly);
    if (command === "first") return moveCursor(0, shift, focusOnly);
    if (command === "last") return moveCursor(rows.length - 1, shift, focusOnly);
    if (command === "pagePrevious") return moveCursor(index - page, shift, focusOnly);
    if (command === "pageNext") return moveCursor(index + page, shift, focusOnly);
    switch (command) {
      case "parent":
        if (view === "list") onNavigate?.(parentDir(directory));
        else if (row?.isDir && expanded[row.path]) setExpanded(row.path, false);
        else if (row && parentDir(row.path)) { fbSelectSingle(parentDir(row.path)); queueScrollIntoView(parentDir(row.path)); }
        break;
      case "child":
        if (!row) moveCursor(0);
        else if (row.isDir) {
          if (view === "list") onNavigate?.(row.path);
          else if (!expanded[row.path]) setExpanded(row.path, true);
          else { const child = findFirstChildOf(row.path); if (child) { fbSelectSingle(child); queueScrollIntoView(child); } }
        }
        break;
      case "open":
        if (selected?.isDir) {
          if (view === "list") onNavigate?.(selected.path);
          else toggle(selected.path);
        } else if (selected) openFileRow(selected.path);
        break;
      case "rename": if (selected) void rename(selected.path, selected.isDir); break;
      case "delete": if (selected) void remove(selected.path, selected.isDir); break;
      case "copy": case "cut": {
        const paths = menu && !selection.paths.includes(menu.path) ? [menu.path]
          : selection.paths.length ? [...selection.paths] : selected ? [selected.path] : [];
        fbClipboardSet(command, paths);
        break;
      }
      case "paste": void pasteIntoTarget(); break;
      case "selectAll": fbSelectSet(rows.map((row) => row.path), selection.path ?? undefined); break;
      case "selectMode": selectionMode = !selectionMode; break;
      case "toggle":
        if (row) { fbToggle(row.path); selection.path = row.path; selectionMode = true; }
        break;
      case "clear":
        keyPrefix = "";
        if (selectionMode) selectionMode = false;
        else if (fbClipboard.mode) fbClipboardClear();
        else { const cursor = selection.path; fbClearSelection(); selection.path = cursor; }
        break;
      case "new": void newFileOrDir(view === "list" ? directory : pasteTargetDir()); break;
      case "upload": uploadSelection(view === "list" ? directory : pasteTargetDir(), true); break;
      case "download": if (selected) downloadSelection(selected.path, selected.isDir); break;
      case "copyPath": if (selected) void copyPath(selected.path); break;
      case "terminal": terminalFromHere(selected?.path ?? directory, selected?.isDir ?? true); break;
      case "graph": if (selected) graphThis(selected.path, selected.isDir); break;
      case "preview": onPreview?.(); break;
      case "filter": onFind?.(); break;
      case "menu": {
        if (!row) break;
        const rect = rowEls.get(row.path)?.getBoundingClientRect();
        menu = { x: rect?.left ?? 0, y: rect?.bottom ?? 0, path: row.path, isDir: row.isDir };
        return;
      }
    }
    if (command !== "menu") menu = null;
  }

  function onTreeKeydown(e: KeyboardEvent): void {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]")) return;
    activate();
    const now = Date.now();
    if (now - prefixAt > 800) keyPrefix = "";
    const command = browserKeyCommand(e, browserKeys.vim, keyPrefix);
    if (command) {
      e.preventDefault();
      e.stopPropagation();
      keyPrefix = "";
      runCommand(command, e.shiftKey, e.ctrlKey && !e.metaKey);
      return;
    }
    if (browserKeys.vim && e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); keyPrefix = "g"; prefixAt = now; return;
    }
    keyPrefix = "";
    if (browserKeys.vim || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    typeAhead = now - typedAt > 700 ? e.key : typeAhead + e.key;
    typedAt = now;
    const query = (/^(.)\1*$/u.test(typeAhead) ? typeAhead[0] : typeAhead).toLocaleLowerCase();
    const start = visibleRows.findIndex((row) => row.path === selection.path);
    const order = [...visibleRows.slice(start + 1), ...visibleRows.slice(0, start + 1)];
    const found = order.find((row) => basename(row.path).toLocaleLowerCase().startsWith(query));
    if (found) { e.preventDefault(); e.stopPropagation(); fbSelectSingle(found.path); queueScrollIntoView(found.path); }
  }

  function focusMenu(element: HTMLElement): { destroy(): void } {
    void tick().then(() => element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return { destroy() {
      const owned = element.contains(document.activeElement);
      if (owned) void tick().then(() => {
        if (document.activeElement === document.body) focusTree();
      });
    } };
  }

  function menuKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    const menuEl = e.currentTarget as HTMLElement;
    const buttons = [...menuEl.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); menu = null; focusTree(); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
        : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  $effect(() => { onCount?.(visibleRows.length); });
  let previousRows: string[] = [];
  $effect(() => {
    if (view === "list" && !tree.loadedDirs[directory] && !tree.rootUnavailable) return;
    const order = visibleRows.map((row) => row.path);
    untrack(() => {
      const cursor = selection.path;
      if (cursor && previousRows.includes(cursor) && !order.includes(cursor)) {
        const parent = parentDir(cursor);
        selection.path = order.includes(parent) ? parent : order[Math.min(previousRows.indexOf(cursor), order.length - 1)] ?? null;
      }
      selection.paths = selection.paths.filter((path) => !previousRows.includes(path) || order.includes(path));
      previousRows = order;
    });
  });

  /// Resolve the directory a paste should land in: the active selection
  /// if it is a directory; otherwise the parent directory of the active
  /// selection; otherwise the workspace root. Mirrors how a desktop file
  /// browser pastes "into the current folder".
  function pasteTargetDir(): string {
    if (view === "list") return directory;
    const cur = selection.path;
    if (!cur) return "";
    const row = visibleRows.find((r) => r.path === cur);
    if (row?.isDir) return cur;
    return parentDir(cur);
  }

  /// Paste the clipboard into the resolved target dir, then select the
  /// landed entries so the user sees the result (and a cut's dimming
  /// clears as the clipboard empties).
  async function pasteIntoTarget(): Promise<void> {
    if (!fbClipboard.mode) return;
    const dest = pasteTargetDir();
    const landed = await fbClipboardPaste(dest);
    if (landed.length > 0) {
      // Make sure the destination dir is expanded so the new entries
      // are visible, then select them. Expansion is this surface's own
      // per-instance state.
      if (dest) {
        expanded[dest] = true;
        persistFbTreeInstanceExpansion(instanceId);
      }
      fbSelectSet(landed);
    }
  }

  /// Pull keyboard focus to the tree. Called by the browser overlay
  /// when it opens so arrows are live without an extra click.
  export function focusTree(): void {
    activate();
    treeRootEl?.focus();
  }

  // ---- find within visible/expanded entries ---------------------------------
  // Cmd+F in the File Browser overlay sets a query here; matches are
  // computed against the current `visibleRows` set, so only entries
  // already expanded into view are eligible. The current match is
  // moved into `browserSelection` so opening (Enter) and scrolling
  // reuse the existing selection plumbing.

  type FindCountCb = (total: number, current: number) => void;
  let findQueryState = $state<string>("");
  let findOnCount: FindCountCb | undefined;
  let findCurrentIndex = $state<number>(-1);
  /// Non-reactive cache of the query string the cursor was last
  /// seeded to. Lets the cursor-management effect distinguish a
  /// fresh query (reset to first match) from a same-query match set
  /// update (e.g. user expanded a sibling directory mid-search) where
  /// the cursor should stay where the user left it.
  let lastSeededQuery: string | null = null;

  const findMatchPaths = $derived.by<string[]>(() => {
    const q = findQueryState.trim().toLowerCase();
    if (!q) return [];
    const out: string[] = [];
    for (const r of visibleRows) {
      const name = basename(r.path);
      if (name.toLowerCase().includes(q)) out.push(r.path);
    }
    return out;
  });
  const findMatchSet = $derived<Set<string>>(new Set(findMatchPaths));

  /// Cursor management for find. Runs in two distinct branches:
  ///
  ///   1. Query just changed (or first match-set seen for a query):
  ///      reset cursor to the first match, scroll it into view, and
  ///      record the new query in `lastSeededQuery`. Empty query
  ///      drops the cursor to -1.
  ///   2. Same query, match set updated (directory expanded / collapsed
  ///      while find was open): clamp cursor into range, but DO NOT
  ///      reset to 0 - that would fight findStep, which moves the
  ///      cursor and triggers this effect via the findCurrentIndex
  ///      / findMatchPaths read below.
  ///
  /// Always republish the count via findOnCount so the host counter
  /// stays in sync regardless of which branch ran.
  $effect(() => {
    const q = findQueryState;
    const paths = findMatchPaths;
    const n = paths.length;
    if (q !== lastSeededQuery) {
      lastSeededQuery = q;
      if (n === 0) {
        findCurrentIndex = -1;
      } else {
        findCurrentIndex = 0;
        fbSelectSingle(paths[0]!);
        queueScrollIntoView(paths[0]!);
      }
      findOnCount?.(n, findCurrentIndex);
      return;
    }
    if (n === 0) {
      findCurrentIndex = -1;
    } else if (findCurrentIndex >= n) {
      findCurrentIndex = n - 1;
    } else if (findCurrentIndex < 0) {
      findCurrentIndex = 0;
    }
    findOnCount?.(n, findCurrentIndex);
  });

  /// Set the active find query. Empty string clears the highlight.
  /// `onCount` (optional) receives `(total, current0Based)` whenever
  /// the match set or cursor moves so the host can workspace a counter.
  export function setFindQuery(q: string, onCount?: FindCountCb): void {
    findOnCount = onCount;
    findQueryState = q;
  }

  /// Step to the next / previous match (wraps). No-op when there are
  /// no matches.
  export function findStep(direction: 1 | -1): void {
    const n = findMatchPaths.length;
    if (n === 0) return;
    const cur = findCurrentIndex < 0 ? 0 : findCurrentIndex;
    findCurrentIndex = (cur + direction + n) % n;
    const path = findMatchPaths[findCurrentIndex]!;
    fbSelectSingle(path);
    queueScrollIntoView(path);
    findOnCount?.(n, findCurrentIndex);
  }

  export function clearFind(): void {
    setFindQuery("");
  }

  /// True when this row's name matches the active find query. Used
  /// to paint the `.find-match` class on matching rows; the row at
  /// `findCurrentIndex` additionally gets `.find-match--current`.
  function rowMatchClass(path: string): string {
    if (!findMatchSet.has(path)) return "";
    const idx = findMatchPaths.indexOf(path);
    return idx === findCurrentIndex ? "find-match find-match--current" : "find-match";
  }

  /// Svelte action: register / unregister a row's DOM element in
  /// `rowEls` so `queueScrollIntoView` can find it without a global
  /// query. Cleans up on unmount.
  function trackRow(node: HTMLElement, path: string): { destroy(): void } {
    rowEls.set(path, node);
    return {
      destroy() {
        if (rowEls.get(path) === node) rowEls.delete(path);
      },
    };
  }

  // ---- rubber-band (click-drag) multi-select ---------------------------------
  // A mousedown on the tree's empty space (not on a row's interactive
  // name target) begins a selection rectangle. While dragging, every row
  // whose DOM rect intersects the band is selected (contiguous run in
  // display order). The band is rendered as an absolutely-positioned
  // overlay inside the scrolling `<ul>`, so its geometry is in the same
  // client-rect space as the rows. A drag below the threshold is treated
  // as a plain click on empty space (clears the selection).
  const RUBBER_BAND_THRESHOLD_PX = 4;
  let band = $state<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  let bandActive = false;
  let bandStartClientX = 0;
  let bandStartClientY = 0;
  let bandAdditive = false;
  let bandBaseSelection: string[] = [];

  function onTreeMouseDown(e: MouseEvent): void {
    // Left button only; ignore clicks that land on a row's interactive
    // controls (name button/span, dirty dot, expand chevron) - those own
    // their own select/toggle gesture, and expanding or collapsing a folder
    // leaves the selection as it is. So rows selected inside a folder that
    // is then collapsed stay selected and go with a Delete, cut, copy or drag
    // of the selection; the count on the Delete confirm is the cue. The
    // empty gutter and inter-row space start a band.
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest(".name, .row-icon, .dirty-dot, .empty, .twirl")) return;
    // Don't start a band from a modifier-less click that is really a row
    // background click; we still allow it (it becomes a clear on mouseup
    // if no drag happens).
    bandActive = true;
    bandStartClientX = e.clientX;
    bandStartClientY = e.clientY;
    // cmd/ctrl held: ADD the banded rows to the existing selection
    // (desktop additive rubber-band). Otherwise the band REPLACES it.
    bandAdditive = e.metaKey || e.ctrlKey;
    bandBaseSelection = bandAdditive ? [...selection.paths] : [];
    band = null;
    window.addEventListener("mousemove", onBandMove, true);
    window.addEventListener("mouseup", onBandUp, true);
  }

  function onBandMove(e: MouseEvent): void {
    if (!bandActive) return;
    const root = treeRootEl;
    if (!root) return;
    const dx = e.clientX - bandStartClientX;
    const dy = e.clientY - bandStartClientY;
    if (band === null && Math.hypot(dx, dy) < RUBBER_BAND_THRESHOLD_PX) {
      return; // below threshold: not yet a drag
    }
    e.preventDefault();
    const rootRect = root.getBoundingClientRect();
    // Band rectangle in the root's local (scrolled) coordinate space so
    // the overlay div lines up with the rows even when the list scrolls.
    const x0 = Math.min(bandStartClientX, e.clientX) - rootRect.left + root.scrollLeft;
    const y0 = Math.min(bandStartClientY, e.clientY) - rootRect.top + root.scrollTop;
    const x1 = Math.max(bandStartClientX, e.clientX) - rootRect.left + root.scrollLeft;
    const y1 = Math.max(bandStartClientY, e.clientY) - rootRect.top + root.scrollTop;
    band = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

    // Hit-test rows against the band in CLIENT coordinates (getBounding
    // ClientRect is already viewport-relative, same as the mouse).
    const bandTop = Math.min(bandStartClientY, e.clientY);
    const bandBottom = Math.max(bandStartClientY, e.clientY);
    const hits: string[] = [];
    for (const row of visibleRows) {
      const el = rowEls.get(row.path);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // Vertical intersection only: the tree is a single column, so a
      // band that overlaps a row's vertical extent selects it.
      if (r.bottom >= bandTop && r.top <= bandBottom) hits.push(row.path);
    }
    const union = bandAdditive
      ? [...new Set([...bandBaseSelection, ...hits])]
      : hits;
    if (union.length > 0) {
      fbSelectSet(union, hits[hits.length - 1] ?? union[union.length - 1]);
    } else if (!bandAdditive) {
      fbClearSelection();
    }
  }

  function detachBandListeners(): void {
    window.removeEventListener("mousemove", onBandMove, true);
    window.removeEventListener("mouseup", onBandUp, true);
  }

  $effect(() => detachBandListeners);

  function onBandUp(): void {
    const wasDrag = band !== null;
    bandActive = false;
    band = null;
    bandBaseSelection = [];
    detachBandListeners();
    // A click on empty space with no drag clears the selection (matches
    // a desktop file browser); an additive (cmd) click leaves it alone.
    if (!wasDrag && !bandAdditive) fbClearSelection();
  }

  /// Dismiss the context menu on any click outside it. Registered in
  /// the capture phase on `window` so we observe the click before
  /// `OverlayShell`'s bubble-phase `stopPropagation` swallows it
  /// (which would otherwise leave the menu stuck open for every
  /// click inside the file browser overlay).
  $effect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (!menu) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".ctx")) return;
      menu = null;
    };
    window.addEventListener("click", onDocClick, true);
    return () => window.removeEventListener("click", onDocClick, true);
  });
</script>

<!-- The workspace's drafts are no rows of the tree: they are listed above
     it, and only in a workspace window. -->
{#if view === "tree"}<DraftsGroup {rightDock} />{/if}
<!-- svelte-ignore a11y_no_noninteractive_tabindex (Both view roles are interactive composite widgets.) -->
<ul
  class="tree"
  class:directory-list={view === "list"}
  class:drop-root={dropTarget === (view === "list" ? directory : "")}
  class:right-dock={rightDock}
  class:banding={band !== null}
  role={view === "list" ? "listbox" : "tree"}
  aria-label={view === "list" ? "Directory contents" : "Files"}
  aria-multiselectable="true"
  aria-activedescendant={selection.path && rowIndexByPath.has(selection.path) ? rowId(selection.path) : undefined}
  onfocusin={activate}
  onfocusout={() => { keyPrefix = ""; typeAhead = ""; }}
  tabindex="0"
  bind:this={treeRootEl}
  onkeydown={onTreeKeydown}
  onmousedown={onTreeMouseDown}
  ondragover={(e) => onRowDragOver(e, view === "list" ? directory : "")}
  ondragleave={() => onRowDragLeave(view === "list" ? directory : "")}
  ondrop={(e) => onRowDrop(e, view === "list" ? directory : "")}
>
  {#if band !== null}
    <div
      class="rubber-band"
      aria-hidden="true"
      style={`left:${band.x}px; top:${band.y}px; width:${band.w}px; height:${band.h}px;`}
    ></div>
  {/if}
  {#each root.children as node (node.path)}
    {@render renderNode(node, 0)}
  {/each}
</ul>
  {#if root.children.length === 0 && (tree.loading || tree.loadingDirs[directory])}
    <div class="empty" role="status">
      <div class="empty-title">Loading files...</div>
    </div>
  {:else if root.children.length === 0 && tree.rootUnavailable}
    <div class="empty" role="status">
      <div class="empty-title">Workspace root unavailable</div>
      <div class="empty-detail">{tree.error}</div>
    </div>
  {:else if root.children.length === 0 && (tree.error || tree.dirErrors[directory])}
    <div class="empty" role="status">
      <div class="empty-title">File listing failed</div>
      <div class="empty-detail">{tree.dirErrors[directory] ?? tree.error}</div>
    </div>
  {:else if root.children.length === 0}
    <div class="empty" role="status">
      <div class="empty-title">{filter ? "No matching files" : "No files"}</div>
      <div class="empty-actions">
        <button onclick={() => fileOps.createFile(view === "list" ? directory : defaultCreateDirectory())}>Create new file</button>
        <button onclick={() => fileOps.createDir(view === "list" ? directory : defaultCreateDirectory())}>Create new directory</button>
      </div>
    </div>
  {/if}

{#snippet renderNode(node: Node, depth: number)}
  {@const rowIndex = rowIndexByPath.get(node.path) ?? 0}
  <li role="none">
    {#if node.kind === "dir"}
      <div
        class={`row dir ${rowMatchClass(node.path)}`}
        class:selected={selectedSet.has(node.path)}
        class:active-cursor={selection.path === node.path}
        class:cut={cutSet.has(node.path)}
        class:zebra={rowIndex % 2 === 1}
        class:drop-target={dropTarget === node.path}
        style={rightDock
          ? `padding-right: ${depth * 12}px`
          : `padding-left: ${depth * 12}px`}
        onclick={(e) => selectPath(node.path, e)}
        ondblclick={() => { if (view === "list") onNavigate?.(node.path); }}
        oncontextmenu={(e) => showMenu(e, node.path, true)}
        role={view === "list" ? "option" : "treeitem"}
        id={rowId(node.path)}
        aria-level={view === "tree" ? depth + 1 : undefined}
        tabindex="-1"
        aria-expanded={view === "tree" ? !!expanded[node.path] : undefined}
        aria-owns={view === "tree" && expanded[node.path] ? `${rowId(node.path)}-children` : undefined}
        aria-selected={selectedSet.has(node.path)}
        draggable="true"
        ondragstart={(e) => onFileDragStart(e, node.path, true)}
        ondragover={(e) => onRowDragOver(e, node.path)}
        ondragleave={() => onRowDragLeave(node.path)}
        ondrop={(e) => onRowDrop(e, node.path)}
        title={fullPath(node.path)}
        use:trackRow={node.path}
      >
        {#if view === "tree"}<button
          tabindex="-1"
          class="twirl"
          onclick={(e) => { e.stopPropagation(); activate(); toggle(node.path); treeRootEl?.focus({ preventScroll: true }); }}
          aria-label={expanded[node.path] ? "collapse" : "expand"}
        >
          {#if expanded[node.path]}
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          {:else if rightDock}
            <!-- When the tree sits in the right-docked side pane the
                 rows mirror (text right-aligned, icons + chevron on
                 the rightmost edge), so the collapsed chevron also
                 mirrors. Children "open inward" toward the editor
                 pane on the left, hence the left-facing glyph. The
                 expanded chevron stays ChevronDown (already symmetric
                 on the horizontal axis). -->
            <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
          {:else}
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
          {/if}
        </button>{/if}
        <!-- GitHub-style directory glyph (open chevron + directory mirror the
             dark file-tree styling from request.md). The icon swaps
             between open / closed so a glance over the column reads
             expand state without parsing chevrons. -->
        <span class="row-icon dir-icon" aria-hidden="true">
          {#if expanded[node.path]}
            <FolderOpen size={14} strokeWidth={1.75} />
          {:else}
            <Folder size={14} strokeWidth={1.75} />
          {/if}
        </span>
        <!-- Click on directory name: toggle expand AND select. Selecting
             keeps the side panel synced with what the user is
             investigating; toggling preserves the existing browse
             affordance. A modifier click (shift/cmd/ctrl) is a
             multi-SELECT gesture, not a browse gesture, so it must NOT
             also toggle expansion (that would surprise a range/toggle). -->
        <span
          class="name"
          onclick={(e) => {
            if (view === "tree" && !(e.shiftKey || e.metaKey || e.ctrlKey || selectionMode)) toggle(node.path);
            selectPath(node.path, e);
          }}
          onkeydown={() => {}}
          role="button"
          tabindex="-1"
        >{node.name}</span>
        {@render metadata(node)}
      </div>
      {#if view === "tree" && expanded[node.path]}
        <ul class="children" role="group" id={`${rowId(node.path)}-children`}>
          {#each node.children as child (child.path)}
            {@render renderNode(child, depth + 1)}
          {/each}
          {#if node.children.length === 0 && tree.loadingDirs[node.path]}
            <li
              class="empty child-empty"
              style={rightDock
                ? `padding-right: ${(depth + 1) * 12}px`
                : `padding-left: ${(depth + 1) * 12}px`}
            >
              Loading...
            </li>
          {:else if node.children.length === 0 && tree.dirErrors[node.path]}
            <li
              class="empty child-empty"
              style={rightDock
                ? `padding-right: ${(depth + 1) * 12}px`
                : `padding-left: ${(depth + 1) * 12}px`}
            >
              {tree.dirErrors[node.path]}
            </li>
          {/if}
        </ul>
      {/if}
    {:else}
      {@const editable = node.fileKind && node.fileKind !== "pending"
        ? isOpenableTextKind(node.fileKind)
        : isEditableText(node.path)}
      {@const contact = contactPaths.has(node.path)}
      {@const kind = classifyFile(node.path, contact ? "contact" : undefined)}
      {@const Icon = iconFor(kind)}
      <div
        class={`row file ${rowMatchClass(node.path)}`}
        class:selected={selectedSet.has(node.path)}
        class:active-cursor={selection.path === node.path}
        class:cut={cutSet.has(node.path)}
        class:non-editable={!editable}
        class:contact
        class:zebra={rowIndex % 2 === 1}
        style={rightDock
          ? `padding-right: ${depth * 12 + 16}px`
          : `padding-left: ${depth * 12 + 16}px`}
        onclick={(e) => selectPath(node.path, e)}
        ondblclick={() => openFileRow(node.path)}
        oncontextmenu={(e) => showMenu(e, node.path, false)}
        role={view === "list" ? "option" : "treeitem"}
        id={rowId(node.path)}
        aria-level={view === "tree" ? depth + 1 : undefined}
        tabindex="-1"
        aria-selected={selectedSet.has(node.path)}
        draggable="true"
        ondragstart={(e) => onFileDragStart(e, node.path, false)}
        ondragover={(e) => onRowDragOver(e, parentDir(node.path))}
        ondragleave={() => onRowDragLeave(parentDir(node.path))}
        ondrop={(e) => onRowDrop(e, parentDir(node.path))}
        title={fullPath(node.path) + (contact ? " (contact)" : editable ? "" : " (view-only)")}
        use:trackRow={node.path}
      >
        <!-- Per-kind glyph leading the row. Same icon set used by
             the editor tab strip and (in time) by the inspector
             headers, so a file reads with the same icon wherever it
             surfaces. Contact rows still tint the filename via
             .row.contact > .name; the icon adds redundancy + a
             scannable column at the row's left edge. -->
        <span class="row-icon" aria-hidden="true">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <!-- Single click selects (mirrors graph tab semantics);
             double click opens. Both stop propagation so the row's
             implicit focus / drag handlers don't double-fire. Media
             (image/svg/video/PDF) opens its fullscreen viewer; every
             other file attempts the editor open, which peeks the
             content and refuses a binary one. -->
        <button
          class="name"
          tabindex="-1"
          onclick={(e) => selectPath(node.path, e)}
          ondblclick={(e) => { e.stopPropagation(); openFileRow(node.path); }}
        >{node.name}</button>
        {@render metadata(node)}
        {#if editorDirty.has(node.path)}
          <span class="dirty-dot unsaved" title="unsaved changes" aria-label="unsaved">●</span>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

{#snippet metadata(node: Node)}
  {#if view === "list"}
    {@const entry = entryByPath.get(node.path)}
    <span class="entry-kind">{node.kind === "dir" ? "Folder" : entry?.kind ?? "File"}</span>
    <span class="entry-size">{node.kind === "dir" ? "" : formatSize(entry?.size ?? 0)}</span>
    <span class="entry-modified">{entry?.mtime ? formatMtime(entry.mtime) : ""}</span>
  {/if}
{/snippet}

{#if menu}
  <div class="ctx" role="menu" tabindex="-1" aria-label="File actions" onkeydown={menuKeydown} use:portal use:clampMenu={{ x: menu.x, y: menu.y }} use:focusMenu>
    <!-- In-tree selection menu. Section label first ("From
         selection"), the dir-only "New File or Directory" creation
         entry (file-vs-dir detected from the path's trailing slash),
         then the per-type action rows from the shared classifier
         (state/fileActions -- the same applicability policy the
         inspector consumes; handlers + labels are tree-local). For an
         ordinary non-draft file, a tree-only Upload row follows:
         single-file replacement through the picker
         (fileOps.replaceFileAt), the transfer counterpart of the
         classifier's directory upload. Drafts never get it; the
         fileOps contract refuses writes there. Copy Path / Rename /
         Delete follow as the tree's separate destructive +
         path-mutation policy (this is the only surface for those). A
         Flip entry renders at the foot when `onFlip` is wired (tab
         variant only; dock + overlay variants pass no onFlip so the
         entry hides). -->
    <div class="from-selection-label">From selection</div>
    {#if menu.isDir}
      <button role="menuitem" onclick={() => newFileOrDir(menu!.path)}>
        <FilePlus size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>New File or Directory</span>
      </button>
    {/if}
    {#each menuActions as row (row.id)}
      {@const RowIcon = row.icon}
      <button role="menuitem" onclick={row.onClick}>
        <RowIcon size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{row.label}</span>
        {#if row.chord}
          <span class="menu-row-chord">{row.chord}</span>
        {/if}
      </button>
    {/each}
    {#if !menu.isDir && menu.path !== draftsDir() && !isDraftPath(menu.path)}
      <button role="menuitem" onclick={() => uploadSelection(menu!.path, false)}>
        <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>Upload</span>
      </button>
    {/if}
    <div class="ctx-sep" role="separator"></div>
    {#each [{ command: "copy", label: "Copy" }, { command: "cut", label: "Cut" }, { command: "paste", label: "Paste" }, { command: "selectMode", label: selectionMode ? "Leave selection mode" : "Select multiple" }] as action}
      <button role="menuitem" disabled={action.command === "paste" && !fbClipboard.mode} onclick={() => runCommand(action.command as BrowserCommand)}>
        <span class="menu-row-label">{action.label}</span><span class="menu-row-chord">{browserCommandChord(action.command as BrowserCommand, browserKeys.vim)}</span>
      </button>
    {/each}
    <div class="ctx-sep" role="separator"></div>
    <button role="menuitem" onclick={() => runCommand("copyPath")}>
      <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>Copy Path</span>
    </button>
    <button role="menuitem" onclick={() => runCommand("rename")}>
      <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
      <span class="menu-row-label">Rename / Move</span><span class="menu-row-chord">{browserCommandChord("rename", browserKeys.vim)}</span>
    </button>
    <button role="menuitem" class="danger" onclick={() => runCommand("delete")}>
      <Trash size={16} strokeWidth={1.75} aria-hidden="true" />
      <span class="menu-row-label">Delete</span>
      <span class="menu-row-chord">{browserCommandChord("delete", browserKeys.vim)}</span>
    </button>
    {#if onFlip}
      <div class="ctx-sep" role="separator"></div>
      <button role="menuitem" onclick={flipFromMenu}>
        <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">Flip</span>
        <span class="menu-row-chord">{chordFor("app.pane.flip") ?? ""}</span>
      </button>
    {/if}
  </div>
{/if}

<input
  bind:this={uploadInput}
  class="file-picker"
  type="file"
  multiple
  onchange={onUploadPicked}
  aria-hidden="true"
  tabindex="-1"
/>

<style>
  .tree.directory-list { padding: 4px 8px; }
  .directory-list .row { display: grid; grid-template-columns: 18px minmax(120px, 1fr) 82px 80px 136px; gap: 10px; padding: 0 10px !important; min-height: 34px; border-radius: 5px; }
  .directory-list .name { min-width: 0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; text-align: left; }
  .entry-kind, .entry-size, .entry-modified { font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .entry-size { text-align: right; font-variant-numeric: tabular-nums; }
  .entry-modified { font-variant-numeric: tabular-nums; }
  .tree .row { min-height: 29px; border-radius: 4px; margin: 1px 4px; }
  .tree .row.zebra { background: transparent; }
  .tree .row.selected { background: var(--accent-bg, var(--hover-bg)); }
  .tree .row:hover { background: var(--hover-bg); }
  .tree:focus-visible .row.active-cursor { outline: 2px solid var(--focus-color, var(--link)); outline-offset: -2px; }
  .tree .row.active-cursor:not(.selected) { background: transparent; }
  @container (max-width: 700px) { .directory-list .row { grid-template-columns: 18px minmax(100px, 1fr) 80px; } .entry-kind, .entry-modified { display: none; } }

  .tree, .children {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* `position: relative` anchors the absolutely-positioned rubber-band
     overlay to the scrolling tree container so the band geometry shares
     the rows' coordinate space. */
  .tree {
    position: relative;
  }
  /* While a band drag is in progress, suppress native text selection so
     the drag reads as a selection rectangle, not a text highlight. */
  .tree.banding {
    user-select: none;
  }
  /* The rubber-band selection rectangle. Pointer-events:none so it never
     intercepts the rows it is being dragged over. */
  .rubber-band {
    position: absolute;
    pointer-events: none;
    z-index: 2;
    background: var(--accent-bg, rgba(120, 170, 255, 0.15));
    border: 1px solid var(--accent);
    border-radius: 2px;
  }
  .tree:focus {
    outline: none;
  }
  .tree:focus-visible .row.selected {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    font-size: 15px;
    color: var(--text);
  }
  /* Zebra striping: subtle alternating tint so the eye can track
     across long lists. Listed before :hover and .selected so those
     stronger states override at the same specificity. */
  .row.zebra { background: var(--zebra-bg); }
  .row:hover { background: var(--hover-bg); }
  /* Drop highlight during drag-and-drop move. Boxed outline + accent
     tint so the user sees exactly which directory will receive the drop,
     without disturbing the row height. */
  .row.drop-target {
    background: var(--accent-bg, var(--hover-bg));
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  /* Drop at workspace root: outline the whole tree container so the
     user can tell root-drop is a valid target even when the cursor
     is over empty space below the last row. */
  .tree.drop-root {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .twirl {
    background: none;
    border: 0;
    cursor: pointer;
    width: 14px;
    height: 14px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
  }
  /* Directory glyph: pulls toward --accent so the directory column reads
     as the navigational scaffold separate from the per-file kind
     icons. Sits beside the chevron and before the directory name. */
  .row.dir .dir-icon {
    color: var(--g-folder);
    margin-right: 2px;
  }
  /* Cmd+F highlight on rows whose filename matches the active find
     query (FileBrowserSurface workspaces setFindQuery). The current
     match gets a stronger ring so step-through (Enter / Shift+Enter)
     is visually obvious. Uses --warn-text so the highlight reads as
     "attention" without colliding with selection or hover bands. */
  .row.find-match {
    background: color-mix(in srgb, var(--warn-text, #e3b341) 16%, transparent);
  }
  .row.find-match--current {
    background: color-mix(in srgb, var(--warn-text, #e3b341) 28%, transparent);
    box-shadow: inset 0 0 0 1px var(--warn-text, #e3b341);
  }
  /* Per-kind glyph at the row's left edge. Mirrors the tab-strip
     icon (FileText / User / Image / etc.) so the file reads with the
     same glyph in both surfaces. Sits one step below the label hue
     so it doesn't compete with the filename for attention. */
  .row-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .row.contact .row-icon { color: var(--warn-text); }
  .name {
    background: none;
    border: 0;
    cursor: pointer;
    padding: 0;
    text-align: left;
    flex: 1;
    color: inherit;
    font: inherit;
    /* Fade long filenames at the edge instead of wrapping to a
       second line. Same pattern as Pane.svelte's tab-name mask: keep
       `nowrap` + `overflow: hidden` so the row stays one line, then
       apply a linear-gradient mask that fades the last 1.25rem of
       width to transparent. Mask is keyed off the row's own width so
       FB column resize automatically widens or narrows the visible
       portion. */
    display: block;
    white-space: nowrap;
    overflow: hidden;
    mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
  }
  /* Right-docked mirror: rows lay out chevron / icon / text from the
     right edge inward, the name right-aligns, and the inline padding
     switch (handled in the row template) puts the indent column on
     the right so the tree visually anchors against the viewport's
     right edge. Left-docked + overlay variants keep the default
     left-to-right layout. */
  .tree.right-dock .row {
    flex-direction: row-reverse;
  }
  .tree.right-dock .name {
    text-align: right;
    /* In right-dock the text right-aligns, so the fade flips
       direction: the LEFT edge fades (where the long part of the
       filename gets truncated). Mirrors Pane.svelte's right-dock
       tab-name handling. */
    mask-image: linear-gradient(to left, black calc(100% - 1.25rem), transparent);
    -webkit-mask-image: linear-gradient(to left, black calc(100% - 1.25rem), transparent);
  }
  /* Empty-state rows in right-dock mirror the text alignment too so
     "Loading..." / "No files" / dir errors don't drift to the left
     edge while every other row aligns right. */
  .tree.right-dock .empty {
    text-align: right;
  }
  /* Directory icon margin: in left-dock it sits between the chevron
     (on its left) and the name (on its right) with margin-right: 2px.
     Under row-reverse the visual order flips, so swap to margin-left
     so the same 2px gap lands on the correct side. */
  .tree.right-dock .row.dir .dir-icon {
    margin-right: 0;
    margin-left: 2px;
  }
  /* Dirty-dot sits trailing the file name in left-dock (margin-left:
     4px). With row-reverse it lands visually on the LEFT of the row,
     after the right-aligned name. Push the gap to the opposite side
     so it still reads as "after the name" in reading order. */
  .tree.right-dock .dirty-dot {
    margin-left: 0;
    margin-right: 4px;
  }
  /* View-only files (PNG, etc.): dim and italicize so the user can
     tell at a glance that these won't open in the editor. The future
     media browser will be the first-class surface for them. */
  .row.non-editable > .name {
    color: var(--text-secondary);
    font-style: italic;
    cursor: default;
  }
  /* Contact files (`chan.kind: contact` frontmatter): paint the name
     in --warn-text so the row reads as "contact" at a glance. One
     palette tone for contacts across surfaces (file tree, inspector
     chip + ref border, editor wiki pill, graph mention nodes). */
  .row.contact > .name {
    color: var(--warn-text);
  }
  /* Selection highlight. Reads as a soft band rather than the full
     accent color so it doesn't fight the dirty / git status dots
     that share the row. */
  .row.selected { background: var(--hover-bg); }
  .row.selected > .name { color: var(--text); font-weight: 600; }
  /* Active cursor within a multi-selection: a slightly stronger tint +
     an inset accent rail so the user can tell which entry the keyboard
     and the inspector are pointed at while several rows are selected.
     A single selection is both .selected and .active-cursor, so the
     solo look is unchanged from before the multi-select feature. */
  .row.active-cursor { background: var(--accent-bg, var(--hover-bg)); }
  .tree:focus-visible .row.active-cursor {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  /* A row marked for a pending CUT: dimmed + italic, the standard
     "this will move away on paste" affordance. Copy is not dimmed. */
  .row.cut { opacity: 0.5; }
  .row.cut .name { font-style: italic; }
  /* Same look as the tab-strip dirty indicator so the two views agree. */
  .dirty-dot {
    font-size: 16px;
    line-height: 1;
    margin-left: 4px;
  }
  .dirty-dot.unsaved { color: var(--info-text); }
  .empty {
    color: var(--text-secondary);
    padding: .75rem .5rem;
    text-align: center;
  }
  .empty-title {
    color: var(--text);
    font-weight: 600;
    margin-bottom: .35rem;
    font-size: 15px;
  }
  .empty-detail {
    color: var(--text-secondary);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .child-empty {
    font-size: 12px;
    text-align: left;
  }
  .empty-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
  }
  .empty-actions button {
    background: none;
    border: 0;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    padding: 2px 4px;
  }
  .empty-actions button:hover { text-decoration: underline; }
  .ctx {
    position: fixed;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,.4);
    /* Above OverlayShell's z-index (25000 + depth*10) so the portal'd
       context menu paints over the file-browser panel's backdrop
       instead of behind it. Matches HamburgerMenu's bubble layer. */
    z-index: 25500;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    /* easeOutBack bubble-pop matching the rest of the chrome
       (HamburgerMenu, tab-menu bubbles). */
    transform-origin: top left;
    animation: ctx-pop 260ms var(--ease-pop);
    transition: transform 200ms var(--ease-pop);
  }
  .ctx:hover {
    transform: scale(1.015);
  }
  @keyframes ctx-pop {
    0%   { opacity: 0; transform: scale(0.92); }
    100% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ctx {
      animation: none;
      transition: none;
    }
    .ctx:hover {
      transform: none;
    }
  }
  .ctx button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: .35rem .6rem;
    background: none;
    border: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transform-origin: left center;
    transition:
      background 80ms ease,
      color 80ms ease,
      transform 260ms var(--ease-pop);
  }
  .ctx button:hover {
    background: var(--hover-bg);
    transform: scale(1.02);
  }
  @media (prefers-reduced-motion: reduce) {
    .ctx button {
      transition: background 80ms ease, color 80ms ease;
    }
    .ctx button:hover {
      transform: none;
    }
  }
  .ctx button.danger { color: var(--warn-text); }
  .file-picker {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  /* "From selection" section label. Subdued style for a non-actionable
     menu grouping heading. */
  .from-selection-label {
    padding: 4px 8px 2px;
    color: var(--text-secondary);
    font-size: 11px;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  .ctx-sep {
    height: 1px;
    background: var(--border);
    margin: 4px 6px;
  }
  .ctx :global(svg) {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .ctx button.danger :global(svg) { color: var(--warn-text); }
</style>
