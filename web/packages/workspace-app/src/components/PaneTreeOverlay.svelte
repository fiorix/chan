<script lang="ts">
  // The pane tree: a dropdown at the window's top-left corner, under the
  // window tab bar's tree button when one is shown, listing every pane of
  // this window in reading order with each pane's A and B sides and their
  // tabs. A filter narrows the tabs by title; the arrow keys walk the tab
  // rows, Enter or a click shows a tab the way a press on it in its strip
  // does, and Escape closes.
  //
  // It is a non-modal popup with the command launcher's keyboard model: while
  // open it takes every key aimed at it or at the page body from the window's
  // capture phase, so no app chord fires behind it and no key reaches a
  // surface under it. Its own chord is answered here as well, from the
  // window's bubble phase, after the app's key handler on the document: that
  // handler stops the keys Hybrid Nav, a cover or a modal dialog takes, so
  // the chord never opens the tree over them.

  import { onMount, tick, untrack } from "svelte";
  import { deckPendingReturnFocus } from "@chan/web-shared/CommandDeck.svelte";
  import { canTakeFocus } from "@chan/web-shared/modal-focus";
  import {
    Blocks,
    ChartNoAxesColumn,
    CircleAlert,
    CircleCheck,
    CircleQuestionMark,
    FileText,
    Folder,
    KeyRound,
    Network,
    Pause,
    Search,
    Shapes,
    Shield,
    Terminal,
    User,
  } from "@lucide/svelte";
  import { menuEscape } from "./menuEscape";
  import {
    activatePaneTreeTab,
    closePaneTree,
    isBuiltInPaneTreeChord,
    isPaneTreeChord,
    openPaneTree,
    PANE_TREE_ANCHOR_ATTR,
    PANE_TREE_COMMAND_ID,
    paneRects,
    paneTree,
    paneTreeMayOpen,
    paneTreeModel,
    paneTreeRows,
    tabKindLabel,
    tabProgramMark,
    togglePaneTree,
    type PaneTreeTab,
  } from "../state/paneTree.svelte";
  import {
    activeTerminalTab,
    bumpTabFocusPulse,
    layout,
    panesHaveSides,
    tabTooltip,
    type BrowserLabelCtx,
    type Tab,
  } from "../state/tabs.svelte";
  import {
    appInputBlocked,
    keyboardOwnedAbovePanes,
    modalDialogOpen,
    tree,
    workspaceDisplayName,
  } from "../state/store.svelte";
  import { refocusRefused } from "../state/focusGuard";
  import { chordFor } from "../state/shortcuts";
  import { programSummary, programVisual } from "../state/programStatus";
  import { isExcalidraw } from "../state/fileTypes";

  const LIST_ID = "chan-pane-tree-list";
  const optionId = (index: number): string => `chan-pane-tree-option-${index}`;
  // The dropdown's width and its margin from the window's edges.
  const WIDTH = 420;
  const EDGE = 8;

  let panel: HTMLElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let query = $state("");
  let selectedKey: string | null = $state(null);
  let position = $state({ top: EDGE, left: EDGE });
  // The element that held the keyboard when the tree opened, which gets it
  // back when the tree closes without showing a tab.
  let returnFocus: HTMLElement | null = null;
  // Set when a pick closes the tree: the picked tab's surface takes the
  // keyboard through the focus pulse, so the close hands nothing back.
  let handedOff = false;

  // The strip's label context for a file browser tab, and its contact test
  // for a file tab's icon: both read the tree listing.
  const treeIsDir = $derived(new Map(tree.entries.map((entry) => [entry.path, entry.is_dir])));
  const contactPaths = $derived(
    new Set(tree.entries.filter((entry) => !entry.is_dir && entry.kind === "contact").map((entry) => entry.path)),
  );
  function labelCtx(tab: Tab): BrowserLabelCtx | undefined {
    if (tab.kind !== "browser") return undefined;
    const selected = tab.selected ?? undefined;
    return {
      workspaceName: workspaceDisplayName(),
      selectedIsDir: selected ? treeIsDir.get(selected) : undefined,
    };
  }

  const withSides = $derived(panesHaveSides());
  const panes = $derived(paneTree.open ? paneTreeModel(layout, { query, sides: withSides, labelCtx }) : []);
  const rows = $derived(paneTreeRows(panes));
  const rects = $derived(paneTree.open ? Object.entries(paneRects(layout)) : []);
  const chord = $derived(chordFor(PANE_TREE_COMMAND_ID));

  function rowKey(row: PaneTreeTab): string {
    return `${row.paneId}\u001f${row.tab.id}`;
  }

  // The selected row follows its tab while the list changes under it, and
  // falls back to the first row when that tab leaves the list.
  const selectedIndex = $derived.by(() => {
    const found = selectedKey === null ? -1 : rows.findIndex((row) => rowKey(row) === selectedKey);
    return found >= 0 ? found : rows.length > 0 ? 0 : -1;
  });
  // Each row's index in `rows`, for the option ids and the selection.
  const rowIndex = $derived(new Map(rows.map((row, index) => [rowKey(row), index])));

  /// Under the anchor when one is shown, else the window's top-left corner;
  /// kept inside the window's width.
  function anchorPosition(): { top: number; left: number } {
    const anchor = document.querySelector(`[${PANE_TREE_ANCHOR_ATTR}]`);
    const rect = anchor?.getBoundingClientRect();
    const shown = rect && (rect.width > 0 || rect.height > 0);
    const top = shown ? rect.bottom + 6 : EDGE;
    const left = shown ? rect.left : EDGE;
    const width = Math.min(WIDTH, window.innerWidth - 2 * EDGE);
    return { top, left: Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE)) };
  }

  $effect.pre(() => {
    if (!paneTree.open) return;
    untrack(() => {
      handedOff = false;
      const active = document.activeElement;
      const opener = deckPendingReturnFocus() ?? (active instanceof HTMLElement && active !== document.body ? active : null);
      // The control that opened the tree is not where the keyboard was
      // working; the active tab is, which the close falls back to.
      returnFocus = opener?.closest(`[${PANE_TREE_ANCHOR_ATTR}]`) ? null : opener;
      query = "";
      const current = paneTreeRows(paneTreeModel(layout, { sides: panesHaveSides(), labelCtx })).find((row) => row.current);
      selectedKey = current ? rowKey(current) : null;
      position = anchorPosition();
    });
    return () => {
      const target = returnFocus;
      returnFocus = null;
      if (handedOff) return;
      queueMicrotask(() => restoreFocus(target));
    };
  });

  /// Hand the keyboard back when the tree closed without showing a tab and
  /// left it nowhere: to the element it opened from, else to the active tab's
  /// surface, unless a survey over that terminal or the desktop's launcher
  /// holds it, or a dialog or a cover has come up and owns it.
  function restoreFocus(target: HTMLElement | null): void {
    if (paneTree.open || modalDialogOpen() || appInputBlocked()) return;
    const current = document.activeElement;
    const fell = current === null || current === document.body || !current.isConnected;
    if (!fell) return;
    if (canTakeFocus(target)) target.focus({ preventScroll: true });
    else if (!refocusRefused(activeTerminalTab()?.id ?? null)) bumpTabFocusPulse();
  }

  // Hybrid Nav, a dialog or a cover coming up closes the tree.
  $effect(() => {
    if (paneTree.open && !paneTreeMayOpen()) closePaneTree();
  });

  $effect(() => {
    if (paneTree.open && input) input.focus({ preventScroll: true });
  });

  function select(index: number): void {
    const row = rows[index];
    if (!row) return;
    selectedKey = rowKey(row);
    void tick().then(() => document.getElementById(optionId(index))?.scrollIntoView?.({ block: "nearest" }));
  }

  function move(delta: number): void {
    if (rows.length === 0) return;
    const from = selectedIndex < 0 ? (delta > 0 ? -1 : 0) : selectedIndex;
    select((from + delta + rows.length) % rows.length);
  }

  function activate(row: PaneTreeTab | undefined): void {
    if (!row) return;
    handedOff = true;
    if (!activatePaneTreeTab(row.paneId, row.tab.id)) handedOff = false;
  }

  // An Escape aimed outside the open tree (focus taken by something under
  // it) still closes it, before that surface sees the key.
  const escape = menuEscape({
    open: () => paneTree.open,
    inside: (target) => target instanceof Node && (panel?.contains(target) ?? false),
    close: closePaneTree,
  });

  function onKeydownCapture(e: KeyboardEvent): void {
    if (!paneTree.open) return;
    const target = e.target;
    const inside = target instanceof Node && (panel?.contains(target) ?? false);
    const page =
      target === document.body || target === document.documentElement || target === document || target === window;
    if (!inside && !page) {
      escape.capture(e);
      return;
    }
    // The tree owns the keyboard while open: nothing behind it acts on a key.
    // Text still reaches the filter, since its default is left alone.
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closePaneTree();
    } else if (isPaneTreeChord(e)) {
      e.preventDefault();
      if (!e.repeat) closePaneTree();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) activate(rows[selectedIndex]);
    } else if (target !== input && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // A character typed with the filter unfocused goes into the filter.
      input?.focus();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (paneTree.open) {
      // Reached only by a key aimed outside the open tree.
      if (isPaneTreeChord(e)) {
        e.preventDefault();
        closePaneTree();
      }
      return;
    }
    if (e.repeat || !isBuiltInPaneTreeChord(e)) return;
    if (keyboardOwnedAbovePanes() || !paneTreeMayOpen()) return;
    e.preventDefault();
    openPaneTree();
  }

  // The window's command bus, as a host or the native menu sends it.
  function onChanCommand(e: Event): void {
    const detail = (e as CustomEvent<{ name?: unknown }>).detail;
    if (detail?.name === PANE_TREE_COMMAND_ID) togglePaneTree();
  }
  onMount(() => {
    window.addEventListener("chan:command", onChanCommand);
    return () => window.removeEventListener("chan:command", onChanCommand);
  });

  function onResize(): void {
    if (paneTree.open) position = anchorPosition();
  }
</script>

<svelte:window
  onkeydowncapture={onKeydownCapture}
  onkeydown={onKeydown}
  onresize={onResize}
/>

{#snippet glyph(paneId: string)}
  <svg class="glyph" viewBox="0 0 24 16" width="24" height="16" aria-hidden="true">
    {#each rects as [id, r] (id)}
      <rect
        class:on={id === paneId}
        x={1 + r.x * 22 + 0.6}
        y={1 + r.y * 14 + 0.6}
        width={Math.max(0.6, r.w * 22 - 1.2)}
        height={Math.max(0.6, r.h * 14 - 1.2)}
        rx="1"
      />
    {/each}
  </svg>
{/snippet}

{#snippet kindIcon(tab: Tab)}
  {#if tab.kind === "file"}
    {#if contactPaths.has(tab.path)}
      <User size={14} strokeWidth={1.75} aria-hidden="true" />
    {:else if isExcalidraw(tab.path)}
      <Shapes size={14} strokeWidth={1.75} aria-hidden="true" />
    {:else}
      <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
    {/if}
  {:else if tab.kind === "terminal"}
    {@const visual = programVisual(tab.programStatus)}
    {#if visual.activity === "ring"}
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.3" />
        <circle cx="7" cy="7" r="1.95" fill="none" stroke="currentColor" stroke-width="3.9" pathLength="100" stroke-dasharray={String(visual.progress) + " 100"} transform="rotate(-90 7 7)" />
      </svg>
    {:else if visual.activity === "spinner"}
      <svg class="typing" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m4 17 6-6-6-6" />
        <path class="cursor" d="M12 19h8" />
      </svg>
    {:else}
      <Terminal size={14} strokeWidth={1.75} aria-hidden="true" />
    {/if}
  {:else if tab.kind === "graph"}
    <Network size={14} strokeWidth={1.75} aria-hidden="true" />
  {:else if tab.kind === "browser"}
    <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
  {:else if tab.kind === "dashboard"}
    <ChartNoAxesColumn size={14} strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <Blocks size={14} strokeWidth={1.75} aria-hidden="true" />
  {/if}
{/snippet}

{#snippet mark(tab: Tab)}
  {#if tab.kind === "terminal" && tab.programStatus}
    {@const attention = programVisual(tab.programStatus).attention}
    {#if attention}
      {@const summary = programSummary(attention, tab.programStatus)}
      <span
        class="mark"
        class:blocked={attention.state === "blocked"}
        class:error={attention.state === "error"}
        class:done={attention.state === "done"}
        role="img"
        aria-label={summary}
        title={summary}
      >
        {#if attention.state === "blocked" && attention.kind === "permission"}<Shield size={13} strokeWidth={2} aria-hidden="true" />
        {:else if attention.state === "blocked" && attention.kind === "question"}<CircleQuestionMark size={13} strokeWidth={2} aria-hidden="true" />
        {:else if attention.state === "blocked" && attention.kind === "auth"}<KeyRound size={13} strokeWidth={2} aria-hidden="true" />
        {:else if attention.state === "blocked"}<Pause size={13} strokeWidth={2} aria-hidden="true" />
        {:else if attention.state === "error"}<CircleAlert size={13} strokeWidth={2} aria-hidden="true" />
        {:else}<CircleCheck size={13} strokeWidth={2} aria-hidden="true" />{/if}
      </span>
    {/if}
  {/if}
{/snippet}

{#if paneTree.open}
  <div class="pane-tree-layer">
    <!-- A pointer target only: a press anywhere outside the dropdown closes
         it and goes no further, so it never lands on what is under it. The
         keyboard's ways out are Escape and the chord. -->
    <button
      class="pane-tree-backdrop"
      type="button"
      tabindex="-1"
      aria-label="Close panes and tabs"
      onmousedown={(e) => {
        e.preventDefault();
        closePaneTree();
      }}
    ></button>
    <div
      bind:this={panel}
      class="pane-tree"
      role="dialog"
      aria-modal="false"
      aria-label="Panes and tabs"
      style:top="{position.top}px"
      style:left="{position.left}px"
      style:max-height="calc(100vh - {position.top + EDGE}px)"
    >
      <div class="filter">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          bind:this={input}
          value={query}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={selectedIndex >= 0 ? optionId(selectedIndex) : undefined}
          aria-autocomplete="list"
          aria-label="Filter tabs"
          placeholder="Filter tabs"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          oninput={(e) => {
            query = e.currentTarget.value;
            selectedKey = null;
          }}
        />
        {#if chord}<kbd>{chord}</kbd>{/if}
      </div>
      <div class="list" id={LIST_ID} role="listbox" aria-label="Tabs">
        {#each panes as pane (pane.id)}
          <div class="pane" role="group" aria-label={`Pane ${pane.number}: ${pane.label}${pane.active ? ", active" : ""}`}>
            <div class="pane-head" class:active={pane.active} aria-hidden="true">
              {@render glyph(pane.id)}
              <span class="pane-label">{pane.label}</span>
              <span class="pane-number">Pane {pane.number}</span>
            </div>
            {#each pane.sides as side (side.side)}
              <div
                class="side"
                role="group"
                aria-label={withSides ? `Side ${side.side.toUpperCase()}${side.visible ? ", shown" : ""}` : undefined}
              >
                {#if withSides}
                  <div class="side-head" class:visible={side.visible} aria-hidden="true">
                    <span class="side-name">{side.side.toUpperCase()}</span>
                    {#if side.visible}<span class="side-shown">shown</span>{/if}
                  </div>
                {/if}
                {#if side.total === 0}
                  <div class="side-empty">No tabs</div>
                {/if}
                {#each side.tabs as row (row.tab.id)}
                  {@const index = rowIndex.get(rowKey(row)) ?? -1}
                  {@const programMark = tabProgramMark(row.tab)}
                  <button
                    class="row"
                    class:selected={index === selectedIndex}
                    class:current={row.current}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    tabindex="-1"
                    aria-selected={index === selectedIndex}
                    aria-current={row.current ? "true" : undefined}
                    data-program-mark={programMark ?? undefined}
                    title={tabTooltip(row.tab)}
                    onmousedown={(e) => e.preventDefault()}
                    onpointermove={() => {
                      if (index !== selectedIndex) selectedKey = rowKey(row);
                    }}
                    onclick={() => activate(row)}
                  >
                    <span class="kind-icon">{@render kindIcon(row.tab)}</span>
                    <span class="title">{row.title}</span>
                    <span class="kind">{tabKindLabel(row.tab)}</span>
                    {@render mark(row.tab)}
                    {#if row.active}
                      <span class="active-mark on" role="img" aria-label="active tab" title="Active tab on this side"></span>
                    {:else}
                      <span class="active-mark" aria-hidden="true"></span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/each}
          </div>
        {/each}
        {#if rows.length === 0 && query.trim()}
          <p class="none">No matching tabs</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .pane-tree-layer {
    position: fixed;
    inset: 0;
    /* Over the panes, the window tab bar and the status bar; under the
       app-root dialogs' covers, which close it as they come up anyway. */
    z-index: 28500;
    --pane-tree-focus: var(--pane-highlight-color, var(--pane-active-focus, var(--accent)));
  }
  .pane-tree-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  .pane-tree {
    position: absolute;
    width: min(420px, calc(100vw - 16px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-card);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.32);
    transform-origin: top left;
    animation: pane-tree-pop 160ms cubic-bezier(0.2, 0.85, 0.22, 1.05);
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .filter input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
  .filter kbd {
    flex: 0 0 auto;
    font: inherit;
    font-size: 11px;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
  }
  .list {
    overflow-y: auto;
    padding: 4px 6px 6px;
    overscroll-behavior: contain;
  }
  .pane + .pane {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .pane-head.active {
    color: var(--text);
  }
  .glyph {
    flex: 0 0 auto;
  }
  .glyph rect {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    opacity: 0.55;
  }
  .glyph rect.on {
    fill: var(--pane-tree-focus);
    stroke: var(--pane-tree-focus);
    opacity: 1;
  }
  .pane-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-number {
    flex: 0 0 auto;
    font-weight: 400;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .side-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 2px 36px;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .side-name {
    font-weight: 600;
    min-width: 12px;
    text-align: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 3px;
  }
  .side-head.visible .side-name {
    color: var(--text);
    border-color: var(--pane-tree-focus);
  }
  .side-empty {
    padding: 2px 6px 4px 36px;
    font-size: 12px;
    font-style: italic;
    color: var(--text-secondary);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 3px 8px 3px 34px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    position: relative;
  }
  .row.selected {
    background: var(--hover-bg);
  }
  .row.current::before {
    content: "";
    position: absolute;
    left: 24px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 2px;
    background: var(--pane-tree-focus);
  }
  .kind-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-secondary);
  }
  .row.current .kind-icon {
    color: var(--text);
  }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row.current .title {
    font-weight: 500;
  }
  .kind {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .mark {
    display: inline-flex;
    flex: 0 0 auto;
  }
  .mark.blocked { color: var(--warn-text); }
  .mark.error { color: var(--danger-text); }
  .mark.done { color: var(--info-text); }
  .active-mark {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .active-mark.on {
    background: var(--pane-tree-focus);
  }
  .typing .cursor {
    stroke-dasharray: 0 100;
    animation: pane-tree-typing 1.2s linear infinite;
  }
  .none {
    margin: 0;
    padding: 10px 8px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  @keyframes pane-tree-typing {
    55%, 80% { stroke-dasharray: 8 100; }
  }
  @keyframes pane-tree-pop {
    0% {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
    }
    100% {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pane-tree,
    .typing .cursor {
      animation: none;
    }
  }
</style>
