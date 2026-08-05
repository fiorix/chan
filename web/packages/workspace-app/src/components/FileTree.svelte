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
    Trash2,
    Upload,
  } from "lucide-svelte";
  import { api } from "../api/client";
  import { handleDemoDownload } from "../api/transport";
  import { clampMenu } from "./menuClamp";
  import { portal } from "./portal";
  import type { TreeEntry } from "../api/types";
  import { isEditableText } from "../state/fileTypes";
  import { openMediaViewer } from "../state/mediaOpen";
  import { classifyFile, iconFor } from "../state/kinds";
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
    clearTreeLoadingForPath,
    draftsDir,
    isDraftPath,
    workspace,
    fbClearSelection,
    fbClipboard,
    fbClipboardClear,
    fbClipboardPaste,
    fbClipboardSet,
    fbSelectRange,
    fbSelectSet,
    fbSelectSingle,
    fbToggle,
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
  }: {
    /// Stable id of the owning File Browser surface (`fb-tab-<id>` /
    /// `fb-dock-<side>` / `fb-overlay`). Keys this tree's expand/collapse
    /// map in the per-instance `fbTreeInstances` registry so two visible
    /// surfaces don't share expansion state.
    instanceId: string;
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

  // File Browser native drag IN and OUT is not supported (the macOS
  // native drag-out crashed and other platforms were no-ops): the
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
    // Multi-drag (FB3): if the grabbed row is part of the current
    // multi-selection, drag the WHOLE selection; otherwise the drag
    // implicitly selects just this row (desktop behavior - grabbing an
    // unselected row drops the old selection).
    let dragPaths: string[];
    if (browserSelection.paths.includes(path) && browserSelection.paths.length > 1) {
      dragPaths = [...browserSelection.paths];
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
  /// `paths` array carries the full multi-selection (FB3); it falls back
  /// to the single `path` for a drag started before the multi-drag
  /// payload existed.
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
    const srcParent = src.path.includes("/")
      ? src.path.slice(0, src.path.lastIndexOf("/"))
      : "";
    return srcParent === destDir;
  }

  /// Compute the target path for dropping `src` into `destDir`.
  /// destDir == "" means the workspace root.
  function dropTargetPath(src: string, destDir: string): string {
    const base = src.split("/").pop() ?? src;
    return destDir === "" ? base : `${destDir}/${base}`;
  }

  function onRowDragOver(e: DragEvent, destDir: string): void {
    // Only the app-internal tree-move is a valid drop now; external OS
    // file drops (drag-IN) are no longer accepted (use the Upload
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
    // External OS file drops (drag-IN) are no longer accepted; only the
    // app-internal tree-move resolves. Importing files is the Upload
    // button's job now.
    const src = readTreeDrag(e);
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    // Multi-drag (FB3): move every dragged entry that is a valid drop
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
    // Many: one atomic multi-entry move through the transfer route.
    try {
      const resp = await api.fsTransfer("move", candidates, destDir);
      if (resp.moved.length > 0) fbSelectSet(resp.moved.map((m) => m.to));
    } catch (err) {
      notify(`move failed: ${(err as Error).message}`);
    }
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
    name: string;
    path: string;
    size: number;
    mtime: number | null;
  };
  type Node = Folder | File;

  // Per-instance expand/collapse map. Each File Browser surface owns its
  // own record in `fbTreeInstances` keyed by `instanceId`, so expanding a
  // directory in one surface no longer fans out to every other visible
  // surface. The instance is CREATED in an effect (ensureFbTreeInstance
  // mutates $state, which is illegal inside a $derived - it throws
  // state_unsafe_mutation); the $derived only READS it (reactively
  // re-pointing once the effect registers the instance, and on remount
  // under a different id). The workspace root (`""`) is kept expanded.
  $effect(() => {
    ensureFbTreeInstance(instanceId);
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

  const root = $derived<Folder>(buildTree(tree.entries));

  /// Membership set for the multi-selection, O(1) per row. The whole
  /// set highlights as `.selected`; the active cursor (`browserSelection
  /// .path`) additionally gets `.active-cursor` so it reads as the
  /// keyboard/inspector focus within a multi-select.
  const selectedSet = $derived(new Set(browserSelection.paths));

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
        if (n.kind === "dir" && expanded[n.path]) walk(n.children, depth + 1);
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
        if (n.kind === "dir" && expanded[n.path]) walk(n.children);
      }
    }
    walk(root.children);
    return m;
  });

  $effect(() => {
    const pending: string[] = [];
    function collect(nodes: Node[]): void {
      for (const n of nodes) {
        if (n.kind !== "dir" || !expanded[n.path]) continue;
        if (!tree.loadedDirs[n.path] && !tree.loadingDirs[n.path]) {
          pending.push(n.path);
        }
        collect(n.children);
      }
    }
    collect(root.children);
    for (const path of pending) void loadTreeDir(path);
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
    // Persist this surface's expansion (tab variant writes through to the
    // layout tab's `expanded` field for reload restore; dock/overlay is
    // session-scoped). FileBrowserSurface's per-instance effects mirror
    // the map into the tab record; this just workspaces the reload snapshot.
    persistFbTreeInstanceExpansion(instanceId);
    if (value) void loadTreeDir(path);
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

  /// Single-click selects an entry; the FileBrowserTab side panel
  /// then renders its details. Files no longer auto-open on click;
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
    // Desktop-file-browser click semantics:
    //   - cmd/ctrl+click toggles one entry in the set.
    //   - shift+click extends the range from the anchor over the
    //     visible rows (display order).
    //   - plain click = single select (resets set + anchor).
    // `path` always becomes the active cursor the inspector + single-
    // target actions read off `browserSelection.path`.
    if (ev?.metaKey || ev?.ctrlKey) {
      fbToggle(path);
    } else if (ev?.shiftKey) {
      fbSelectRange(path, visibleRows.map((r) => r.path));
    } else {
      fbSelectSingle(path);
    }
    onClickRow?.(path);
  }

  function showMenu(ev: MouseEvent, path: string, isDir: boolean): void {
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
      { open: true, reveal: true, graph: true, upload: true },
    );
    return [set.main, ...set.secondary].map((id) =>
      menuRowFor(id, menu!.path, menu!.isDir),
    );
  });

  /// Unified "New File or Directory" entry. Opens a single
  /// PathPromptModal with `kind: "either"`; trailing slash → dir,
  /// otherwise → file. The kind-specific `newFile` / `newDir`
  /// helpers stay exported in `fileOps` for callers that want them.
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
    tab.inspectorOpen = true;
    tab.showWorkspace = false;
    // The new tab's surface seeds its own per-instance expansion from
    // `tab.expanded` on mount, so there is no global singleton to prime
    // here anymore.
    tab.expanded = ancestors.length > 0 ? ancestors : undefined;
    fbSelectSingle(path);
    browserSelection.showWorkspace = false;
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
      await navigator.clipboard?.writeText(path);
      notify("Copied path");
    } catch (err) {
      notify(`copy failed: ${(err as Error).message}`);
    } finally {
      clearTreeLoadingForPath(path);
    }
    menu = null;
  }
  function downloadSelection(path: string, isDir: boolean): void {
    if (handleDemoDownload(path, isDir)) return;
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
  async function remove(path: string, isDir: boolean): Promise<void> {
    await fileOps.remove(path, isDir);
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

  /// Move the selection by one row in the visible list. Wraps
  /// nothing: stops at the ends. Scrolls the new row into view.
  function moveSelection(delta: number): void {
    const rows = visibleRows;
    if (rows.length === 0) return;
    const cur = browserSelection.path;
    const idx = cur ? rows.findIndex((r) => r.path === cur) : -1;
    let next: number;
    if (idx === -1) {
      next = delta > 0 ? 0 : rows.length - 1;
    } else {
      next = Math.max(0, Math.min(rows.length - 1, idx + delta));
    }
    const target = rows[next];
    if (!target) return;
    // A plain arrow move collapses any multi-selection to the new cursor.
    fbSelectSingle(target.path);
    queueScrollIntoView(target.path);
  }

  /// Shift+Arrow: extend the selection range from the anchor toward the
  /// row one step (delta) past the current cursor, in visible-row order.
  /// The anchor is held fixed so the range grows/shrinks from the same
  /// origin (desktop shift-extend semantics).
  function extendSelection(delta: number): void {
    const rows = visibleRows;
    if (rows.length === 0) return;
    const order = rows.map((r) => r.path);
    const cur = browserSelection.path;
    const idx = cur ? order.indexOf(cur) : -1;
    if (idx === -1) {
      // No cursor yet: seed a single selection at an end and anchor it.
      fbSelectSingle(delta > 0 ? order[0] : order[order.length - 1]);
      queueScrollIntoView(browserSelection.path!);
      return;
    }
    const next = Math.max(0, Math.min(order.length - 1, idx + delta));
    fbSelectRange(order[next], order);
    queueScrollIntoView(order[next]);
  }

  function moveToFirst(): void {
    const rows = visibleRows;
    if (rows.length === 0) return;
    fbSelectSingle(rows[0].path);
    queueScrollIntoView(rows[0].path);
  }

  function moveToLast(): void {
    const rows = visibleRows;
    if (rows.length === 0) return;
    fbSelectSingle(rows[rows.length - 1].path);
    queueScrollIntoView(rows[rows.length - 1].path);
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
    const path = browserSelection.path;
    if (!path) return;
    requestAnimationFrame(() => {
      const el = rowEls.get(path);
      if (el) el.scrollIntoView({ block: "nearest" });
    });
  });

  /// Walk to the parent directory of `path`. Returns "" for top-level
  /// rows; the caller decides whether to act on root selection.
  function parentOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i === -1 ? "" : path.slice(0, i);
  }

  function findFirstChildOf(path: string): string | null {
    const rows = visibleRows;
    const idx = rows.findIndex((r) => r.path === path);
    if (idx === -1 || idx + 1 >= rows.length) return null;
    const parent = rows[idx];
    const next = rows[idx + 1];
    return next.depth > parent.depth ? next.path : null;
  }

  function onTreeKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const rows = visibleRows;
    const cur = browserSelection.path;
    const curRow = cur ? rows.find((r) => r.path === cur) : undefined;

    // Select-all-visible (cmd/ctrl+A), scoped to THIS focused tree.
    // Caught before the generic modifier early-return below.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (rows.length > 0) {
        fbSelectSet(rows.map((r) => r.path));
        queueScrollIntoView(rows[rows.length - 1].path);
      }
      return;
    }

    // Clipboard chords (cmd/ctrl+C copy, +X cut, +V paste), scoped to
    // this focused tree. Caught before the generic modifier early-return.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "c" || k === "x") {
        if (browserSelection.paths.length > 0) {
          e.preventDefault();
          fbClipboardSet(k === "c" ? "copy" : "cut", browserSelection.paths);
        }
        return;
      }
      if (k === "v") {
        e.preventDefault();
        void pasteIntoTarget();
        return;
      }
    }
    // Escape clears a pending cut/copy marker.
    if (e.key === "Escape" && fbClipboard.mode) {
      e.preventDefault();
      fbClipboardClear();
      return;
    }

    // Shift+Arrow extends the selection range from the anchor. Plain
    // arrows are a single-select move (reset set + anchor). Other
    // modifier-laden chords we don't bind fall through to the OS.
    if (e.altKey || ((e.metaKey || e.ctrlKey) && e.key !== "ArrowUp" && e.key !== "ArrowDown")) {
      return;
    }
    const extend = e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp");
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (extend) extendSelection(1);
        else moveSelection(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (extend) extendSelection(-1);
        else moveSelection(-1);
        break;
      case "ArrowRight": {
        if (!curRow) {
          e.preventDefault();
          moveToFirst();
          break;
        }
        if (curRow.isDir) {
          e.preventDefault();
          if (!expanded[curRow.path]) {
            setExpanded(curRow.path, true);
          } else {
            const child = findFirstChildOf(curRow.path);
            if (child) {
              fbSelectSingle(child);
              queueScrollIntoView(child);
            }
          }
        }
        break;
      }
      case "ArrowLeft": {
        if (!curRow) {
          e.preventDefault();
          moveToFirst();
          break;
        }
        if (curRow.isDir && expanded[curRow.path]) {
          e.preventDefault();
          setExpanded(curRow.path, false);
        } else {
          e.preventDefault();
          const parent = parentOf(curRow.path);
          if (parent) {
            fbSelectSingle(parent);
            queueScrollIntoView(parent);
          }
        }
        break;
      }
      case "Enter": {
        if (!curRow) break;
        e.preventDefault();
        if (curRow.isDir) {
          toggle(curRow.path);
        } else {
          // Same flow as a double-click on the row: media opens its
          // viewer overlay, everything else attempts the editor open.
          openFileRow(curRow.path);
        }
        break;
      }
      case "Home":
        e.preventDefault();
        moveToFirst();
        break;
      case "End":
        e.preventDefault();
        moveToLast();
        break;
      // Backspace (Mac "delete") and forward-Delete both trigger
      // removal. The destructive uiConfirm in fileOps.remove is the
      // safety gate; without it we'd want to keep this unbound.
      case "Backspace":
      case "Delete": {
        if (!curRow) break;
        e.preventDefault();
        void remove(curRow.path, curRow.isDir);
        break;
      }
    }
  }

  /// Resolve the directory a paste should land in: the active selection
  /// if it is a directory; otherwise the parent directory of the active
  /// selection; otherwise the workspace root. Mirrors how a desktop file
  /// browser pastes "into the current folder".
  function pasteTargetDir(): string {
    const cur = browserSelection.path;
    if (!cur) return "";
    const row = visibleRows.find((r) => r.path === cur);
    if (row?.isDir) return cur;
    return parentOf(cur);
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
      const name = r.path.split("/").pop() ?? r.path;
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
    // controls (name button/span, dirty dot) - those own their own
    // select/toggle gesture. The empty gutter and inter-row space start
    // a band.
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest(".name, .row-icon, .dirty-dot, .empty")) return;
    // Don't start a band from a modifier-less click that is really a row
    // background click; we still allow it (it becomes a clear on mouseup
    // if no drag happens).
    bandActive = true;
    bandStartClientX = e.clientX;
    bandStartClientY = e.clientY;
    // cmd/ctrl held: ADD the banded rows to the existing selection
    // (desktop additive rubber-band). Otherwise the band REPLACES it.
    bandAdditive = e.metaKey || e.ctrlKey;
    bandBaseSelection = bandAdditive ? [...browserSelection.paths] : [];
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

  function onBandUp(): void {
    const wasDrag = band !== null;
    bandActive = false;
    band = null;
    bandBaseSelection = [];
    window.removeEventListener("mousemove", onBandMove, true);
    window.removeEventListener("mouseup", onBandUp, true);
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

<ul
  class="tree"
  class:drop-root={dropTarget === ""}
  class:right-dock={rightDock}
  class:banding={band !== null}
  role="tree"
  tabindex="0"
  bind:this={treeRootEl}
  onkeydown={onTreeKeydown}
  onmousedown={onTreeMouseDown}
  ondragover={(e) => onRowDragOver(e, "")}
  ondragleave={() => onRowDragLeave("")}
  ondrop={(e) => onRowDrop(e, "")}
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
  {#if root.children.length === 0 && tree.loading}
    <li class="empty">
      <div class="empty-title">Loading files...</div>
    </li>
  {:else if root.children.length === 0 && tree.rootUnavailable}
    <li class="empty">
      <div class="empty-title">Workspace root unavailable</div>
      <div class="empty-detail">{tree.error}</div>
    </li>
  {:else if root.children.length === 0 && tree.error}
    <li class="empty">
      <div class="empty-title">File listing failed</div>
      <div class="empty-detail">{tree.error}</div>
    </li>
  {:else if root.children.length === 0}
    <li class="empty">
      <div class="empty-title">No files</div>
      <div class="empty-actions">
        <button onclick={() => fileOps.createFile("")}>Create new file</button>
        <button onclick={() => fileOps.createDir("")}>Create new directory</button>
      </div>
    </li>
  {/if}
</ul>

{#snippet renderNode(node: Node, depth: number)}
  {@const rowIndex = rowIndexByPath.get(node.path) ?? 0}
  <li>
    {#if node.kind === "dir"}
      <div
        class={`row dir ${rowMatchClass(node.path)}`}
        class:selected={selectedSet.has(node.path)}
        class:active-cursor={browserSelection.path === node.path}
        class:cut={cutSet.has(node.path)}
        class:zebra={rowIndex % 2 === 1}
        class:drop-target={dropTarget === node.path}
        style={rightDock
          ? `padding-right: ${depth * 12}px`
          : `padding-left: ${depth * 12}px`}
        oncontextmenu={(e) => showMenu(e, node.path, true)}
        role="treeitem"
        tabindex="-1"
        aria-expanded={!!expanded[node.path]}
        aria-selected={browserSelection.path === node.path}
        draggable="true"
        ondragstart={(e) => onFileDragStart(e, node.path, true)}
        ondragover={(e) => onRowDragOver(e, node.path)}
        ondragleave={() => onRowDragLeave(node.path)}
        ondrop={(e) => onRowDrop(e, node.path)}
        title={fullPath(node.path)}
        use:trackRow={node.path}
      >
        <button
          class="twirl"
          onclick={() => toggle(node.path)}
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
        </button>
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
            if (!(e.shiftKey || e.metaKey || e.ctrlKey)) toggle(node.path);
            selectPath(node.path, e);
          }}
          onkeydown={() => {}}
          role="button"
          tabindex="0"
        >{node.name}/</span>
      </div>
      {#if expanded[node.path]}
        <ul class="children">
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
      {@const editable = isEditableText(node.path)}
      {@const contact = contactPaths.has(node.path)}
      {@const kind = classifyFile(node.path, contact ? "contact" : undefined)}
      {@const Icon = iconFor(kind)}
      <div
        class={`row file ${rowMatchClass(node.path)}`}
        class:selected={selectedSet.has(node.path)}
        class:active-cursor={browserSelection.path === node.path}
        class:cut={cutSet.has(node.path)}
        class:non-editable={!editable}
        class:contact
        class:zebra={rowIndex % 2 === 1}
        style={rightDock
          ? `padding-right: ${depth * 12 + 16}px`
          : `padding-left: ${depth * 12 + 16}px`}
        oncontextmenu={(e) => showMenu(e, node.path, false)}
        role="treeitem"
        tabindex="-1"
        aria-selected={browserSelection.path === node.path}
        draggable="true"
        ondragstart={(e) => onFileDragStart(e, node.path, false)}
        ondragover={(e) => onRowDragOver(e, parentOf(node.path))}
        ondragleave={() => onRowDragLeave(parentOf(node.path))}
        ondrop={(e) => onRowDrop(e, parentOf(node.path))}
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
          onclick={(e) => selectPath(node.path, e)}
          ondblclick={() => openFileRow(node.path)}
        >{node.name}</button>
        {#if editorDirty.has(node.path)}
          <span class="dirty-dot unsaved" title="unsaved changes" aria-label="unsaved">●</span>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

{#if menu}
  <div class="ctx" use:portal use:clampMenu={{ x: menu.x, y: menu.y }}>
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
      <button onclick={() => newFileOrDir(menu!.path)}>
        <FilePlus size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>New File or Directory</span>
      </button>
    {/if}
    {#each menuActions as row (row.id)}
      {@const RowIcon = row.icon}
      <button onclick={row.onClick}>
        <RowIcon size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{row.label}</span>
        {#if row.chord}
          <span class="menu-row-chord">{row.chord}</span>
        {/if}
      </button>
    {/each}
    {#if !menu.isDir && menu.path !== draftsDir() && !isDraftPath(menu.path)}
      <button onclick={() => uploadSelection(menu!.path, false)}>
        <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>Upload</span>
      </button>
    {/if}
    <div class="ctx-sep" role="separator"></div>
    <button onclick={() => copyPath(menu!.path)}>
      <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>Copy Path</span>
    </button>
    <button onclick={() => rename(menu!.path, menu!.isDir)}>
      <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>Rename / Move</span>
    </button>
    <button class="danger" onclick={() => remove(menu!.path, menu!.isDir)}>
      <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
      <span class="menu-row-label">Delete</span>
      <span class="menu-row-chord">{chordFor("app.files.delete") ?? ""}</span>
    </button>
    {#if onFlip}
      <div class="ctx-sep" role="separator"></div>
      <button onclick={flipFromMenu}>
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
    animation: ctx-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
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
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
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
