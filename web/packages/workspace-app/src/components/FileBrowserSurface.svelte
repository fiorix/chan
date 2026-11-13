<script lang="ts">
  import { tick, untrack } from "svelte";
  import { ArrowLeft, ArrowRight, ArrowUp, Check, ChevronRight, Folder, FolderOpen, HardDrive, ListFilter, PanelLeftOpen, PanelRightOpen, Plus, Search, X } from "@lucide/svelte";
  import FileTree from "./FileTree.svelte";
  import Inspector from "./Inspector.svelte";
  import FileInfoBody from "./FileInfoBody.svelte";
  import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
  import DraftsGroup from "./DraftsGroup.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";
  import { settingEntry } from "./settings/settingsIndex";
  import { tabMenu } from "../state/tabMenu.svelte";
  import { chordFor, shortcutLabel } from "../state/shortcuts";
  import { commandState, commandTitle } from "../state/commands";
  import "../state/commands/install";
  import { commandSurfaceId } from "../state/commands/browser";
  import { browserView, dropBrowserView, setBrowserView, toggleBrowserDetails, toggleBrowserView } from "../state/browserView.svelte";
  import { basename, parentDir } from "../state/format";
  import { browserDirectoryInput, type BrowserSort } from "../state/browserEntries";
  import { browserKeys } from "../state/browserKeys.svelte";
  import { browserBindings, browserCommandChord, type BrowserCommand } from "../state/browserKeymap";
  import { openMediaViewer } from "../state/mediaOpen";
  import { windowCaps } from "../state/windowCaps";
  import {
    browserSelection, ensureFbTreeInstance, fbActivateInstance,
    fbTreeInstance, fbSelectSet, fbSelectSingle, clearTreeDirError, loadTreeDir,
    openCommandLauncherFromMenu, openFsGraphForDirectory, openFsGraphForFile, openGraphForContact, openGraphForLanguage,
    paneWidths, persistPaneWidths, revealPathInBrowser, schedulePersistStateToHash, scheduleSessionSave,
    seedFbTreeInstanceFromReloadSnapshot, surfaceThemeOverride, toggleBrowserSidePane, tree, workspace,
  } from "../state/store.svelte";
  import { activeBrowserTab, defaultBrowserInspectorOpen, openBrowserInActivePane, openInActivePane, openTerminalInActivePane, tabFocusPulse } from "../state/tabs.svelte";
  import type { BrowserTab } from "../state/tabs.svelte";
  import { terminalFromHereTarget } from "../terminal/fromHere";
  import { fbWatchRegister, fbWatchReconcile, fbWatchDispose } from "../state/fbWatch.svelte";

  let { variant, side, tab, focused = false, onClose, onFlip }: {
    variant: "dock" | "tab";
    side?: "left" | "right";
    tab?: BrowserTab;
    /// A tab's pane is the focused one; gates when its tree takes the keyboard.
    focused?: boolean;
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
  // Hidden files, marking and the key list are switches the command catalog
  // flips too, so they live in the view registry under this surface's id.
  const viewState = $derived(browserView(instanceId));
  let itemCount = $state(0);
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
  const rootFolders = $derived(tree.entries.filter((entry) => entry.is_dir && parentDir(entry.path) === "" && (viewState.showHidden || !basename(entry.path).startsWith("."))).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })));
  const previewPath = $derived(selection.path ?? directory);

  /// A tab's Details panel. The toolbar button, the menu's row, the key that
  /// previews the selection and the catalog command all flip it. A dock draws
  /// no panel, and the command acts on the active tab, which a dock is not,
  /// so a dock has neither the button nor the row.
  const DETAILS = "app.browser.details";
  /// The catalog command a file browser key runs, where the catalog has one.
  /// The key list words those keys by the command's title; the other keys
  /// move the cursor or the selection and keep their own words. The key that
  /// previews the selection shows a tab's Details; a dock has none, and opens
  /// the selection in a tab instead.
  const keyCommands = $derived<Partial<Record<BrowserCommand, string>>>({
    open: "app.browser.open",
    rename: "app.browser.renameSelection",
    copy: "app.browser.copySelection",
    cut: "app.browser.cutSelection",
    paste: "app.browser.pasteSelection",
    delete: "app.browser.deleteSelection",
    selectMode: "app.browser.selectMultiple",
    preview: isTab ? DETAILS : "app.browser.openInBrowser",
  });
  /// The row that opens the tree's row menu on the selection. Every row of
  /// that menu takes its words from a catalog command, so this one, which
  /// has none, writes its words here, once, for the menu and the key list.
  const SELECTION_ACTIONS = "Selection actions";
  const DOCKS = [
    { side: "left", command: "app.browser.toggleLeftDock", icon: PanelLeftOpen },
    { side: "right", command: "app.browser.toggleRightDock", icon: PanelRightOpen },
  ] as const;
  const HELP_KEYS = Object.keys(browserBindings) as BrowserCommand[];
  const VIM = settingEntry("browser.vim");
  // The launcher's own toggle is a chord with no catalog row, so its menu row
  // takes the shortcut table's words.
  const LAUNCHER = "app.launcher.toggle";
  const launcherLabel = shortcutLabel(LAUNCHER);

  function keyLabel(command: BrowserCommand): string {
    const id = keyCommands[command];
    if (id) return commandTitle(id);
    if (command === "menu") return SELECTION_ACTIONS;
    const words = command.replace(/([A-Z])/g, " $1").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function activate(): void { fbActivateInstance(instanceId); }
  function persist(): void { schedulePersistStateToHash(); scheduleSessionSave(); }

  // A dock's switches go with the dock, which is shown for as long as this
  // surface is mounted. A tab's outlast the surface, which a pane draws for
  // its active tab alone: the registry forgets them when the tab closes.
  $effect(() => {
    if (isTab) return;
    const id = instanceId;
    return () => untrack(() => dropBrowserView(id));
  });

  // The launcher's Open reaches this surface as a chan:command, because
  // entering a directory moves the surface's own location. Only the tab the
  // launcher targeted answers, with what Enter runs on its selection.
  $effect(() => {
    if (!isTab || !tab) return;
    const id = tab.id;
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent).detail?.name !== "app.browser.open") return;
      if (activeBrowserTab()?.id === id) run("open");
    };
    window.addEventListener("chan:command", onCommand);
    return () => window.removeEventListener("chan:command", onCommand);
  });

  // The launcher's Upload reaches this surface as a chan:command too, since
  // the directory it uploads into is the surface's own. The surface the
  // selection commands act on answers, a dock's included, with what its
  // menu's Upload row runs.
  $effect(() => {
    const id = instanceId;
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent).detail?.name !== "app.browser.uploadSelection") return;
      if (commandSurfaceId() === id) run("upload");
    };
    window.addEventListener("chan:command", onCommand);
    return () => window.removeEventListener("chan:command", onCommand);
  });

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
        });
      }
    });
    return () => untrack(() => fbWatchDispose(id));
  });

  // A tab's tree takes the keyboard when its pane becomes the focused one
  // (Next pane, Hybrid Nav's commit, a press on the pane), when the pane
  // shows it while focused (a tab switch, a fresh mount), and on a focus
  // pulse while focused, as the editors do. The `focused` gate keeps a tab in
  // a background pane, mounted by a session restore or Hybrid Nav's commit,
  // from taking it. The microtask runs after the pulse has parked the
  // keyboard on the body.
  $effect(() => {
    if (!isTab || !focused) return;
    tab;
    tabFocusPulse.value;
    queueMicrotask(() => {
      if (focused) treeRef?.focusTree();
    });
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
    if (viewState.selectionMode) setBrowserView(instanceId, { selectionMode: false });
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

  function closeHelp(): void { setBrowserView(instanceId, { helpOpen: false }); treeRef?.focusTree(); }
  function openCommandsFromMenu(e: MouseEvent): void {
    const row = e.currentTarget as Element;
    menu?.close();
    openCommandLauncherFromMenu(row, () => treeRef?.focusTree());
  }
  function openFind(): void { findOpen = true; void tick().then(() => findInputEl?.focus()); }
  function closeFind(): void { findOpen = false; filter = ""; treeRef?.clearFind(); treeRef?.focusTree(); }
  function editPath(): void { pathInput = directory ? `${workspace.info?.root?.replace(/\/$/, "") ?? ""}/${directory}` : workspace.info?.root ?? "/"; pathEditing = true; void tick().then(() => { pathInputEl?.focus(); pathInputEl?.select(); }); }
  function changeSort(column: BrowserSort): void { if (sort === column) descending = !descending; else { sort = column; descending = false; } }
  function toggleDetails(): void { toggleBrowserDetails(browserState); }
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
    else if (e.key === "Escape" && viewState.helpOpen) { e.preventDefault(); e.stopPropagation(); closeHelp(); }
  }
  // A press on the tab's own chrome (the toolbar, the status line, the space
  // under a short listing, and on WebKit a button, which a press does not
  // focus) leaves the keyboard on the body after the pane took focus; the
  // tree takes it back. A text selection keeps it there, so a copy copies
  // the text.
  function onBrowserClick(): void {
    if (!isTab || !focused) return;
    const holder = document.activeElement;
    if (holder !== null && holder !== document.body) return;
    if (window.getSelection()?.isCollapsed === false) return;
    treeRef?.focusTree();
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
  /// The dock's Open in new file browser: the selection in a tab of its own,
  /// inside a directory or in a file's folder with the file selected. The
  /// tab's Details follows the screen's width, as any new file browser's
  /// does, and with nothing selected the row opens one on the workspace root.
  function openCurrentInFileBrowser(): void {
    menu?.close();
    const path = selection.path;
    if (!path) { openBrowserInActivePane(); return; }
    revealPathInBrowser(path, {
      enter: tree.entries.find((entry) => entry.path === path)?.is_dir === true,
      inspectorOpen: defaultBrowserInspectorOpen(),
    });
  }
</script>

<div class="browser" class:dock={!isTab} data-theme={isTab ? surfaceThemeOverride("browser") : undefined} onfocusin={activate} onpointerdown={activate} onclick={onBrowserClick} oncontextmenu={onBrowserContextMenu} onkeydown={onBrowserKeydown} role="presentation">
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
      <button class="new-button" title={commandTitle("app.browser.newFsEntry")} aria-label={commandTitle("app.browser.newFsEntry")} onclick={() => run("new")}><Plus size={15} /><span>New</span></button>
      <button aria-label={commandTitle(DETAILS)} title={`${commandTitle(DETAILS)} (${browserCommandChord("preview", browserKeys.vim)})`} aria-pressed={browserState.inspectorOpen} onclick={toggleDetails}><PanelRightOpen size={16} /></button>
    {/if}
    <HamburgerMenu keyboardNavigation bind:this={menu} bind:open={menuOpen} width={260} height={600}>
      <li><button role="menuitem" onclick={() => run("new")}><span class="menu-row-label">{commandTitle("app.browser.newFsEntry")}</span></button></li>
      <li><button role="menuitem" onclick={() => run("upload")}><span class="menu-row-label">{commandTitle("app.browser.uploadSelection")}</span></button></li>
      <li><button role="menuitem" disabled={!selection.path} onclick={() => run("menu")}><span class="menu-row-label">{SELECTION_ACTIONS}</span><span class="chord">Shift+F10</span></button></li>
      {@render checkRow(commandTitle("app.browser.selectMultiple"), viewState.selectionMode, () => { toggleBrowserView(instanceId, "selectionMode"); menu?.close(); treeRef?.focusTree(); }, browserKeys.vim ? "v" : "F8")}
      <li class="sep" role="separator"></li>
      {#if isTab}{@render checkRow(commandTitle("app.browser.hiddenFiles"), viewState.showHidden, () => { toggleBrowserView(instanceId, "showHidden"); menu?.close(); })}{/if}
      {@render checkRow(VIM.label, VIM.read() === true, () => { void VIM.write?.(VIM.read() !== true); menu?.close(); })}
      {@render checkRow(commandTitle("app.browser.keyboardHelp"), viewState.helpOpen, () => { toggleBrowserView(instanceId, "helpOpen"); menu?.close(); })}
      {#if isTab}{@render checkRow(commandTitle(DETAILS), browserState.inspectorOpen, () => { toggleDetails(); menu?.close(); }, browserCommandChord("preview", browserKeys.vim))}{/if}
      <li class="sep" role="separator"></li>
      {#if !isTab}<li><button role="menuitem" onclick={openCurrentInFileBrowser}><span class="menu-row-label">{commandTitle("app.browser.openInBrowser")}</span></button></li>{/if}
      <li><button role="menuitem" onclick={showWorkspaceInfo}><span class="menu-row-label">{commandTitle("app.browser.showWorkspaceInfo")}</span></button></li>
      {#each DOCKS as dock (dock.side)}
        {@const docked = commandState(dock.command) === true}
        <li><button role="menuitemcheckbox" aria-checked={docked} onclick={() => { toggleBrowserSidePane(dock.side); menu?.close(); }}><dock.icon size={15} /><span class="menu-row-label">{commandTitle(dock.command)}</span>{#if docked}<Check size={14} strokeWidth={2} aria-hidden="true" />{/if}</button></li>
      {/each}
      {#if isTab && onFlip}<li><button role="menuitem" onclick={() => { menu?.close(); onFlip?.(); }}><span class="menu-row-label">{commandTitle("app.pane.flip")}</span><span class="chord">{chordFor("app.pane.flip") ?? ""}</span></button></li>{/if}
      {#if isTab}<li><button role="menuitem" onclick={() => { menu?.close(); onClose?.(); }}><span class="menu-row-label">{commandTitle("app.tab.close")}</span><span class="chord">{chordFor("app.tab.close") ?? ""}</span></button></li>{/if}
      <li class="sep" role="separator"></li>
      <li><button role="menuitem" onclick={openCommandsFromMenu}><span class="menu-row-label">{launcherLabel}</span><span class="chord">{chordFor(LAUNCHER) ?? ""}</span></button></li>
    </HamburgerMenu>
  </div>
  {#if viewState.helpOpen}
    <section class="keyboard-help" aria-label="File browser keyboard shortcuts">
      <div><strong>{browserKeys.vim ? "Vim" : "Standard"} navigation</strong><button aria-label="Close keyboard shortcuts" onclick={closeHelp}><X size={14} /></button></div>
      <p>Mod is Command on macOS, Control elsewhere. Shift extends selection. F8 enables independent marks; Space toggles a mark. Tab leaves the file list.</p>
      <dl>{#each HELP_KEYS as command (command)}<div><dt>{keyLabel(command)}</dt><dd><kbd>{browserCommandChord(command, browserKeys.vim)}</kbd></dd></div>{/each}</dl>
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
        <FileTree bind:this={treeRef} {instanceId} view={isTab ? "list" : "tree"} {directory} {filter} {sort} {descending} showHidden={viewState.showHidden} bind:selectionMode={() => viewState.selectionMode, (on) => setBrowserView(instanceId, { selectionMode: on })} dockSide={isTab ? undefined : side} onFlip={isTab ? onFlip : undefined} onNavigate={navigate} onPreview={isTab ? toggleDetails : openCurrentInFileBrowser} onFind={openFind} onCount={(count) => (itemCount = count)} />
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
    {#if viewState.selectionMode}<button class="selection-mode" onclick={() => { setBrowserView(instanceId, { selectionMode: false }); treeRef?.focusTree(); }}>Selection mode <X size={12} /></button>{/if}
    {#if !isTab && findOpen && filter}<span>{findCount.current + 1} of {findCount.total}</span>{/if}
    <button class="keyboard-status" onclick={() => toggleBrowserView(instanceId, "helpOpen")}>{browserKeys.vim ? "Vim" : "Standard"} keys</button>
  </footer>
</div>

{#snippet checkRow(label: string, on: boolean, toggle: () => void, chord = "")}
  <li><button role="menuitemcheckbox" aria-checked={on} onclick={toggle}><span class="menu-row-label">{label}</span>{#if on}<Check size={14} strokeWidth={2} aria-hidden="true" />{/if}{#if chord}<span class="chord">{chord}</span>{/if}</button></li>
{/snippet}

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
  .keyboard-help dd { margin: 0; }
  .chord { margin-left: auto; color: var(--text-secondary); font-size: 11px; }
  .sep { border-top: 1px solid var(--border); margin: 4px 0; }
  .retry { margin: 10px; color: var(--link); }
  @container (max-width: 900px) { .locations { display: none; } }
  @container (max-width: 700px) { .column-headings { grid-template-columns: minmax(128px, 1fr) 80px; } .column-headings .kind, .column-headings .modified { display: none; } .filter-field { width: 130px; } .new-button span { display: none; } }
</style>
