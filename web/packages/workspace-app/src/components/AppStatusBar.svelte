<script lang="ts">
  // Top-right window-level pill that surfaces app-wide ambient state.
  // Sections render only when they have content; the whole bar
  // disappears when none do.
  //
  // Sections (left -> right):
  //   - index    : indexer state (building / reindexing / recovering / error).
  //                Idle is completely hidden so the bar stays quiet
  //                when nothing's happening.
  //   - import   : long-running import progress (contacts today;
  //                others slot in via the same `importStatus` store).
  //   - transfers: a launcher for the transfer bubble -- file uploads
  //                and downloads (progress + cancel) live in the bubble,
  //                not as inline status text.
  //   - status   : transient `ui.status` messages (move/rename/delete
  //                failures, etc).
  //
  // Hide model: bar disappears entirely when no section has
  // content, and collapses to a pill on click. No idle fade and no
  // time-based auto-dismiss; a section clears only when its source
  // clears. Indexing progress and error messages are important
  // enough that the user shouldn't lose them just by holding still.
  //
  // Position: fixed top-right so it's independent of the workspace
  // layout and clear of the terminal prompt + rich-prompt that sit at
  // the bottom of a terminal pane.
  import {
    browserSidePanes,
    indexStatus,
    importStatus,
    openWorkspaceWarningsDialog,
    paneWidths,
    dismissStatus,
    ui,
  } from "../state/store.svelte";
  import { transfers, toggleTransfers } from "../state/transfers.svelte";
  import { openIndexingDashboard, paneMode } from "../state/tabs.svelte";
  import { selfParticipant, sessionState } from "../state/session.svelte";

  let collapsed = $state(false);

  // Keep the window-level pill attached to the workspace edge when the
  // right-side file browser is docked. The dock width is live while its
  // resize handle moves, so the pill follows the split instead of covering
  // the file browser. Terminal-only windows never render either dock.
  const rightInset = $derived(
    !ui.terminalOnly && browserSidePanes.right ? paneWidths.browser + 12 : 12,
  );

  // Status-bar sections are ambient state. Only statuses that carry
  // an explicit typed action become buttons; generic status text
  // stays passive.

  /// Indexer section: hidden when idle (steady state should be
  /// quiet) and when the poller hasn't replied yet (`null`). The one
  /// idle case that still shows is background embedding (idle + a set
  /// `embedding`): the index is BM25-ready, so we surface a passive
  /// progress chip rather than an active pill.
  const indexVisible = $derived(
    indexStatus.value !== null &&
      (indexStatus.value.state !== "idle" ||
        indexStatus.value.embedding != null),
  );
  const importVisible = $derived(importStatus.value !== null);
  // The transfers-bubble launcher: shown whenever any transfer record exists
  // (active or finished), so the bubble stays reachable after a transfer ends.
  const transfersBubbleVisible = $derived(transfers.items.length > 0);
  const activeXfers = $derived(transfers.items.filter((t) => t.state === "active").length);
  const statusVisible = $derived(!!ui.status);
  const statusActionVisible = $derived(
    statusVisible &&
      ui.statusAction?.kind === "workspace-warnings" &&
      ui.statusAction.label === ui.status,
  );
  // Persistent statuses with no typed action are the one-shot error pills
  // (create / rename / upload failures). They have no lifecycle owner, so
  // give them a click-to-dismiss. Transient statuses auto-clear and the
  // workspace-warnings action opens its dialog instead.
  const statusDismissable = $derived(
    statusVisible && !statusActionVisible && ui.statusKind === "persistent",
  );
  const paneModeVisible = $derived(paneMode.active);
  // Session role: shown only when the roster is genuinely SPLIT by origin --
  // at least one local Leader AND at least one remote Follower. A sole-user
  // all-local roster (his standalone terminals, his workspace windows) stays
  // quiet; the badge appears only once a real remote (a gateway browser) joins.
  // Role is origin-derived on the server and read off the /ws roster.
  const roleVisible = $derived(
    sessionState.participants.some((p) => p.role === "leader") &&
      sessionState.participants.some((p) => p.role === "follower"),
  );
  const role = $derived(selfParticipant()?.role ?? "follower");
  const anyVisible = $derived(
    indexVisible ||
      importVisible ||
      transfersBubbleVisible ||
      statusVisible ||
      paneModeVisible ||
      roleVisible,
  );

  function toggleCollapse(): void {
    collapsed = !collapsed;
  }

  function activateStatus(): void {
    if (statusActionVisible) openWorkspaceWarningsDialog();
  }
</script>

{#if anyVisible}
  <div class="app-statusbar" class:collapsed style:right={`${rightInset}px`}>
    {#if !collapsed}
      <div class="row">
        {#if indexVisible}
          {@const s = indexStatus.value!}
          <!-- The whole pill is a button: clicking it opens a Dashboard tab
               on the Indexing (Search) slide with auto-rotation paused, so a
               user watching the index build jumps straight to the live
               per-directory graph. -->
          <button
            type="button"
            class="section status-action"
            class:err={s.state === "error"}
            aria-label="open indexing dashboard"
            title="Open indexing dashboard"
            onclick={openIndexingDashboard}
          >
            <span
              class="dot"
              class:working={s.state !== "error" && s.state !== "idle"}
              class:err={s.state === "error"}
            ></span>
            {#if s.state === "building"}
              <!-- The `IndexFile` / `GraphRebuild`
                   stages set `s.current / s.total` to "files
                   indexed / total files" - readable. The
                   `EmbedBatch` stage (sentinel `s.file === "embedding"`)
                   sets them to "chunks pending flush / batch
                   budget" instead, and once more chunks accumulate
                   than the budget the counter reads as nonsense
                   ("indexing 4143/4096 (embedding)"). Hide the
                   count during the embedding phase so the pill
                   just signals "embedding in progress" without the
                   misleading numbers. -->
              indexing
              {#if s.file !== "embedding"}
                <span class="num">{s.current}/{s.total}</span>
              {/if}
              {#if s.file}<span class="muted">({s.file})</span>{/if}
            {:else if s.state === "reindexing"}
              reindexing <span class="muted">{s.file}</span>
            {:else if s.state === "recovering"}
              workspace recovering
            {:else if s.state === "error"}
              index error: <span class="muted">{s.message}</span>
            {:else if s.state === "idle" && s.embedding}
              <!-- BM25-ready, embeddings still generating in the
                   background (preflight already unlocked). Passive chip:
                   the dot is static (no `working` pulse) so this reads as
                   quiet progress, not the active reindexing pill. The
                   done/total here are real chunk counts, not the building
                   phase's misleading EmbedBatch sentinel. -->
              embedding
              <span class="num">{s.embedding.done}/{s.embedding.total}</span>
            {/if}
          </button>
        {/if}
        {#if indexVisible && importVisible}
          <span class="sep"> - </span>
        {/if}
        {#if importVisible}
          <span class="section" aria-label="import status">
            <span class="dot working"></span>
            {importStatus.value!.label}
          </span>
        {/if}
        {#if (indexVisible || importVisible) && transfersBubbleVisible}
          <span class="sep"> - </span>
        {/if}
        {#if transfersBubbleVisible}
          <button
            type="button"
            class="section status-action"
            aria-label="show file transfers"
            title="Show file transfers"
            onclick={toggleTransfers}
          >
            {#if activeXfers > 0}<span class="dot working"></span>{/if}
            ⇅ Transfers ({transfers.items.length})
          </button>
        {/if}
        {#if (indexVisible || importVisible || transfersBubbleVisible) && statusVisible}
          <span class="sep"> - </span>
        {/if}
        {#if statusVisible}
          {#if statusActionVisible}
            <button
              type="button"
              class="section status-msg status-action"
              aria-label="open workspace warnings"
              onclick={activateStatus}
            >{ui.status}</button>
          {:else}
            <span class="section status-msg" aria-label="status message">
              {ui.status}
              {#if statusDismissable}
                <button
                  type="button"
                  class="status-dismiss"
                  aria-label="dismiss status"
                  title="Dismiss"
                  onclick={dismissStatus}
                  onmousedown={(e) => e.preventDefault()}
                >×</button>
              {/if}
            </span>
          {/if}
        {/if}
        {#if (indexVisible || importVisible || statusVisible) && paneModeVisible}
          <span class="sep"> - </span>
        {/if}
        {#if paneModeVisible}
          <!-- Status-bar label for Hybrid Nav (Cmd+.). The spawn-intent
               chip reflects any staged tab spawn before commit. -->
          <span class="section pane-mode-pill" aria-label="Hybrid Nav active">
            <span class="dot working"></span>
            Hybrid ☯ Enter commit, Esc discard, H help
            {#if paneMode.spawnIntent}
              <span class="muted">→ stage {paneMode.spawnIntent.kind}</span>
            {/if}
          </span>
        {/if}
        {#if (indexVisible || importVisible || transfersBubbleVisible || statusVisible || paneModeVisible) && roleVisible}
          <span class="sep"> - </span>
        {/if}
        {#if roleVisible}
          <span class="section" aria-label="session role">
            <span class="dot"></span>
            {role}
          </span>
        {/if}
      </div>
    {/if}
    <button
      class="collapse"
      title={collapsed ? "show status" : "hide status"}
      onclick={toggleCollapse}
      onmousedown={(e) => e.preventDefault()}
    >{collapsed ? "‹" : "›"}</button>
  </div>
{/if}

<style>
  /* Window-level pill anchored to the workspace's top-right edge.
     position:fixed keeps it above the pane layout; the inline right
     inset tracks a visible right-side file-browser dock.
     z-index sits above every stacked overlay (modals at 26000,
     OverlayShell stack starts at 25002) but below the disconnect
     overlay (30000), which preempts everything when the watcher
     dies. The bar is small, anchored to a corner, and surfaces
     state the user needs visibility of even while a settings panel
     or file browser is open. */
  .app-statusbar {
    position: fixed;
    /* Sits below the pane tab-strip (the tab pills + the top-right
       hamburger button, ~33px tall) so the pill never covers it. */
    top: 48px;
    z-index: 28000;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
    font-size: 12px;
    color: var(--muted);
    user-select: none;
    /* Wobble + lift on hover, matching the editor status bar. */
    transform-origin: right top;
    transition:
      opacity 200ms ease,
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 160ms ease;
  }
  .app-statusbar:hover {
    transform: scale(1.04);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
  }
  .app-statusbar.collapsed {
    padding: 6px;
    gap: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  /* Most status-bar sections are ambient labels. Typed actions get
     their own button styling below. */
  .section.err {
    color: var(--warn-text);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .muted {
    color: var(--muted);
    /* Truncate long filenames so a single section can't push the
       bar across the screen. The full path is still in the status
       source if anyone needs it. */
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-msg {
    color: var(--warn-text);
  }
  /* Small close affordance for a persistent error pill with no typed
     action. Matches the collapse button's quiet styling. */
  .status-dismiss {
    border: 0;
    background: transparent;
    padding: 0 2px;
    margin-left: 2px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .status-dismiss:hover {
    color: var(--text);
  }
  .status-dismiss:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .status-action {
    border: 0;
    background: transparent;
    padding: 0;
    cursor: pointer;
    font: inherit;
  }
  .status-action:hover {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .status-action:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
    border-radius: 4px;
  }
  .sep {
    color: var(--border);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent);
  }
  /* Amber = something running; matches the conventional "working"
     signal without colliding with the editor lamp's green (which
     specifically means "write mode is active"). */
  .dot.working {
    background: #d29922;
    box-shadow: 0 0 4px rgba(210, 153, 34, 0.55);
  }
  .dot.err {
    background: var(--warn-text);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--warn-text) 35%, transparent);
  }
  .collapse {
    background: transparent;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 0 4px;
    font: inherit;
    line-height: 1;
  }
  .collapse:hover {
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .app-statusbar,
    .app-statusbar:hover {
      transition: opacity 120ms linear;
      transform: none;
    }
  }
</style>
