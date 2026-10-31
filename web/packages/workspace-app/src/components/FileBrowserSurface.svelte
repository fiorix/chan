<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Folder, FolderOpen, HardDrive, ListFilter, PanelLeftOpen, PanelRightOpen, Plus, Search, X } from "@lucide/svelte";
  import FileTree from "./FileTree.svelte";
  import Inspector from "./Inspector.svelte";
  import FileInfoBody from "./FileInfoBody.svelte";
  import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
  import DraftsGroup from "./DraftsGroup.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";
  import { tabMenu } from "../state/tabMenu.svelte";
  import { chordFor } from "../state/shortcuts";
  import { basename, parentDir } from "../state/format";
  import { browserDirectoryInput, type BrowserSort } from "../state/browserEntries";
  import { browserKeys, setBrowserVim } from "../state/browserKeys.svelte";
  import { browserBindings, browserCommandChord, type BrowserCommand } from "../state/browserKeymap";
  import { openMediaViewer } from "../state/mediaOpen";
  import { windowCaps } from "../state/windowCaps";
  import {
    browserSelection, browserSidePanes, ensureFbTreeInstance, fbActivateInstance,
    fbTreeInstance, fbSelectSet, fbSelectSingle, clearTreeDirError, loadTreeDir,
    openFsGraphForDirectory, openFsGraphForFile, openGraphForContact, openGraphForLanguage,
    paneWidths, persistPaneWidths, schedulePersistStateToHash, scheduleSessionSave,
    seedFbTreeInstanceFromReloadSnapshot, surfaceThemeOverride, toggleBrowserSidePane, tree, workspace,
  } from "../state/store.svelte";
  import { openBrowserInActivePane, openInActivePane, openTerminalInActivePane } from "../state/tabs.svelte";
  import type { BrowserTab } from "../state/tabs.svelte";
  import { terminalFromHereTarget } from "../terminal/fromHere";
  import { fbWatchRegister, fbWatchReconcile, fbWatchDispose } from "../state/fbWatch.svelte";

  let { variant, side, tab, onClose, onFlip }: {
    variant: "dock" | "tab";
    side?: "left" | "right";
    tab?: BrowserTab;
    onClose?: () => void;
    onFlip?: () => void;
  } = $props();

  const isTab = $derived(variant === "tab");
  const instanceId = $derived(isTab && tab ? `fb-tab-${tab.id}` : `fb-dock-${side ?? "left"}`);
  const selection = $derived(fbTreeInstance(instanceId)?.selection ?? browserSelection);
  const dockState = $state({ inspectorOpen: false, inspectorWidth: undefined as number | undefined });
  const browserState = $derived(tab ?? dockState);
  let directory = $state("");
  let filter = $state("");
  let sort = $state<BrowserSort>("name");
  let descending = $state(false);
  let showHidden = $state(true);
  let selectionMode = $state(false);
  let itemCount = $state(0);
  let helpOpen = $state(false);
  let pathEditing = $state(false);
  let pathInput = $state("");
  let findOpen = $state(false);
  let findCount = $state({ total: 0, current: -1 });
  let history = $state<string[]>([""]);
  let historyIndex = $state(0);
  const visits = new Map<string, { path: string | null; paths: string[]; scroll: number }>();
  let treeRef: FileTree | undefined = $state();
  let treeWrapEl: HTMLDivElement | undefined = $state();
  let findInputEl: HTMLInputElement | undefined = $state();
  let pathInputEl: HTMLInputElement | undefined = $state();
  let menu: HamburgerMenu | undefined = $state();
  let menuOpen = $state(false);

  const crumbs = $derived(directory.split("/").filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") })));
  const rootFolders = $derived(tree.entries.filter((entry) => entry.is_dir && parentDir(entry.path) === "" && (showHidden || !basename(entry.path).startsWith("."))).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })));
  const previewPath = $derived(selection.path ?? directory);

  function activate(): void { fbActivateInstance(instanceId); }
  function persist(): void { schedulePersistStateToHash(); scheduleSessionSave(); }

  $effect(() => {
    const id = instanceId;
    const current = tab;
    untrack(() => {
      fbWatchRegister(id);
      const inst = ensureFbTreeInstance(id);
      if (current) {
        const selected = current.directory !== undefined && current.selected === current.directory ? undefined : current.selected;
        inst.selection.path = selected ?? null;
        inst.selection.paths = selected ? current.selectedPaths ? [...current.selectedPaths] : [selected] : [];
        inst.selection.anchor = selected ?? null;
        inst.selection.showWorkspace = current.showWorkspace ?? false;
        for (const path of current.expanded ?? []) inst.expanded[path] = true;
        directory = current.directory ?? parentDir(current.selected ?? "");
        sort = current.browserSort ?? "name";
        descending = current.browserDescending ?? false;
        history = [directory]; historyIndex = 0;
        void tick().then(() => {
          if (treeWrapEl) treeWrapEl.scrollTop = current.scroll ?? 0;
          treeRef?.focusTree();
        });
      }
    });
    return () => untrack(() => fbWatchDispose(id));
  });

  let dockSeeded = false;
  $effect(() => {
    if (isTab || dockSeeded || !workspace.info?.root) return;
    untrack(() => seedFbTreeInstanceFromReloadSnapshot(instanceId));
    dockSeeded = true;
  });

  $effect(() => {
    const id = instanceId;
    const inst = fbTreeInstance(id);
    if (!inst) return;
    const dirs = isTab ? [directory] : Object.keys(inst.expanded).filter((path) => inst.expanded[path]);
    untrack(() => fbWatchReconcile(id, dirs));
  });

  $effect(() => {
    if (!isTab) return;
    const path = directory;
    if (tree.loading || tree.rootUnavailable || !tree.loadedDirs[""] || tree.loadedDirs[path] || tree.loadingDirs[path] || tree.dirErrors[path]) return;
    untrack(() => { void loadTreeDir(path).catch(() => {}); });
  });

  $effect(() => {
    if (!tab) return;
    const current = tab;
    const path = selection.path;
    const paths = [...selection.paths];
    const showWorkspace = selection.showWorkspace;
    const expanded = Object.entries(fbTreeInstance(instanceId)?.expanded ?? {}).filter(([path, open]) => path && open).map(([path]) => path);
    const dir = directory;
    const order = sort;
    const reverse = descending;
    untrack(() => {
      current.selected = path ?? undefined;
      current.selectedPaths = paths;
      current.showWorkspace = showWorkspace || undefined;
      current.expanded = expanded.length ? expanded : undefined;
      current.directory = dir;
      current.browserSort = order;
      current.browserDescending = reverse;
      persist();
    });
  });

  $effect(() => {
    if (!isTab && findOpen) treeRef?.setFindQuery(filter, (total, current) => { findCount = { total, current }; });
  });

  $effect(() => {
    if (!isTab || !tab || tabMenu.openForTabId !== tab.id || !tabMenu.anchor) return;
    const anchor = tabMenu.anchor;
    queueMicrotask(() => menu?.openAtCursor(anchor.left, anchor.top));
  });

  $effect(() => {
    const path = selection.path;
    if (!isTab || !path) return;
    untrack(() => {
      const parent = parentDir(path);
      if (parent === directory || path === directory) return;
      // A completed rename, move or create can reveal an entry in another folder.
      // Update its owning surface without taking focus from a different pane.
      remember();
      directory = parent;
      filter = "";
      history = [...history.slice(0, historyIndex + 1), parent];
      historyIndex = history.length - 1;
    });
  });

  function remember(): void {
    visits.set(directory, { path: selection.path, paths: [...selection.paths], scroll: treeWrapEl?.scrollTop ?? 0 });
  }

  function navigate(path: string, selected?: string, addHistory = true): void {
    activate();
    if (path === directory) return;
    const previous = directory;
    remember();
    directory = path;
    filter = "";
    pathEditing = false;
    selectionMode = false;
    selection.showWorkspace = false;
    const visit = visits.get(path);
    const cursor = selected ?? visit?.path ?? (parentDir(previous) === path ? previous : null);
    fbSelectSet(selected ? [selected] : visit?.paths ?? (cursor ? [cursor] : []), cursor ?? undefined, selection);
    if (addHistory) { history = [...history.slice(0, historyIndex + 1), path]; historyIndex = history.length - 1; }
    void tick().then(() => {
      if (treeWrapEl) treeWrapEl.scrollTop = visit?.scroll ?? 0;
      treeRef?.focusTree();
    });
  }

  function historyStep(delta: number): void {
    const index = historyIndex + delta;
    if (index < 0 || index >= history.length) return;
    navigate(history[index], undefined, false);
    historyIndex = index;
  }

  function openFind(): void { findOpen = true; void tick().then(() => findInputEl?.focus()); }
  function closeFind(): void { findOpen = false; filter = ""; treeRef?.clearFind(); treeRef?.focusTree(); }
  function editPath(): void { pathInput = directory ? `${workspace.info?.root?.replace(/\/$/, "") ?? ""}/${directory}` : workspace.info?.root ?? "/"; pathEditing = true; void tick().then(() => { pathInputEl?.focus(); pathInputEl?.select(); }); }
  function changeSort(column: BrowserSort): void { if (sort === column) descending = !descending; else { sort = column; descending = false; } }
  function toggleDetails(): void { browserState.inspectorOpen = !browserState.inspectorOpen; persist(); }
  function closeDetails(): void { browserState.inspectorOpen = false; persist(); treeRef?.focusTree(); }
  function run(command: BrowserCommand): void { treeRef?.runCommand(command); menu?.close(); }
  function onScroll(): void { if (tab && treeWrapEl) tab.scroll = Math.round(treeWrapEl.scrollTop); }
  function onInspectorResize(): void { persistPaneWidths(); persist(); }
  function onBrowserKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    const editable = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]");
    if (isTab && !editable && e.altKey && !e.ctrlKey && !e.metaKey && ["ArrowLeft", "ArrowRight", "ArrowUp"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "ArrowUp") navigate(parentDir(directory));
      else historyStep(e.key === "ArrowLeft" ? -1 : 1);
    }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.altKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); openFind(); }
    else if (e.key === "Escape" && helpOpen) { e.preventDefault(); e.stopPropagation(); helpOpen = false; treeRef?.focusTree(); }
  }
  function onBrowserContextMenu(e: MouseEvent): void {
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]")) return;
    e.preventDefault(); activate(); menu?.openAtCursor(e.clientX, e.clientY);
  }
  export function openMenuAtCursor(x: number, y: number): void { activate(); menu?.openAtCursor(x, y); }
  function openSelected(): void {
    const path = previewPath;
    if (tree.entries.find((entry) => entry.path === path)?.is_dir) { navigate(path); return; }
    if (path && !openMediaViewer(path)) void openInActivePane(path, { landAtTop: true });
  }
  function graphSelection(): void { if (!previewPath || tree.entries.find((entry) => entry.path === previewPath)?.is_dir) openFsGraphForDirectory(previewPath); else openFsGraphForFile(previewPath); }
  function showWorkspaceInfo(): void {
    menu?.close();
    fbSelectSingle(null, selection);
    selection.showWorkspace = true;
    if (isTab) browserState.inspectorOpen = true;
    else {
      const target = openBrowserInActivePane();
      target.showWorkspace = true;
      target.inspectorOpen = true;
    }
    persist();
  }
  function openCurrentInFileBrowser(): void {
    menu?.close();
    const path = selection.path;
    const target = openBrowserInActivePane(path ? { select: path } : {});
    target.directory = path && tree.entries.find((entry) => entry.path === path)?.is_dir ? path : parentDir(path ?? "");
  }
</script>

<div class="browser" class:dock={!isTab} data-theme={isTab ? surfaceThemeOverride("browser") : undefined} onfocusin={activate} onpointerdown={activate} oncontextmenu={onBrowserContextMenu} onkeydown={onBrowserKeydown} role="presentation">
  <div class="browser-toolbar">
    {#if isTab}
      <div class="navigation" aria-label="Directory navigation" role="group">
        <button title="Back" aria-label="Back" disabled={historyIndex === 0} onclick={() => historyStep(-1)}><ArrowLeft size={16} /></button>
        <button title="Forward" aria-label="Forward" disabled={historyIndex === history.length - 1} onclick={() => historyStep(1)}><ArrowRight size={16} /></button>
        <button title="Parent directory" aria-label="Parent directory" disabled={!directory} onclick={() => navigate(parentDir(directory))}><ArrowUp size={16} /></button>
      </div>
      {#if pathEditing}
        <input class="path-input" aria-label="Directory path" bind:this={pathInputEl} bind:value={pathInput} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); navigate(browserDirectoryInput(pathInput, workspace.info?.root ?? "")); pathEditing = false; treeRef?.focusTree(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); pathEditing = false; treeRef?.focusTree(); } }} />
      {:else}
        <nav class="breadcrumbs" aria-label="Breadcrumbs">
          <button onclick={() => navigate("")} title={workspace.info?.root}><HardDrive size={15} /><span>{workspace.info?.label || "Files"}</span></button>
          {#each crumbs as crumb (crumb.path)}<ChevronRight size={12} /><button aria-current={crumb.path === directory ? "location" : undefined} onclick={() => navigate(crumb.path)}>{crumb.name}</button>{/each}
        </nav>
        <button class="path-button" onclick={editPath} title="Enter directory path" aria-label="Enter directory path">/</button>
      {/if}
    {:else}<span class="dock-title"><FolderOpen size={15} />Files</span>{/if}
    {#if isTab || findOpen}
      <div class="filter-field"><Search size={14} /><input bind:this={findInputEl} bind:value={filter} placeholder={isTab ? "Filter this folder" : "Find visible files"} aria-label={isTab ? "Filter this folder" : "Find visible files"} onkeydown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); } else if (e.key === "Enter") { e.preventDefault(); if (isTab) treeRef?.focusTree(); else treeRef?.findStep(e.shiftKey ? -1 : 1); } }} />{#if filter}<button aria-label="Clear filter" onclick={() => { filter = ""; findInputEl?.focus(); }}><X size={12} /></button>{/if}</div>
    {:else}<button title="Find visible files" aria-label="Find visible files" onclick={openFind}><ListFilter size={16} /></button>{/if}
    {#if isTab}
      <button class="new-button" onclick={() => run("new")}><Plus size={15} /><span>New</span></button>
      <button aria-label="Toggle details" title="Details (Mod+Y)" aria-pressed={browserState.inspectorOpen} onclick={toggleDetails}><PanelRightOpen size={16} /></button>
    {/if}
    <HamburgerMenu keyboardNavigation bind:this={menu} bind:open={menuOpen} width={260} height={520}>
      <li><button role="menuitem" onclick={() => run("new")}>New file or directory</button></li>
      <li><button role="menuitem" onclick={() => run("upload")}>Upload files</button></li>
      <li><button role="menuitem" disabled={!selection.path} onclick={() => run("menu")}>Selection actions <span class="chord">Shift+F10</span></button></li>
      <li><button role="menuitemcheckbox" aria-checked={selectionMode} onclick={() => { selectionMode = !selectionMode; menu?.close(); treeRef?.focusTree(); }}>Select multiple <span class="chord">{browserKeys.vim ? "v" : "F8"}</span></button></li>
      <li class="sep" role="separator"></li>
      {#if isTab}<li><button role="menuitemcheckbox" aria-checked={showHidden} onclick={() => { showHidden = !showHidden; menu?.close(); }}>Show hidden files</button></li>{/if}
      <li><button role="menuitemcheckbox" aria-checked={browserKeys.vim} onclick={() => { setBrowserVim(!browserKeys.vim); menu?.close(); }}>Vim keyboard navigation</button></li>
      <li><button role="menuitem" onclick={() => { helpOpen = !helpOpen; menu?.close(); }}>Keyboard shortcuts</button></li>
      <li class="sep" role="separator"></li>
      {#if !isTab}<li><button role="menuitem" onclick={openCurrentInFileBrowser}>Open in File Browser</button></li>{/if}
      <li><button role="menuitem" onclick={showWorkspaceInfo}>Workspace details</button></li>
      <li><button role="menuitem" onclick={() => { toggleBrowserSidePane("left"); menu?.close(); }}><PanelLeftOpen size={15} />{browserSidePanes.left ? "Unstick left" : "Stick to left"}</button></li>
      <li><button role="menuitem" onclick={() => { toggleBrowserSidePane("right"); menu?.close(); }}><PanelRightOpen size={15} />{browserSidePanes.right ? "Unstick right" : "Stick to right"}</button></li>
      {#if isTab}<li><button role="menuitem" onclick={() => { menu?.close(); onClose?.(); }}>Close <span class="chord">{chordFor("app.tab.close") ?? ""}</span></button></li>{/if}
    </HamburgerMenu>
  </div>
  {#if helpOpen}
    <section class="keyboard-help" aria-label="File browser keyboard shortcuts">
      <div><strong>{browserKeys.vim ? "Vim" : "Standard"} navigation</strong><button aria-label="Close keyboard shortcuts" onclick={() => { helpOpen = false; treeRef?.focusTree(); }}><X size={14} /></button></div>
      <p>Mod is Command on macOS, Control elsewhere. Shift extends selection. F8 enables independent marks; Space toggles a mark. Tab leaves the file list.</p>
      <dl>{#each Object.keys(browserBindings) as command}<div><dt>{command.replace(/([A-Z])/g, " $1")}</dt><dd><kbd>{browserCommandChord(command as BrowserCommand, browserKeys.vim)}</kbd></dd></div>{/each}</dl>
    </section>
  {/if}
  <div class="body">
    {#if isTab}
      <aside class="locations" aria-label="File locations">
        <div class="rail-label">Locations</div>
        <button class:current={!directory} onclick={() => navigate("")}><HardDrive size={15} /><span>{workspace.info?.label || "Filesystem"}</span></button>
        <DraftsGroup />
        <div class="rail-label">Folders</div>
        {#each rootFolders as folder (folder.path)}<button class:current={directory === folder.path || directory.startsWith(`${folder.path}/`)} title={folder.path} onclick={() => navigate(folder.path)}><Folder size={15} /><span>{basename(folder.path)}</span></button>{/each}
      </aside>
    {/if}
    <div class="file-area">
      {#if isTab}
        <div class="column-headings" role="group" aria-label="Sort directory">
          {#each [{ key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "size", label: "Size" }, { key: "modified", label: "Modified" }] as column}<button class={column.key} aria-label={`Sort by ${column.label}${sort === column.key ? descending ? ", descending" : ", ascending" : ""}`} onclick={() => changeSort(column.key as BrowserSort)}>{column.label}{#if sort === column.key}<span aria-hidden="true">{descending ? "v" : "^"}</span>{/if}</button>{/each}
        </div>
      {/if}
      <div class="tree-wrap" bind:this={treeWrapEl} onscroll={onScroll}>
        <FileTree bind:this={treeRef} {instanceId} view={isTab ? "list" : "tree"} {directory} {filter} {sort} {descending} {showHidden} bind:selectionMode dockSide={isTab ? undefined : side} onFlip={isTab ? onFlip : undefined} onNavigate={navigate} onPreview={isTab ? toggleDetails : openCurrentInFileBrowser} onFind={openFind} onCount={(count) => (itemCount = count)} />
        {#if isTab && tree.dirErrors[directory]}<button class="retry" onclick={() => { clearTreeDirError(directory); void loadTreeDir(directory).catch(() => {}); }}>Retry loading this folder</button>{/if}
      </div>
    </div>
    {#if isTab && browserState.inspectorOpen}
      <Inspector floating reserveSpace title="Details" bind:width={() => browserState.inspectorWidth ?? paneWidths.browser, (v) => (browserState.inspectorWidth = v)} onResize={onInspectorResize} onClose={closeDetails}>
        {#if selection.showWorkspace && !selection.path}
          <WorkspaceInfoBody onSetAsScope={windowCaps.workspace ? () => openFsGraphForDirectory("") : undefined} onLanguageClick={openGraphForLanguage} onContactNavigate={openGraphForContact} />
        {:else}
          <FileInfoBody path={previewPath} onOpen={openSelected} onSetAsScope={windowCaps.workspace ? graphSelection : undefined} onNewTerminal={() => openTerminalInActivePane(terminalFromHereTarget(previewPath, !previewPath || tree.entries.find((entry) => entry.path === previewPath)?.is_dir === true))} showRefs onNavigate={(path) => { void openInActivePane(path); }} />
        {/if}
      </Inspector>
    {/if}
  </div>
  <footer class="browser-status">
    <span aria-live="polite">{itemCount} {itemCount === 1 ? "item" : "items"}{filter ? " shown" : ""} / {selection.paths.length} selected</span>
    {#if selectionMode}<button class="selection-mode" onclick={() => { selectionMode = false; treeRef?.focusTree(); }}>Selection mode <X size={12} /></button>{/if}
    {#if !isTab && findOpen && filter}<span>{findCount.current + 1} of {findCount.total}</span>{/if}
    <button class="keyboard-status" onclick={() => (helpOpen = !helpOpen)}>{browserKeys.vim ? "Vim" : "Standard"} keys</button>
  </footer>
</div>

<style>
  .browser { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; background: var(--bg); color: var(--text); container-type: inline-size; }
  button { display: inline-flex; align-items: center; gap: 7px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; padding: 5px 7px; }
  button:hover { color: var(--text); background: var(--hover-bg); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--focus-color, var(--link)); outline-offset: -2px; }
  button:disabled { opacity: .4; cursor: default; }
  button[aria-pressed="true"] { background: var(--accent-bg, var(--hover-bg)); color: var(--text); }
  .browser-toolbar { display: flex; align-items: center; gap: 6px; min-height: 45px; padding: 5px 10px; border-bottom: 1px solid var(--border); font-size: 12px; flex-wrap: wrap; }
  .navigation { display: flex; gap: 1px; }
  .breadcrumbs { display: flex; align-items: center; flex: 1; min-width: 100px; overflow: auto; white-space: nowrap; scrollbar-width: thin; }
  .breadcrumbs button { flex-shrink: 0; }
  .breadcrumbs button[aria-current] { color: var(--text); }
  .filter-field { display: flex; align-items: center; gap: 5px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; padding: 0 6px; width: 175px; color: var(--text-secondary); }
  input { min-width: 0; background: transparent; border: 0; color: var(--text); font: inherit; padding: 6px 2px; }
  .filter-field input { width: 100%; }
  .path-input { flex: 1; border: 1px solid var(--border); border-radius: 4px; padding: 6px; }
  .path-button { font-family: monospace; }
  .body { display: flex; position: relative; flex: 1; min-height: 0; min-width: 0; }
  .locations { width: 160px; flex-shrink: 0; overflow: auto; padding: 12px 8px; border-right: 1px solid var(--border); background: var(--bg-card); }
  .rail-label { text-transform: uppercase; font-size: 10px; letter-spacing: .09em; font-weight: 600; color: var(--text-secondary); padding: 10px 8px 5px; }
  .locations > button { width: 100%; min-height: 30px; font-size: 12px; text-align: left; }
  .locations > button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .locations .current { background: var(--hover-bg); color: var(--text); }
  .file-area { container-type: inline-size; display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; }
  .column-headings { display: grid; grid-template-columns: minmax(148px, 1fr) 82px 80px 136px; gap: 10px; padding: 5px 22px; border-bottom: 1px solid var(--border); font-size: 11px; }
  .column-headings button { justify-content: space-between; padding: 3px 0; }
  .column-headings .size { justify-content: flex-end; }
  /* The scroller is positioned so the list's relatively positioned box (the
     rubber band's anchor) belongs to it: left static, the pane card counts
     the whole list as its own overflow, and WebKit scrolls the card to a
     focused row, taking the tab strip and the Details header out of view. */
  .tree-wrap { position: relative; overflow: auto; flex: 1; min-height: 0; min-width: 0; padding: 3px 0; }
  .browser-status { display: flex; align-items: center; gap: 10px; min-height: 31px; padding: 0 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-secondary); }
  .keyboard-status { margin-left: auto; white-space: nowrap; }
  .selection-mode { color: var(--text); background: var(--accent-bg, var(--hover-bg)); }
  .dock-title { display: flex; align-items: center; gap: 7px; font-weight: 600; flex: 1; }
  .dock .browser-toolbar { min-height: 36px; padding: 3px 7px; }
  .dock .filter-field { order: 2; width: 100%; }
  .dock .browser-status { padding: 0 6px; flex-wrap: wrap; gap: 3px; }
  .keyboard-help { padding: 12px 16px; border-bottom: 1px solid var(--border); max-height: 260px; overflow: auto; font-size: 12px; }
  .keyboard-help > div { display: flex; align-items: center; justify-content: space-between; }
  .keyboard-help p { color: var(--text-secondary); line-height: 1.5; }
  .keyboard-help dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 5px 20px; }
  .keyboard-help dl > div { display: flex; justify-content: space-between; }
  .keyboard-help dt { text-transform: capitalize; }
  .keyboard-help dd { margin: 0; }
  .chord { margin-left: auto; color: var(--text-secondary); font-size: 11px; }
  .sep { border-top: 1px solid var(--border); margin: 4px 0; }
  .retry { margin: 10px; color: var(--link); }
  @container (max-width: 900px) { .locations { display: none; } }
  @container (max-width: 700px) { .column-headings { grid-template-columns: minmax(128px, 1fr) 80px; } .column-headings .kind, .column-headings .modified { display: none; } .filter-field { width: 130px; } .new-button span { display: none; } }
</style>
