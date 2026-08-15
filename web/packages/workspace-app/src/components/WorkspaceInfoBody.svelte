<script lang="ts">
  // Workspace inspector body. Shown in the file browser's Inspector pane
  // when the user clicks the Directory row in the hamburger menu, in the
  // graph when the workspace-root node is selected, and on the Dashboard's
  // front Workspace slide. Search index status lives in the Search Status
  // overlay; the global default-workspace + recents config now lives on the
  // Dashboard Workspace slot's flip-back (WorkspaceSlotConfig).
  //
  // Parity with FileInfoBody's directory mode: this body renders the same
  // aggregate stats (files, subdirs, size, last change), file-kind
  // counts, and code report a regular folder inspector shows. The
  // workspace chip + title up top stay distinct (workspace-rooted, not a
  // generic folder). `variant` only toggles the directory action row
  // (inspector) vs. nothing (dashboard front slide).

  import { api } from "../api/client";
  import type { InspectorPayload, ReportPrefix } from "../api/types";
  import { formatMtime, formatSize } from "../state/format";
  import { windowCaps } from "../state/windowCaps";
  import {
    fileOps,
    openGraphAtNode,
    openGraphForContact,
    openGraphForLanguage,
    revealPathInBrowser,
    tree,
    workspace,
  } from "../state/store.svelte";
  import { ensureGraphLoaded, graphData } from "../state/graphData.svelte";
  import { openTerminalInActivePane } from "../state/tabs.svelte";
  import { terminalFromHereTarget } from "../terminal/fromHere";
  import InspectorActionPill, {
    type InspectorAction,
  } from "./InspectorActionPill.svelte";

  /// Optional "Graph from here" callback. Consumers that host this
  /// body alongside an existing inspector convention pass it;
  /// surfaces that don't leave it unset and the button doesn't
  /// render. The action's semantic differs per consumer
  /// (FileBrowserSurface SPAWNS a new Graph tab while GraphPanel's own
  /// inspector RE-SCOPES the current tab), so the consumer wires the
  /// function and this body is callback-agnostic.
  ///
  /// The workspace root behaves like any other directory inspector.
  /// `variant` selects between the two surfaces:
  ///   - "inspector" (default): render the standard directory ACTION
  ///     ROW (Upload / Download / Show in File Browser / Graph from
  ///     here).
  ///   - "dashboard": the Dashboard front Workspace slide. The action
  ///     row does NOT render (the per-workspace config lives on the
  ///     slot's flip-back, WorkspaceSlotConfig).
  /// The aggregate stats grid, File Kinds, and Code/COCOMO sections
  /// render in both variants. `onReveal` wires the "Show in File
  /// Browser" button (inspector variant only).
  /// The workspace inspector matches FileInfoBody's clickable
  /// Languages + Contacts:
  ///   - `onLanguageClick`: fired when a language row is clicked;
  ///     opens that language's graph lens. Mirrors FileInfoBody's
  ///     `openGraphForLanguage(lang.name)` wiring.
  ///   - `onContactNavigate`: fired when a contact pill is clicked
  ///     for a RESOLVED contact (a `chan.kind: contact` file). The
  ///     graph host can select the node on the canvas; other hosts
  ///     spawn a contact-scoped lens. Unresolved `@@name` mentions
  ///     always route through `openGraphAtNode` (no file to scope to).
  /// Both default to the store helpers so a standalone mount stays
  /// functional even when a host doesn't wire them.
  let {
    variant = "inspector",
    onReveal,
    onSetAsScope,
    onLanguageClick = openGraphForLanguage,
    onContactNavigate,
  }: {
    variant?: "inspector" | "dashboard";
    onReveal?: () => void;
    onSetAsScope?: () => void;
    onLanguageClick?: (language: string) => void;
    onContactNavigate?: (path: string) => void;
  } = $props();

  /// Action-row plumbing (inspector variant). Mirrors FileInfoBody's
  /// directory branch but pinned to the workspace ROOT, i.e. the
  /// relative path is the empty string "".
  let uploadInput = $state<HTMLInputElement | null>(null);

  function triggerUpload(): void {
    uploadInput?.click();
  }

  async function onUploadPicked(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    await fileOps.uploadFilesTo("", files);
    input.value = "";
  }

  function downloadSelection(): void {
    // Desktop routes through the progress-tracked capability (the transfer
    // bubble shows progress); the browser hands off to its native download
    // manager. true = is_dir.
    fileOps.downloadPathWithProgress("", true);
  }

  const uploadTitle =
    "Upload adds the selected file to this directory. You can also drop files onto File Browser rows.";
  const downloadTitle =
    "Download this directory as a tar archive. You can also drag rows out of the File Browser where supported.";

  /// "Open" primary action for the workspace root. Mirrors
  /// FileInfoBody's openDirInBrowser: prefer the host's onReveal (the graph
  /// switches to a File Browser tab at the root) and otherwise reveal the
  /// root in the current browser (the File Browser tab leaves onReveal unset
  /// because the root already lives there).
  function openRootInBrowser(): void {
    if (onReveal) {
      onReveal();
      return;
    }
    revealPathInBrowser("", { enter: true, inspectorOpen: true });
  }

  /// "New terminal here": a terminal rooted at the workspace root.
  function newTerminalHere(): void {
    openTerminalInActivePane(terminalFromHereTarget("", true));
  }

  /// Split-action model for the inspector variant: an "Open" primary
  /// plus the Upload / Download / Terminal / Graph dropdown. The labels
  /// match the directory inspector (FileInfoBody's is_dir branch) so the
  /// root and a directory read identically.
  const actionModel = $derived.by<{
    main: InspectorAction;
    secondary: InspectorAction[];
  }>(() => {
    const secondary: InspectorAction[] = [
      { label: "Upload file here", onClick: triggerUpload, title: uploadTitle },
      {
        label: "Download tarball",
        onClick: downloadSelection,
        title: downloadTitle,
      },
      { label: "New terminal here", onClick: newTerminalHere },
    ];
    if (onSetAsScope) {
      secondary.push({ label: "Graph from here", onClick: onSetAsScope });
    }
    return {
      main: { label: "Open", onClick: openRootInBrowser },
      secondary,
    };
  });

  /// Aggregate stats walked from the loaded file tree. Mirrors
  /// FileInfoBody's `dirStats` derivation for the workspace root: every
  /// loaded entry contributes since the root has no prefix. The walk is
  /// O(N) in tree size and re-runs only when tree.entries changes
  /// ($derived dependency tracking). `latest` falls back to null when
  /// the tree is empty.
  const dirStats = $derived.by(() => {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let latest: number | null = null;
    for (const e of tree.entries) {
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

  /// Server-side subtree summary for the workspace root. Authoritative
  /// over the tree walk because the tree only contains loaded children;
  /// `subtree.files` / `subtree.directories` / `subtree.bytes` count the
  /// whole workspace. Falls back to the dirStats walk while the request
  /// is in flight so the panel is never blank.
  let inspectorPayload = $state<InspectorPayload | null>(null);
  let inspectorReq = 0;
  $effect(() => {
    inspectorPayload = null;
    // `/api/report/*` and `/api/inspector` live on the workspace router only,
    // so a window with no workspace behind it 404s on every one of them. The
    // directory branch made that worse: a 404 from reportDir is the signal to
    // fall back to reportPrefix, so one selection cost two doomed requests and
    // then rendered "report unavailable" where the section should simply be
    // absent.
    if (!windowCaps.workspace) return;
    const req = ++inspectorReq;
    void api.inspector("")
      .then((payload) => {
        if (req === inspectorReq) inspectorPayload = payload;
      })
      .catch(() => {
        if (req === inspectorReq) inspectorPayload = null;
      });
  });
  const subtree = $derived(inspectorPayload?.subtree ?? null);
  const fileKindCounts = $derived.by(() => {
    if (!subtree) return [];
    return Object.entries(subtree.file_kinds)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6);
  });

  /// Whole-workspace code report. Same `/api/report/dir` cache with the
  /// `/api/report/prefix` walking fallback that FileInfoBody's dir branch
  /// uses, so the workspace inspector and a regular folder inspector both
  /// share the cheap path.
  let prefixReport = $state<ReportPrefix | null>(null);
  let reportLoading = $state(false);
  let reportError = $state<string | null>(null);
  let reportReq = 0;
  let langExpanded = $state(false);
  const LANG_PREVIEW = 5;

  $effect(() => {
    prefixReport = null;
    reportError = null;
    langExpanded = false;
    // Workspace-only route; see the inspector effect above.
    if (!windowCaps.workspace) {
      reportLoading = false;
      return;
    }
    const req = ++reportReq;
    reportLoading = true;
    void api
      .reportDir("")
      .catch((e) => {
        const msg = (e as Error)?.message ?? "";
        if (/404/.test(msg) || /not found/i.test(msg)) {
          return api.reportPrefix("");
        }
        throw e;
      })
      .then((res) => {
        if (req !== reportReq) return;
        prefixReport = (res as ReportPrefix | null) ?? null;
        reportLoading = false;
      })
      .catch((err: unknown) => {
        if (req !== reportReq) return;
        reportError = (err as Error).message;
        reportLoading = false;
      });
  });

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

  /// Contacts section at the workspace root.
  /// FileInfoBody's contact pills derive from a single file's outgoing
  /// edges (`selectionEdgesFor(path)`); the workspace ROOT has no
  /// single-file refs, so the workspace-level "every contact in the
  /// workspace" source is the shared semantic graph snapshot. Two node
  /// kinds surface as contacts:
  ///   1. `kind:"file"` with `node_kind:"contact"`: a resolved contact
  ///      note (`chan.kind: contact` frontmatter). Navigates to its
  ///      contact-scoped lens (or the host's canvas selection).
  ///   2. `kind:"mention"`: an unresolved `@@name` with no contact file
  ///      on disk yet. Opens the workspace graph with the mention node
  ///      pre-selected, matching FileInfoBody's unresolved-mention arm.
  /// Loading the graph is cheap + shared: `graphData` is a global cache,
  /// and FileInfoBody already triggers the same load for any file's refs.
  $effect(() => {
    void ensureGraphLoaded();
  });

  type ContactPill = {
    key: string;
    label: string;
    path: string | null;
    onClick: () => void;
  };
  const contactPills = $derived.by<ContactPill[]>(() => {
    const view = graphData.view;
    if (!view) return [];
    const navigateContact = onContactNavigate
      ? (p: string) => onContactNavigate(p)
      : (p: string) => openGraphForContact(p);
    const out: ContactPill[] = [];
    const seen = new Set<string>();
    for (const n of view.nodes) {
      if (n.kind === "file" && n.node_kind === "contact" && !n.missing) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push({
          key: n.id,
          label: n.label,
          path: n.path,
          onClick: () => navigateContact(n.path),
        });
      } else if (n.kind === "mention") {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        const id = n.id;
        out.push({
          key: id,
          label: n.label.replace(/^@@/, ""),
          path: null,
          onClick: () => openGraphAtNode(id),
        });
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  });

  /// COCOMO formatting helpers; identical shape to FileInfoBody so the
  /// dir-mode and workspace-root inspectors format the same way.
  function fmtMonths(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return n >= 10 ? `${Math.round(n)} mo` : `${n.toFixed(1)} mo`;
  }
  function fmtDevs(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return n >= 10 ? `${Math.round(n)}` : n.toFixed(1);
  }

</script>

<div class="info">
  <header class="head">
    <span class="kind-chip workspace">workspace</span>
  </header>
  <h3 class="title" title={workspace.info?.root}>
    {workspace.info?.label ?? "(workspace)"}
  </h3>
  <div class="meta-grid">
    <span class="k">directory</span>
    <span class="v mono path" title={workspace.info?.root}>{workspace.info?.root ?? ""}</span>
  </div>

  {#if variant === "inspector"}
    <!-- Workspace-root action row, mirroring FileInfoBody's is_dir branch on
         the workspace ROOT (relative path ""). An "Open" primary action plus
         a dropdown: Upload file here / Download tarball / New terminal here /
         Graph from here. "Graph from here" is gated on the host callback. -->
    <div class="actions-section">
      <InspectorActionPill
        main={actionModel.main}
        secondary={actionModel.secondary}
      />
    </div>
    <input
      bind:this={uploadInput}
      class="file-picker"
      type="file"
      multiple
      onchange={onUploadPicked}
      aria-hidden="true"
      tabindex="-1"
    />
  {/if}

  <!-- Folder-mode parity with FileInfoBody: same aggregate stats grid,
       file-kind counts, and code report a regular folder inspector
       renders. Subtree counts prefer the server-side InspectorPayload
       (authoritative for the whole workspace) and fall back to the
       loaded tree walk while the request is in flight. -->
  <div class="meta-grid">
    <span class="k">files</span>
    <span class="v">{subtree?.files ?? dirStats.files}</span>
    <span class="k">subdirectories</span>
    <span class="v">{subtree?.directories ?? dirStats.dirs}</span>
    <span class="k">size</span>
    <span class="v">{formatSize(subtree?.bytes ?? dirStats.bytes)}</span>
    <span class="k">last change</span>
    <span class="v">{formatMtime(dirStats.latest)}</span>
  </div>
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
                onclick={() => onLanguageClick(lang.name)}
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

  <!-- Contacts section, mirroring FileInfoBody's contact pill list.
       Renders in both variants whenever the workspace graph holds
       contact / mention nodes so the workspace root reads like any
       other folder inspector. -->
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

</div>

<style>
  .info {
    padding: 0.6rem 0.7rem 0.8rem 0.7rem;
    font-size: 12.5px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  /* Workspace kind chip: black bg, white text. Sits alongside the
     existing doc / image / contact / view-only chips defined in
     FileInfoBody so the inspector's per-kind cue is consistent
     across selections. */
  .kind-chip {
    color: #fff;
    text-transform: uppercase;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 3px;
    flex: 1;
    text-align: center;
  }
  .kind-chip.workspace {
    /* Match the graph canvas workspace-root fill (theme.bgCard) so the
       root chip and the root node read the same colour. */
    background: var(--bg-card);
    color: #fff;
  }
  .title {
    margin: 0 0 0.5rem 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
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
  .meta-grid .v.path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  /* Spacing wrapper for the workspace-root action pill; InspectorActionPill
     owns the pill + dropdown styling itself. */
  .actions-section {
    margin: 0.6rem 0 0.2rem 0;
  }
  .file-picker {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .refs { margin: 0.8rem 0 0 0; }
  .refs h4 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0 0 0.25rem 0;
  }
  /* Contacts pill list, mirroring FileInfoBody's `.refs ul` +
     `.ref.contact` so the workspace inspector's contacts read
     identically to a file inspector's. */
  .refs ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .refs li { margin: 0; }
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
  /* Contact rows: same block-button shape with a small person
     silhouette prefixed in --warn-text so a glance tells you the
     entry is a person rather than a generic doc. Icon matches the
     editor wiki pill + FileInfoBody contact rows. */
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
  /* Folder-parity sections (file kinds + code report). Visual style
     mirrors FileInfoBody so the workspace inspector and a regular
     folder inspector read as one feature. */
  .compact-section { margin-top: 0.35rem; }
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
     this language). Strip default button chrome, left-align, add
     hover + focus affordance. Stays a grid cell at column 1. Mirrors
     FileInfoBody's `.lang-name`. */
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
  .refs-loading,
  .refs-error {
    color: var(--text-secondary);
    font-size: 13px;
    margin-top: 0.6rem;
    font-style: italic;
  }
  .refs-error { color: var(--warn-text); font-style: normal; }
</style>
