<script lang="ts">
  // Inspector body that renders metadata for a single file or directory.
  // Looks the entry up from the global tree by path; renders nothing
  // until a path is supplied (callers that want a placeholder pass
  // their own empty state outside this component, or pass `null`
  // and the host's body slot stays empty).
  //
  // Used by:
  //   - File Browser tab/dock: shows the current selection
  //     (browserSelection.path) plus an Open / × pair so the panel
  //     doubles as the action surface for the tree. References
  //     section (tags / mentions / dates / links / backlinks) is
  //     enabled here via showRefs.
  //   - FileEditorTab: shown inside a "show info" disclosure for the
  //     currently-edited file; lean layout (no Open/Close, no refs).
  //
  // Directory mode walks the flat tree to compute aggregate counts +
  // size + most-recent mtime. The walk is O(N) in tree size and only
  // re-runs when the selected path changes ($derived dependency
  // tracking does the gating).

  import { api, withTokenQuery } from "../api/client";
  import { isTauriDesktop, saveBytesToDownloads } from "../api/desktop";
  import { downloadBytes } from "../api/download";
  import type {
    GraphEdge,
    InspectorPayload,
    PathClass,
    ReportFileStats,
    ReportPrefix,
    TreeEntry,
  } from "../api/types";
  import { isImage, isMarkdown, isPdf, isVideo } from "../state/fileTypes";
  import { basename, formatMtime, formatSize } from "../state/format";
  import {
    ensureGraphLoaded,
    graphData,
    selectionEdgesFor,
  } from "../state/graphData.svelte";
  import { openImageZoom, type ZoomImage } from "../state/imageZoom";
  import { openPdfViewer } from "../state/pdfViewer";
  import { openVideoViewer } from "../state/videoViewer";
  import {
    copyTextToClipboard,
    draftsDir,
    effectiveHybridSurfaceTheme,
    isDraftPath,
    setTransientStatus,
    ui,
    workspace,
    fileOps,
    loadTreeDir,
    openGraphAtNode,
    openGraphForContact,
    openGraphForFile,
    openGraphForLanguage,
    openGraphForMention,
    openGraphForTag,
    revealPathInBrowser,
    tree,
  } from "../state/store.svelte";
  import { openTerminalInActivePane } from "../state/tabs.svelte";
  import { terminalFromHereTarget, shellQuotePath } from "../terminal/fromHere";
  import { classifyEntry, isOpenableTextKind } from "../state/kinds";
  import KindChip from "./KindChip.svelte";
  import { ChevronDown, Copy } from "lucide-svelte";

  /// Visual / behavioural kind for a file reference. Images route to
  /// the fullscreen zoom overlay (editor's "Zoom" button shares the
  /// same helper); videos route to the fullscreen video viewer;
  /// contacts are markdown notes flagged with the
  /// `chan.kind: contact` frontmatter and open in the editor like
  /// other docs but get their own chip color so a glance distinguishes
  /// them. The contact bit comes off the server-side tree listing
  /// (which joins chan-workspace's node-kind index) rather than a path
  /// heuristic, so contacts located outside `Contacts/` still classify
  /// correctly. Anything else is a doc.
  type RefKind = "doc" | "image" | "video" | "contact";
  function classifyRef(path: string): RefKind {
    if (isImage(path)) return "image";
    if (isVideo(path)) return "video";
    const e = entryByPath.get(path);
    if (e && !e.is_dir && e.kind === "contact") return "contact";
    return "doc";
  }

  let {
    path,
    label,
    onOpen,
    onReveal,
    onClose,
    showRefs = false,
    onNavigate,
    onContactNavigate,
    onSetAsScope,
    onNewTerminal,
    allowUpload = true,
  }: {
    path: string | null;
    /// Optional display name for the header. The graph passes the
    /// node's human label (e.g. "docs") so a folder inspected from the
    /// graph reads the same name the canvas shows. Files / FB folders
    /// leave it undefined and fall back to the basename.
    label?: string;
    onOpen?: () => void;
    /// Image / directory counterpart to `onOpen`. Renders a
    /// "Show in file browser" button on image entries and a
    /// "Show Directory" button on directory entries; the host reveals
    /// the path in its tree and closes itself. Absent = no button
    /// (e.g. when the inspector already lives inside the file
    /// browser).
    onReveal?: () => void;
    onClose?: () => void;
    /// When true, fetch + render tags / mentions / dates / links /
    /// backlinks for files. Off by default so the file editor's
    /// inline disclosure stays compact.
    showRefs?: boolean;
    /// Click handler for a link / backlink target. Receives the
    /// peer file path. Hosts decide whether to open it in the active
    /// pane and close themselves; absent = entries render as
    /// non-clickable.
    onNavigate?: (path: string) => void;
    /// Click handler for a resolved contact pill. Receives the
    /// contact file's path. Graph overlay binds this to "select
    /// the contact's node on the canvas" so contacts behave like
    /// documents in the inspector. Absent = fall back to
    /// openGraphForFile (the original "contacts are graph anchors,
    /// not destinations" behavior the file browser and search
    /// overlays still want).
    onContactNavigate?: (path: string) => void;
    /// "Graph from here" button for file selections. Graph overlay binds
    /// this to scope the current graph to the selected file (and
    /// re-pin it as the focal node). Other hosts leave it absent so
    /// the button doesn't render outside the graph.
    onSetAsScope?: () => void;
    /// "New Terminal" button for directory selections, opening a
    /// terminal with the directory as cwd. The dashboard Search slot
    /// binds this; other hosts leave it absent so the button doesn't
    /// render (directory-only, gated on `isDir`).
    onNewTerminal?: () => void;
    /// Whether the Upload button renders. Default true so the File
    /// Browser / editor / Graph-tab inspectors keep it; the dashboard
    /// Search slot passes false (read-only index view: Download only).
    allowUpload?: boolean;
  } = $props();

  const entryByPath = $derived(
    new Map(tree.entries.map((e) => [e.path, e])),
  );

  function parentDir(p: string): string {
    return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }

  /// Images that sit in the SAME directory as `p`, in the file tree's
  /// display order. Backs the fullscreen viewer's prev/next when the
  /// view is opened from the file browser (flat directory, no recursion).
  function dirImageSet(p: string): ZoomImage[] {
    const dir = parentDir(p);
    return tree.entries
      .filter((e) => !e.is_dir && isImage(e.path) && parentDir(e.path) === dir)
      .map((e) => ({ src: e.path, fromPath: null }));
  }

  const entry = $derived.by(() => {
    if (path === null || path === undefined) return null;
    if (path === "") {
      // Workspace root: no entry exists in tree.entries (the listing only
      // contains children). Synthesize a directory-shaped record so the
      // directory branch renders aggregate stats over the whole workspace.
      // The mtime field stays null because the workspace root has no
      // intrinsic timestamp; dirStats picks up the latest mtime
      // across descendants instead.
      return {
        path: "",
        is_dir: true,
        mtime: null,
        size: 0,
      } as TreeEntry;
    }
    const looked = entryByPath.get(path);
    if (looked) return looked;
    return null;
  });

  /// The file tree lazy-loads directory contents, so opening a file
  /// the user hasn't yet drilled into via the browser (a direct URL,
  /// the editor tab's "Show Details", a search result) leaves the
  /// entry missing from `tree.entries` and the inspector blank.
  /// When that happens, fetch the parent directory's listing so the
  /// entry shows up. Cheap: `loadTreeDir` short-circuits when the
  /// dir is already loaded or in flight.
  $effect(() => {
    if (!path || entry) return;
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    void loadTreeDir(parent);
  });

  const dirStats = $derived.by(() => {
    if (!entry || !entry.is_dir) return null;
    const prefix = entry.path ? `${entry.path}/` : "";
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let latest: number | null = null;
    for (const e of tree.entries) {
      if (prefix && !e.path.startsWith(prefix)) continue;
      if (e.path === entry.path) continue;
      if (e.is_dir) dirs += 1;
      else {
        files += 1;
        bytes += e.size;
      }
      if (e.mtime !== null && (latest === null || e.mtime > latest)) {
        latest = e.mtime;
      }
    }
    return { files, dirs, bytes, latest };
  });

  let inspectorPayload = $state<InspectorPayload | null>(null);
  let inspectorReq = 0;

  $effect(() => {
    inspectorPayload = null;
    if (path === null || path === undefined) return;
    const req = ++inspectorReq;
    void api.inspector(path)
      .then((payload) => {
        if (req === inspectorReq) inspectorPayload = payload;
      })
      .catch(() => {
        if (req === inspectorReq) inspectorPayload = null;
      });
  });

  const pathClass = $derived<PathClass | null>(
    inspectorPayload?.path_class ?? entry?.path_class ?? null,
  );
  const subtree = $derived(inspectorPayload?.subtree ?? null);
  const fileKindCounts = $derived.by(() => {
    if (!subtree) return [];
    return Object.entries(subtree.file_kinds)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6);
  });
  const specialBadges = $derived.by(() => {
    if (!pathClass) return [];
    const out: string[] = [];
    if (pathClass.permission === "read_only") out.push("read-only");
    if (pathClass.kind === "symlink") out.push("symlink");
    else if (pathClass.kind !== "regular_file" && pathClass.kind !== "directory") {
      out.push(pathClass.kind.replace(/_/g, " "));
    }
    if (pathClass.link_count > 1) out.push(`${pathClass.link_count} links`);
    if (pathClass.target_escapes_workspace) out.push("outside workspace");
    return out;
  });

  /// Outgoing edges (tags / mentions / dates / links) come straight
  /// out of the shared graph store; null while the graph hasn't
  /// loaded yet so the template can render a "loading" line.
  const refs = $derived.by(() => {
    if (!showRefs || !entry || entry.is_dir) return null;
    if (!graphData.view) return null;
    return selectionEdgesFor(entry.path);
  });

  /// Contact pills surfaced under the Contacts section. Merges three
  /// graph-edge cases so a file that references a contact through any
  /// path lands as a single row, and the matching entry disappears
  /// from "Links to" so the reader doesn't see Alice listed twice:
  ///
  ///   1. mention -> contact file (server resolved `@@alice` to
  ///      `Contacts/alice.md`): a navigable row using the file's
  ///      label and path.
  ///   2. mention -> standalone `@@name` (no matching contact file):
  ///      a graph-only row labeled `name`.
  ///   3. link    -> contact-kind file ([[Contacts/alice]] or a
  ///      regular markdown link to it): same shape as case 1.
  ///
  /// Deduped by the target node id so authoring both `@@alice` AND a
  /// link to `Contacts/alice.md` in the same document collapses to
  /// one pill.
  type ContactPill = {
    key: string;
    label: string;
    path: string | null;
    onClick: () => void;
  };
  const contactPills = $derived.by<ContactPill[]>(() => {
    if (!refs) return [];
    const out: ContactPill[] = [];
    const seen = new Set<string>();
    const push = (p: ContactPill) => {
      if (seen.has(p.key)) return;
      seen.add(p.key);
      out.push(p);
    };
    // Resolved contacts route through the host's `onContactNavigate`
    // when present (graph overlay: select the contact's node on the
    // canvas, matching how documents behave there). When absent, fall
    // back to opening a contact-scoped graph (bidirectional BFS lens
    // around the contact) via openGraphForContact.
    const navigateContact = onContactNavigate
      ? (p: string) => onContactNavigate(p)
      : (p: string) => openGraphForContact(p);
    for (const m of refs.mentions) {
      if (m.kind === "file" && !m.missing) {
        push({
          key: m.id,
          label: m.label,
          path: m.path,
          onClick: () => navigateContact(m.path),
        });
      } else {
        // Unresolved `@@name` - no matching contact on disk yet.
        // Opens the mention lens (a focused graph centered on the
        // `@@Name` meta-node with edges to every referencing file),
        // mirroring how a tag chip opens the tag lens. There's no
        // contact file to scope to, so the meta-node itself is the seed.
        push({
          key: m.id,
          label: m.label.replace(/^@@/, ""),
          path: null,
          onClick: () => openGraphForMention(m.id, m.label),
        });
      }
    }
    for (const l of refs.links) {
      if (l.kind !== "file" || l.missing) continue;
      if (classifyRef(l.path) !== "contact") continue;
      push({
        key: l.id,
        label: l.label,
        path: l.path,
        onClick: () => navigateContact(l.path),
      });
    }
    return out;
  });

  /// Non-contact outgoing links. Contact-kind targets move to the
  /// Contacts pill list above so the reader doesn't see Alice listed
  /// twice in the inspector when the source authored both an `@@alice`
  /// and a real markdown link to her contact file.
  const nonContactLinks = $derived(
    refs
      ? refs.links.filter(
          (l) => !(l.kind === "file" && !l.missing && classifyRef(l.path) === "contact"),
        )
      : [],
  );

  /// Backlinks (incoming `link` edges) live behind a separate
  /// endpoint (/api/backlinks/{path}) since the graph snapshot only
  /// records outgoing edges per file node. Refetched whenever the
  /// selected path changes; stale responses are dropped via the
  /// request-id guard.
  let backlinks = $state<GraphEdge[]>([]);
  let backlinksLoading = $state(false);
  let backlinksError = $state<string | null>(null);
  let backlinkReq = 0;

  $effect(() => {
    if (!showRefs || !entry || entry.is_dir) {
      backlinks = [];
      backlinksLoading = false;
      backlinksError = null;
      return;
    }
    void ensureGraphLoaded();
    const req = ++backlinkReq;
    const target = entry.path;
    const controller = new AbortController();
    backlinks = [];
    backlinksLoading = true;
    backlinksError = null;
    void api
      .backlinksStream(target, {
        signal: controller.signal,
        onEdge(edge) {
          if (req !== backlinkReq || edge.kind !== "link") return;
          backlinks = [...backlinks, edge];
        },
      })
      .then(() => {
        if (req !== backlinkReq) return;
        backlinksLoading = false;
      })
      .catch((err: unknown) => {
        if (req !== backlinkReq) return;
        if ((err as DOMException).name === "AbortError") return;
        backlinks = [];
        backlinksLoading = false;
        backlinksError = (err as Error).message;
      });
    return () => {
      controller.abort();
    };
  });

  function navigate(targetPath: string): void {
    if (!targetPath) return;
    onNavigate?.(targetPath);
  }

  let uploadInput = $state<HTMLInputElement | null>(null);

  function triggerUpload(): void {
    uploadInput?.click();
  }

  async function onUploadPicked(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!entry || !files || files.length === 0) return;
    if (entry.is_dir) {
      await fileOps.uploadFilesTo(entry.path, files);
    } else {
      await fileOps.replaceFileAt(entry.path, files[0]!);
    }
    input.value = "";
  }

  function downloadSelection(): void {
    if (!entry) return;
    // Desktop routes through the progress-tracked capability (the transfer
    // bubble shows progress); the browser hands off to its native download
    // manager.
    fileOps.downloadPathWithProgress(entry.path, entry.is_dir);
  }

  /// Render the selected markdown document to PDF and save it: the
  /// native Downloads pipeline on desktop, a browser download on the
  /// web. The engine loads on first use (dynamic import) and renders
  /// with the editor surface theme.
  async function exportSelectionToPdf(): Promise<void> {
    if (!entry || entry.is_dir) return;
    const path = entry.path;
    setTransientStatus(`exporting ${basename(path)}...`);
    try {
      const doc = await api.read(path);
      const { exportMarkdownToPdf, pdfFilenameFor } = await import(
        "../editor/pdf_export"
      );
      const theme =
        effectiveHybridSurfaceTheme("editor") === "dark" ? "dark" : "light";
      const bytes = await exportMarkdownToPdf({
        path,
        markdown: doc.content,
        theme,
        styleSource: null,
      });
      const filename = pdfFilenameFor(path);
      if (isTauriDesktop()) {
        await saveBytesToDownloads(bytes, filename);
      } else {
        downloadBytes(bytes, filename, "application/pdf");
      }
      setTransientStatus(`exported ${filename}`);
    } catch (err) {
      ui.status = `PDF export failed: ${err instanceof Error ? err.message : String(err)}`;
      ui.statusKind = "persistent";
    }
  }

  // Desktop-download progress now shows in the transfer bubble (the single
  // transfer surface), not an inline inspector indicator.

  /// Full-path toggle for the actions section. The header shows the
  /// basename; this reveals the ABSOLUTE filesystem path (workspace root
  /// joined with the relative path) so the user can paste it into a
  /// terminal or external tool. Resets to hidden whenever the selection
  /// changes so a new entry doesn't inherit the previous one's expand
  /// state. Workspace root ("") has no path to show.
  let showFullPath = $state(false);
  $effect(() => {
    void path;
    showFullPath = false;
  });

  /// Absolute filesystem path for the selected entry. Joins
  /// `workspace.info.root` (the on-disk root chan-server reports) with
  /// the entry's workspace-relative path, normalizing trailing slashes so
  /// `root` + `/` + relative produces a single separator. Empty root
  /// (boot edge case) falls back to the relative path so the COPY button
  /// still copies something meaningful.
  const absolutePath = $derived.by(() => {
    if (!entry?.path) return "";
    const root = workspace.info?.root ?? "";
    if (!root) return entry.path;
    const trimmed = root.replace(/[/\\]+$/, "");
    return `${trimmed}/${entry.path}`;
  });

  async function doCopyAbsolutePath(): Promise<void> {
    if (!absolutePath) return;
    await copyTextToClipboard(absolutePath, {
      onSuccess: () => setTransientStatus("Copied file path"),
      onError: (msg) => (ui.status = `copy failed: ${msg}`),
    });
  }

  const uploadTitle = $derived(
    entry?.is_dir
      ? "Upload adds the selected file to this directory. You can also drop files onto File Browser rows."
      : "Upload replaces this file. Text-class files reject non-UTF-8 bytes.",
  );
  const downloadTitle = $derived(
    entry?.is_dir
      ? "Download this directory as a tar archive. You can also drag rows out of the File Browser where supported."
      : "Download this file. You can also drag rows out of the File Browser where supported.",
  );

  /// Action model for the pill + dropdown. One main action plus a list of
  /// secondary actions, chosen per item category (directory / media /
  /// editable file / binary). The surface also matters: the editor "Show
  /// Details" inspector binds no onOpen (the file is already open there),
  /// so its file main action is "Show file" instead of "Open". Built
  /// reactively so it tracks the selection and the host-provided
  /// handlers; an action whose handler a surface doesn't bind drops out
  /// (e.g. no onSetAsScope => no "Graph from here").
  type InspectorAction = {
    label: string;
    onClick: () => void;
    title?: string;
    disabled?: boolean;
  };

  /// "Open" for a directory: a NEW File Browser tab expanded into the
  /// directory. The dashboard binds onReveal to the same reveal-and-enter
  /// call, so prefer it when present; other surfaces fall back to the
  /// shared revealPathInBrowser primitive.
  function openDirInBrowser(): void {
    if (!entry) return;
    if (onReveal) {
      onReveal();
      return;
    }
    revealPathInBrowser(entry.path, { enter: true, inspectorOpen: true });
  }

  /// "New terminal here": a terminal rooted at the directory (or a file's
  /// parent) with the file's basename seeded at the prompt. The dashboard
  /// binds onNewTerminal for its directory-only view; every other surface
  /// routes through the shared fromHere helper, so files get the
  /// "{cursor}{space}{relative-path}" seed (TerminalTab adds the leading
  /// space + cursor-to-start on top of the seedInput).
  function newTerminalHere(): void {
    if (onNewTerminal) {
      onNewTerminal();
      return;
    }
    if (!entry) return;
    openTerminalInActivePane(terminalFromHereTarget(entry.path, entry.is_dir));
  }

  const actionModel = $derived.by<{
    main: InspectorAction;
    secondary: InspectorAction[];
  } | null>(() => {
    if (!entry) return null;
    // The Drafts dir is uncommitted scratch space, so "Open" (a File
    // Browser tab), Upload, Download tarball and Graph-from-here don't
    // apply. The one meaningful action is to drop a terminal there, so
    // the Drafts node gets a SINGLE "Terminal from here" button and no
    // dropdown.
    if (entry.path === draftsDir()) {
      return {
        main: { label: "Terminal from here", onClick: newTerminalHere },
        secondary: [],
      };
    }
    // A draft FILE is scratch too, so Open / Show file / Download /
    // Graph-from-here don't apply. A SINGLE "Terminal from
    // here" button (no dropdown) that opens a terminal seeded with
    // {cursor}{space}{ABSOLUTE-path-of-the-draft}. The absolute path comes
    // from the inspector payload (abs_path); cwd is the workspace root, so the
    // location-independent absolute seed is what reaches the prompt. The
    // {cursor}{space} prefix is added by TerminalTab's seed mechanism.
    if (isDraftPath(entry.path)) {
      const draftAbs = inspectorPayload?.abs_path ?? null;
      return {
        main: {
          label: "Terminal from here",
          onClick: () =>
            openTerminalInActivePane(
              draftAbs
                ? { cwd: "", seedInput: shellQuotePath(draftAbs) }
                : terminalFromHereTarget(entry.path, false),
            ),
        },
        secondary: [],
      };
    }
    const isDir = entry.is_dir;
    const p = entry.path;
    const image = !isDir && isImage(p);
    const pdf = !isDir && isPdf(p);
    const video = !isDir && isVideo(p);
    // Editability follows the server-provided content kind, not the path
    // extension: the file browser's per-directory listing content-sniffs
    // an odd-suffix file to `text` / `binary`, so a plaintext file with an
    // unknown extension gets "Open" (matching the tree's double-click,
    // which peeks the content) instead of the extension-gated "Download".
    const editable = !isDir && isOpenableTextKind(classifyEntry(entry));
    const media = image || pdf || video;

    const download: InspectorAction = {
      label: isDir ? "Download tarball" : "Download file",
      onClick: downloadSelection,
      title: downloadTitle,
    };
    const newTerminal: InspectorAction = {
      label: "New terminal here",
      onClick: newTerminalHere,
    };
    // Markdown documents export to PDF on every surface (web and
    // desktop alike; the save path differs, not the availability).
    const exportPdf: InspectorAction | null =
      !isDir && isMarkdown(p)
        ? { label: "Export to PDF", onClick: exportSelectionToPdf }
        : null;
    const graph: InspectorAction | null = onSetAsScope
      ? { label: "Graph from here", onClick: onSetAsScope }
      : null;
    const secondary: InspectorAction[] = [];
    let main: InspectorAction;

    if (isDir) {
      main = { label: "Open", onClick: openDirInBrowser };
      if (allowUpload) {
        secondary.push({
          label: "Upload file here",
          onClick: triggerUpload,
          title: uploadTitle,
        });
      }
      secondary.push(download, newTerminal);
      if (graph) secondary.push(graph);
    } else if (media) {
      main = image
        ? {
            label: "View / Zoom",
            onClick: () => openImageZoom(p, null, dirImageSet(p)),
          }
        : video
          ? { label: "View Video", onClick: () => openVideoViewer(p) }
          : { label: "View PDF", onClick: () => openPdfViewer(p) };
      secondary.push(download, newTerminal);
      if (graph) secondary.push(graph);
    } else if (editable) {
      if (onOpen) {
        main = { label: "Open", onClick: onOpen };
        // Search binds both Open + reveal; surface "Show file" too.
        if (onReveal) secondary.push({ label: "Show file", onClick: onReveal });
      } else if (onReveal) {
        // Editor "Show Details": the file is already open in this editor.
        main = { label: "Show file", onClick: onReveal };
      } else {
        main = download;
      }
      secondary.push(download, newTerminal);
      if (exportPdf) secondary.push(exportPdf);
      if (graph) secondary.push(graph);
    } else {
      // Binary, including symlinks: download is the only sensible action.
      main = download;
      if (graph) secondary.push(graph);
    }

    // The main action never repeats in the dropdown (object identity, so
    // the fallback `main = download` collapses the duplicate cleanly).
    return { main, secondary: secondary.filter((a) => a !== main) };
  });

  /// Dropdown open state for the secondary-action menu. Resets whenever
  /// the selection changes so a new entry doesn't inherit an open menu.
  let menuOpen = $state(false);
  let actionsEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    void path;
    menuOpen = false;
  });
  $effect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: MouseEvent) => {
      if (actionsEl && !actionsEl.contains(e.target as Node)) menuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") menuOpen = false;
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  });

  /// chan-report integration. The "Code" section shows language /
  /// SLOC / complexity for files, and the per-directory roll-up
  /// (totals + top languages + COCOMO) for directories. Fetched
  /// lazily whenever the selected path changes; a request-id guard
  /// drops stale responses if the user clicks through several
  /// entries faster than the round-trip.
  ///
  /// 404 on the file endpoint is normal (binary / gitignored /
  /// unknown language) and silently hides the section. Other errors
  /// surface a one-line failure note so the user knows the call
  /// happened but didn't return data.
  let fileReport = $state<ReportFileStats | null>(null);
  let prefixReport = $state<ReportPrefix | null>(null);
  let reportLoading = $state(false);
  let reportError = $state<string | null>(null);
  let reportReq = 0;

  /// "Top N + see more" toggle for the per-language list in directory
  /// mode. Default of 5 matches the inspector's appetite for compact
  /// sections; the full list is one click away. Resets to collapsed
  /// whenever the selection changes so a new directory doesn't inherit
  /// the previous one's expand state.
  const LANG_PREVIEW = 5;
  let langExpanded = $state(false);

  $effect(() => {
    fileReport = null;
    prefixReport = null;
    reportError = null;
    langExpanded = false;
    if (!entry) {
      reportLoading = false;
      return;
    }
    const req = ++reportReq;
    const target = entry;
    const controller = new AbortController();
    reportLoading = true;
    const fetcher: Promise<ReportFileStats | ReportPrefix | null> = target.is_dir
      ? // Prefer the O(1) /api/report/dir cache (what the graph folder
        // inspector used) and fall back to the walking /api/report/prefix
        // when the cache has no entry yet, so a folder inspected on any
        // surface gets the same cheap path.
        api.reportDir(target.path).catch((e) => {
          const msg = (e as Error)?.message ?? "";
          if (/404/.test(msg) || /not found/i.test(msg)) {
            return api.reportPrefix(target.path);
          }
          throw e;
        })
      : api.reportFileStream(target.path, {
          signal: controller.signal,
          onReport(stats) {
            if (req !== reportReq) return;
            fileReport = stats;
          },
          onMissing() {
            if (req !== reportReq) return;
            fileReport = null;
          },
        });
    void fetcher
      .then((res) => {
        if (req !== reportReq) return;
        if (target.is_dir) {
          prefixReport = (res as ReportPrefix | null) ?? null;
        } else {
          fileReport = (res as ReportFileStats | null) ?? null;
        }
        reportLoading = false;
      })
      .catch((err: unknown) => {
        if (req !== reportReq) return;
        if ((err as DOMException).name === "AbortError") return;
        reportError = (err as Error).message;
        reportLoading = false;
      });
    return () => {
      controller.abort();
    };
  });

  /// Per-language roll-up sliced for display: collapse to top N by
  /// SLOC unless the user clicked "see more". The hidden count
  /// workspaces the "+N more" affordance label.
  const visibleLanguages = $derived.by(() => {
    if (!prefixReport) return [];
    const all = prefixReport.by_language;
    if (langExpanded || all.length <= LANG_PREVIEW) return all;
    return all.slice(0, LANG_PREVIEW);
  });
  const hiddenLanguageCount = $derived(
    prefixReport
      ? Math.max(0, prefixReport.by_language.length - visibleLanguages.length)
      : 0,
  );

  /// COCOMO formatting helpers. We deliberately drop estimated cost
  /// from the inspector: the dollar number is a default-salary
  /// extrapolation that's noisy for a personal notes app. Effort,
  /// schedule, and developer-count carry the useful signal.
  function fmtMonths(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return n >= 10 ? `${Math.round(n)} mo` : `${n.toFixed(1)} mo`;
  }
  function fmtDevs(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return n >= 10 ? `${Math.round(n)}` : n.toFixed(1);
  }
</script>

<!-- Shared ACTIONS section. Rendered directly under the filename header
     on every surface (File Browser, editor, Graph) so the inspector has
     one consistent layout: header -> actions -> lazy content. Per
     inspector-spec.md the actions move up here from the old bottom-of-
     body placement. The contextual actions differ by entry kind:
       - editable file: Open (gated on the server content kind, so an
         odd-suffix plaintext file opens like the tree double-click);
       - media (image): View/Zoom; (pdf): View PDF;
       - every entry: Upload + Download (+ progress indicator);
       - host-provided: Show File/Directory (onReveal), Graph from here
         (onSetAsScope).
     A full-path toggle reveals the workspace-relative path (header shows
     the basename). -->
{#snippet actionsSection()}
  {#if entry && actionModel}
    <div class="actions-section">
      {#if entry.path}
        <button
          type="button"
          class="path-toggle"
          aria-expanded={showFullPath}
          onclick={() => (showFullPath = !showFullPath)}
          title={showFullPath ? "Hide full path" : "Show full path"}
        >
          {showFullPath ? "Hide path" : "Show path"}
        </button>
        {#if showFullPath}
          <div class="path-row-group">
            <div class="path-row mono" title={absolutePath}>{absolutePath}</div>
            <button
              type="button"
              class="copy-btn"
              onclick={doCopyAbsolutePath}
              title="Copy absolute path to clipboard"
              aria-label="Copy absolute path to clipboard"
            ><Copy size={14} aria-hidden="true" /></button>
          </div>
        {/if}
      {/if}
      <!-- Pill + dropdown: one primary action plus a caret that opens the
           secondary actions. Built from actionModel so the category logic
           lives in the script, not the template. -->
      <div class="action-actions" bind:this={actionsEl}>
        <div class="action-pill" class:has-caret={actionModel.secondary.length > 0}>
          <button
            class="pill-main"
            type="button"
            onclick={actionModel.main.onClick}
            disabled={actionModel.main.disabled}
            title={actionModel.main.title}>{actionModel.main.label}</button
          >
          {#if actionModel.secondary.length > 0}
            <button
              class="pill-caret"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              onclick={() => (menuOpen = !menuOpen)}
            ><ChevronDown size={15} aria-hidden="true" /></button>
          {/if}
        </div>
        {#if menuOpen && actionModel.secondary.length > 0}
          <div class="action-menu" role="menu">
            {#each actionModel.secondary as item (item.label)}
              <button
                class="action-menu-item"
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onclick={() => {
                  menuOpen = false;
                  item.onClick();
                }}>{item.label}</button
              >
            {/each}
          </div>
        {/if}
      </div>
      <input
        bind:this={uploadInput}
        class="file-picker"
        type="file"
        multiple={entry.is_dir}
        onchange={onUploadPicked}
        aria-hidden="true"
        tabindex="-1"
      />
    </div>
  {/if}
{/snippet}

{#if !entry}
  <div class="empty">
    <div class="empty-title">Details</div>
    <div class="empty-hint">click a file or directory to inspect</div>
  </div>
{:else if entry.is_dir}
  <div class="info">
    <header class="head">
      {#if isDraftPath(entry.path)}
        <!-- Keep the file-inspector Drafts copy aligned with the
             graph directory inspector. Keyed off draftsDir() so the
             configured Drafts dir (default .Drafts) renders the chip. -->
        <span class="kind-chip drafts-chip">DRAFTS</span>
      {:else}
        <KindChip kind="folder" block onClick={onSetAsScope} />
      {/if}
    </header>
    <h3 class="title" title={entry.path || "/"}>
      {label || basename(entry.path) || workspace.info?.label || "(root)"}
    </h3>
    {#if isDraftPath(entry.path)}
      <!-- Drafts notice. Mirrors the copy in DirectoryInfoBody. -->
      <div class="drafts-notice" role="note">
        <strong>Drafts are uncommitted scratch space.</strong>
        Save or discard them from their editor tabs, not the tree.
        Cmd+N creates a fresh draft under
        <code>{draftsDir()}/untitled-N/</code>.
      </div>
    {/if}
    {#if specialBadges.length > 0}
      <div class="badge-row">
        {#each specialBadges as badge}
          <span class="flag-badge">{badge}</span>
        {/each}
      </div>
    {/if}
    {@render actionsSection()}
    {#if dirStats}
      <div class="meta-grid">
        <span class="k">files</span>
        <span class="v">{subtree?.files ?? dirStats.files}</span>
        <span class="k">subdirectories</span>
        <span class="v">{subtree?.directories ?? dirStats.dirs}</span>
        <span class="k">size</span>
        <span class="v">{formatSize(subtree?.bytes ?? dirStats.bytes)}</span>
        <span class="k">last change</span>
        <span class="v">{formatMtime(dirStats.latest)}</span>
        {#if pathClass?.target}
          <span class="k">target</span>
          <span class="v mono" title={pathClass.target}>{pathClass.target}</span>
        {/if}
      </div>
    {/if}
    {#if fileKindCounts.length > 0}
      <section class="refs compact-section">
        <h4>File Kinds</h4>
        <div class="kind-counts">
          {#each fileKindCounts as [kind, count]}
            <span class="kind-count"><span>{kind}</span><strong>{count}</strong></span>
          {/each}
        </div>
      </section>
    {/if}
    {#if prefixReport && prefixReport.totals.files > 0}
      <section class="refs">
        <h4>Code</h4>
        <div class="meta-grid">
          <span class="k">indexed</span>
          <span class="v">{prefixReport.totals.files}</span>
          <span class="k">SLOC</span>
          <span class="v">{prefixReport.totals.code.toLocaleString()}</span>
          <span class="k">comments</span>
          <span class="v">{prefixReport.totals.comments.toLocaleString()}</span>
          <span class="k">blanks</span>
          <span class="v">{prefixReport.totals.blanks.toLocaleString()}</span>
          <span class="k">complexity</span>
          <span class="v">{prefixReport.totals.complexity.toLocaleString()}</span>
        </div>
        {#if prefixReport.by_language.length > 0}
          <ul class="lang-list">
            {#each visibleLanguages as lang (lang.name)}
              <li class="lang-row">
                <button
                  type="button"
                  class="lang-name"
                  title="open in graph (scoped to this language)"
                  onclick={() => openGraphForLanguage(lang.name)}
                >{lang.name}</button>
                <span class="lang-files">{lang.files} file{lang.files === 1 ? "" : "s"}</span>
                <span class="lang-sloc">{lang.code.toLocaleString()} SLOC</span>
              </li>
            {/each}
          </ul>
          {#if hiddenLanguageCount > 0}
            <button
              type="button"
              class="see-more"
              onclick={() => (langExpanded = true)}
            >+{hiddenLanguageCount} more</button>
          {:else if langExpanded && prefixReport.by_language.length > LANG_PREVIEW}
            <button
              type="button"
              class="see-more"
              onclick={() => (langExpanded = false)}
            >show fewer</button>
          {/if}
        {/if}
        <div class="cocomo">
          <div class="cocomo-title">COCOMO ({prefixReport.cocomo.model})</div>
          <div class="meta-grid">
            <span class="k">effort</span>
            <span class="v">{fmtMonths(prefixReport.cocomo.effort_person_months)}</span>
            <span class="k">schedule</span>
            <span class="v">{fmtMonths(prefixReport.cocomo.schedule_months)}</span>
            <span class="k">developers</span>
            <span class="v">{fmtDevs(prefixReport.cocomo.developers)}</span>
          </div>
        </div>
      </section>
    {:else if reportLoading}
      <div class="refs-loading">loading report...</div>
    {:else if reportError}
      <div class="refs-error">report unavailable: {reportError}</div>
    {/if}
  </div>
{:else}
  {@const image = isImage(entry.path)}
  {@const pdf = isPdf(entry.path)}
  {@const video = isVideo(entry.path)}
  {@const fileKind = classifyEntry(entry)}
  <div class="info">
    <header class="head">
      <KindChip kind={fileKind} path={entry.path} block onClick={onSetAsScope} />
    </header>
    <h3 class="title" title={entry.path}>{basename(entry.path)}</h3>
    {#if specialBadges.length > 0}
      <div class="badge-row">
        {#each specialBadges as badge}
          <span class="flag-badge">{badge}</span>
        {/each}
      </div>
    {/if}
    {#if image}
      <!-- Inline preview. Bytes come from /api/files with the
           per-launch bearer token appended as a query param so the
           browser's <img> can fetch without a custom Authorization
           header. Object-fit contains so portrait + landscape both
           sit cleanly in the fixed-height frame.
           Wrapped in a button so a click on the preview opens the
           shared fullscreen zoom overlay (matches the editor's
           image action overlay). -->
      <button
        type="button"
        class="image-preview"
        title="Zoom"
        onclick={() => openImageZoom(entry.path, null, dirImageSet(entry.path))}
      >
        <img
          src={withTokenQuery(`/api/files/${encodeURIComponent(entry.path).replace(/%2F/g, "/")}`)}
          alt={basename(entry.path)}
          loading="lazy"
        />
      </button>
    {:else if video}
      <!-- Inline preview: native controls in the frame, so a clip is
           playable without leaving the inspector. Same token-in-query
           fetch as the image preview; `preload="metadata"` pulls only
           the moov/duration bytes (the server answers with 206s), the
           stream starts on user intent. The fullscreen surface is one
           action away via "View Video". -->
      <div class="video-preview">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={withTokenQuery(`/api/files/${encodeURIComponent(entry.path).replace(/%2F/g, "/")}`)}
          controls
          preload="metadata"
        ></video>
      </div>
    {/if}
    {@render actionsSection()}
    <div class="meta-grid">
      <span class="k">size</span>
      <span class="v">{formatSize(entry.size)}</span>
      <span class="k">modified</span>
      <span class="v">{formatMtime(entry.mtime)}</span>
      {#if pathClass?.target}
        <span class="k">target</span>
        <span class="v mono" title={pathClass.target}>{pathClass.target}</span>
      {/if}
      {#if showRefs && !image && !pdf && !video}
        <span class="k">tags</span>
        <span class="v">{refs ? refs.tags.length : "..."}</span>
        <span class="k">contacts</span>
        <span class="v">{refs ? contactPills.length : "..."}</span>
        <span class="k">dates</span>
        <span class="v">{refs ? refs.dates.length : "..."}</span>
        <span class="k">links out</span>
        <span class="v">{refs ? nonContactLinks.length : "..."}</span>
        <span class="k">backlinks</span>
        <span class="v">{backlinksLoading ? `${backlinks.length}...` : backlinks.length}</span>
      {:else if showRefs && (image || pdf || video)}
        <!-- Media files (images, PDFs, videos) can be link targets
             but carry no outgoing references of their own. Show just
             the "linked from" count; tags / contacts / dates would
             always be zero. -->
        <span class="k">linked from</span>
        <span class="v">{backlinksLoading ? `${backlinks.length}...` : backlinks.length}</span>
      {/if}
    </div>
    {#if fileReport}
      {@const fileLang = fileReport.language}
      <section class="refs">
        <h4>Code</h4>
        <div class="meta-grid">
          <span class="k">language</span>
          <span class="v">
            <button
              type="button"
              class="lang-link"
              title="open in graph (scoped to this language)"
              onclick={() => openGraphForLanguage(fileLang)}
            >{fileLang}</button>
          </span>
          <span class="k">SLOC</span>
          <span class="v">{fileReport.code.toLocaleString()}</span>
          <span class="k">comments</span>
          <span class="v">{fileReport.comments.toLocaleString()}</span>
          <span class="k">blanks</span>
          <span class="v">{fileReport.blanks.toLocaleString()}</span>
          <span class="k">complexity</span>
          <span class="v">{fileReport.complexity.toLocaleString()}</span>
        </div>
      </section>
    {:else if reportLoading}
      <div class="refs-loading">loading report...</div>
    {:else if reportError}
      <div class="refs-error">report unavailable: {reportError}</div>
    {/if}
    {#if showRefs}
      {#if !graphData.view && graphData.loading}
        <div class="refs-loading">loading references...</div>
      {:else if graphData.error}
        <div class="refs-error">references unavailable: {graphData.error}</div>
      {:else if refs}
        {#if refs.tags.length > 0}
          <section class="refs">
            <h4>Tags</h4>
            <ul>
              {#each refs.tags as t (t.id)}
                <li>
                  <button
                    class="ref tag"
                    onclick={() => openGraphForTag(t.id, t.label)}
                    title="open in graph (scoped to this tag)"
                  >{t.label}</button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        {#if contactPills.length > 0}
          <section class="refs">
            <h4>Contacts</h4>
            <ul>
              {#each contactPills as c (c.key)}
                <li>
                  <button
                    class="ref contact"
                    onclick={c.onClick}
                    title={c.path
                      ? `open in graph (scoped to ${c.path})`
                      : "open in graph"}
                  >{c.label}</button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        {#if refs.dates.length > 0}
          <section class="refs">
            <h4>Dates</h4>
            <ul>
              {#each refs.dates as d (d.id)}
                <li>
                  <button
                    class="ref date"
                    onclick={() => openGraphAtNode(d.id)}
                    title="open in graph"
                  >{d.label}</button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        {#if nonContactLinks.length > 0}
          <section class="refs">
            <h4>Links to</h4>
            <ul>
              {#each nonContactLinks as l (l.id)}
                <li>
                  {#if l.kind !== "file"}
                    <span class="ref file">{l.label}</span>
                  {:else if l.missing}
                    <span class="ref file missing" data-refkind={classifyRef(l.path)}>{l.label}</span>
                  {:else if classifyRef(l.path) === "image"}
                    <button
                      class="ref file"
                      data-refkind="image"
                      title="Zoom"
                      onclick={() => openImageZoom(l.path, null, dirImageSet(l.path))}
                    >{l.label}</button>
                  {:else if classifyRef(l.path) === "video"}
                    <button
                      class="ref file"
                      data-refkind="video"
                      title="View video"
                      onclick={() => openVideoViewer(l.path)}
                    >{l.label}</button>
                  {:else if onNavigate}
                    <button
                      class="ref file"
                      data-refkind={classifyRef(l.path)}
                      onclick={() => navigate(l.path)}
                    >{l.label}</button>
                  {:else}
                    <span class="ref file" data-refkind={classifyRef(l.path)}>{l.label}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        {#if backlinks.length > 0}
          <section class="refs">
            <h4>Backlinks</h4>
            <ul>
              {#each backlinks as b (b.src)}
                <li>
                  {#if classifyRef(b.src) === "image"}
                    <button
                      class="ref file"
                      data-refkind="image"
                      title="Zoom"
                      onclick={() => openImageZoom(b.src, null, dirImageSet(b.src))}
                    >{b.src}</button>
                  {:else if classifyRef(b.src) === "video"}
                    <button
                      class="ref file"
                      data-refkind="video"
                      title="View video"
                      onclick={() => openVideoViewer(b.src)}
                    >{b.src}</button>
                  {:else if onNavigate}
                    <button
                      class="ref file"
                      data-refkind={classifyRef(b.src)}
                      onclick={() => navigate(b.src)}
                    >{b.src}</button>
                  {:else}
                    <span class="ref file" data-refkind={classifyRef(b.src)}>{b.src}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {:else if backlinksError}
          <div class="refs-error">backlinks unavailable: {backlinksError}</div>
        {/if}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .info {
    padding: 0.6rem 0.7rem 0.8rem 0.7rem;
    font-size: 12.5px;
  }
  /* Hairline dividers between the inspector's top-level sections
     (buttons / file size / code / references). Target DIRECT children of
     `.info` so the nested COCOMO meta-grid (inside `.refs`) keeps its own
     dashed sub-divider and doesn't pick up a section rule. Each top-level
     block owns the line above it; the identity header (.head/.title/
     .badge-row/.image-preview/.drafts-notice) stays divider-free so the
     first rule sits above the actions section. */
  .info > .actions-section,
  .info > .meta-grid,
  .info > .refs,
  .info > .refs-loading,
  .info > .refs-error {
    border-top: 1px solid var(--separator);
    margin-top: 0.6rem;
    padding-top: 0.6rem;
  }
  .empty {
    text-align: center;
    color: var(--text-secondary);
    padding: 1.2rem 0.7rem 0.8rem 0.7rem;
  }
  .empty-title {
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.25rem;
  }
  .empty-hint {
    font-style: italic;
    font-size: 14px;
    opacity: 0.85;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  /* Drafts chip + notice mirror the DirectoryInfoBody styling so
     the FB-selected Drafts row renders identically to the graph-side
     dir node inspector. */
  .kind-chip.drafts-chip {
    flex: 1;
    color: #fff;
    background: var(--fb-drafts-fg);
    text-transform: uppercase;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 3px;
    text-align: center;
  }
  .drafts-notice {
    margin: 0.5rem 0;
    padding: 0.5rem 0.6rem;
    border-radius: 4px;
    background: var(--fb-drafts-bg);
    border-left: 3px solid var(--fb-drafts-fg);
    font-size: 12.5px;
    color: var(--text);
    line-height: 1.45;
  }
  .drafts-notice strong {
    display: block;
    margin-bottom: 0.25rem;
  }
  .drafts-notice code {
    background: var(--bg);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
  }
  /* Image preview frame: fixed max height, checkered fallback bg
     (visible while bytes are loading or for images with alpha so
     the panel doesn't show empty space). object-fit contain keeps
     the natural aspect ratio so portraits and landscapes both fit. */
  /* Image preview frame: fixed max height, checkered fallback bg
     (visible while bytes are loading or for images with alpha so
     the panel doesn't show empty space). object-fit contain keeps
     the natural aspect ratio so portraits and landscapes both fit.
     Rendered as a <button> so a click opens the fullscreen zoom
     overlay; default button chrome is stripped. */
  .image-preview {
    margin: 0 0 0.6rem 0;
    padding: 4px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    max-height: 220px;
    overflow: hidden;
    width: 100%;
    cursor: zoom-in;
    font: inherit;
    color: inherit;
  }
  .image-preview:hover { border-color: var(--btn-hover); }
  .image-preview img {
    max-width: 100%;
    max-height: 210px;
    object-fit: contain;
    display: block;
    pointer-events: none;
  }
  /* Image-preview frame minus the zoom affordance: the inline video
     keeps its native controls, so the frame is not a button. */
  .video-preview {
    margin: 0 0 0.6rem 0;
    padding: 4px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    max-height: 220px;
    overflow: hidden;
    width: 100%;
  }
  .video-preview video {
    max-width: 100%;
    max-height: 210px;
    display: block;
    background: #000;
  }
  .title {
    margin: 0 0 0.5rem 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
  }
  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: -0.15rem 0 0.45rem 0;
  }
  .flag-badge {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--text-secondary);
    background: var(--bg-card);
    font-size: 11px;
    line-height: 1.4;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 6.5em 1fr;
    gap: 2px 0.5rem;
    margin: 0.4rem 0 0.6rem 0;
    font-size: 14px;
  }
  .meta-grid .k { color: var(--text-secondary); }
  .meta-grid .v {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .meta-grid .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* ACTIONS section: sits directly under the filename header on every
     surface. A single pill (primary action) + a caret that drops the
     secondary actions; the full-path toggle + revealed path sit above. */
  .actions-section {
    margin: 0.2rem 0 0.6rem 0;
  }
  /* Anchor for the absolutely-positioned dropdown. The actions sit near
     the top of the inspector, so the menu opens downward without
     clipping against the aside's overflow. */
  .action-actions {
    position: relative;
    margin-top: 0.2rem;
  }
  .action-pill {
    display: flex;
    align-items: stretch;
    width: 100%;
  }
  .pill-main {
    flex: 1;
    min-width: 0;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 5px 0;
    cursor: pointer;
    font: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill-main:hover { border-color: var(--btn-hover); }
  .pill-main:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .pill-main:disabled:hover { border-color: var(--btn-border); }
  /* With a caret present the two halves merge into one control: square
     the shared edge and drop the doubled border between them. */
  .action-pill.has-caret .pill-main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
  }
  .pill-caret {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-top-right-radius: 4px;
    border-bottom-right-radius: 4px;
    cursor: pointer;
    line-height: 0;
  }
  .pill-caret:hover { border-color: var(--btn-hover); }
  .action-menu {
    position: absolute;
    top: calc(100% + 3px);
    left: 0;
    right: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  }
  .action-menu-item {
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 5px 8px;
  }
  .action-menu-item:hover { background: var(--hover-bg, rgba(127, 127, 127, 0.15)); }
  .action-menu-item:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .action-menu-item:disabled:hover { background: transparent; }
  .path-toggle {
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 0;
    margin: 0 0 0.35rem 0;
  }
  .path-toggle:hover { text-decoration: underline; }
  .path-row {
    font-size: 11.5px;
    color: var(--text-secondary);
    margin: 0 0 0.45rem 0;
    word-break: break-all;
  }
  /* Path row + COPY button live on one row when the toggle reveals the
     absolute path. The path text takes the remaining width; the button
     sits flush right so the affordance is visible without scrolling. */
  .path-row-group {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0 0 0.45rem 0;
  }
  .path-row-group .path-row {
    flex: 1;
    margin: 0;
  }
  .copy-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--btn-border);
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    padding: 3px;
    line-height: 0;
  }
  .copy-btn:hover { border-color: var(--btn-hover); }
  .file-picker {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  /* Reference sections (tags / mentions / dates / links / backlinks).
     Visual style mirrors the graph panel's aside so the two
     inspectors feel like one feature. */
  .refs {
    margin: 0.6rem 0 0 0;
  }
  .compact-section {
    margin-top: 0.35rem;
  }
  .refs h4 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0 0 0.25rem 0;
  }
  .refs ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .refs li { margin: 0; }
  .kind-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .kind-count {
    display: inline-flex;
    gap: 5px;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 5px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .kind-count strong {
    color: var(--text);
    font-weight: 600;
  }
  .ref {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 13px;
    color: var(--text);
    cursor: default;
    font: inherit;
    line-height: 1.5;
    word-break: break-word;
  }
  button.ref {
    cursor: pointer;
  }
  button.ref:hover {
    border-color: var(--btn-hover);
    background: var(--hover-bg);
  }
  .ref.tag { color: var(--accent); }
  .ref.date { color: var(--text-secondary); }
  /* Backlinks / link targets: use the standard text color rather
     than --link. The chip already reads as a clickable button
     thanks to the surface + hover treatment, and the doc/file
     name is the actual content, not a call-to-action.
     Per-kind left accent (doc / image / contact) lets the reader
     scan the list and pick out images vs contacts vs plain docs
     without a per-row icon. Padding is fixed so swapping accent
     widths doesn't shift the label. */
  .ref.file {
    color: var(--text);
    word-break: break-all;
    border-left-width: 3px;
    padding-left: 6px;
  }
  .ref.file[data-refkind="doc"] { border-left-color: var(--g-doc); }
  .ref.file[data-refkind="image"] { border-left-color: var(--g-img); }
  .ref.file[data-refkind="contact"] { border-left-color: var(--warn-text); }
  /* Broken link target: the linked file no longer exists on the workspace.
     Distinct color + strikethrough so a glance flags the dangling
     reference; kind accent stripe is kept so the reader still sees
     what was being pointed at. */
  .ref.file.missing {
    color: var(--danger-text);
    font-style: italic;
    text-decoration: line-through;
    text-decoration-color: var(--danger-text);
  }
  /* Contact rows in the Contacts section: same block-button shape as
     the other ref types, with a small person silhouette prefixed in
     --warn-text so a glance tells you the entry is a person rather
     than a generic doc. Icon matches the editor wiki pill's glyph for
     visual continuity. */
  .ref.contact {
    color: var(--warn-text);
    padding-left: 22px;
    position: relative;
  }
  .ref.contact::before {
    content: "";
    position: absolute;
    left: 6px;
    top: 50%;
    width: 12px;
    height: 12px;
    transform: translateY(-50%);
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='5' r='3'/><path d='M2 14c0-3 3-5 6-5s6 2 6 5z'/></svg>") center / contain no-repeat;
    mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='5' r='3'/><path d='M2 14c0-3 3-5 6-5s6 2 6 5z'/></svg>") center / contain no-repeat;
  }
  .refs-loading,
  .refs-error {
    color: var(--text-secondary);
    font-size: 13px;
    margin-top: 0.6rem;
    font-style: italic;
  }
  .refs-error { color: var(--warn-text); font-style: normal; }
  /* Per-language row in the Code section. Three columns: language
     name on the left (allowed to grow), file count + SLOC on the
     right (tabular-nums so the digit columns line up across rows). */
  .lang-list {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lang-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.5rem;
    font-size: 13px;
    align-items: baseline;
  }
  /* A <button> so the language name routes to the Graph (scoped to
     this language). Strip default button chrome, left-align, and add
     hover + focus affordance. Stays a grid cell at column 1. */
  .lang-name {
    color: var(--text);
    word-break: break-word;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
  }
  .lang-name:hover { text-decoration: underline; }
  .lang-name:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
    border-radius: 2px;
  }
  .lang-link {
    color: var(--text);
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
  }
  .lang-link:hover { text-decoration: underline; }
  .lang-link:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
    border-radius: 2px;
  }
  .lang-files,
  .lang-sloc {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .see-more {
    display: block;
    margin: 0.3rem 0 0 0;
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 0;
  }
  .see-more:hover { text-decoration: underline; }
  .cocomo {
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px dashed var(--border);
  }
  .cocomo-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin-bottom: 0.2rem;
  }
  .cocomo .meta-grid {
    margin: 0;
  }
</style>
