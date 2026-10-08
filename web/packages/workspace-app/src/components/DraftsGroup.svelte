<script lang="ts">
  // The workspace's drafts, above the file tree. A draft is kept outside
  // the workspace, so no row of the tree is one: this group lists them from
  // the server's drafts list, one row per draft. A click opens the draft's
  // primary file. A damaged draft is a row that says what is wrong and can
  // only be discarded. When the draft store itself refused to open, one
  // banner stands in place of the rows.
  //
  // Rows take no rename, move, delete, upload or drag: a draft leaves by
  // its save to the workspace or its discard, from its editor tab.

  import { onMount } from "svelte";
  import { showMarked } from "../api/fileIdentity";
  import type { DraftListEntry, WorkspaceWarning } from "../api/types";
  import { drafts, refreshDrafts } from "../state/drafts.svelte";
  import {
    canDiscardWorkspaceWarning,
    discardWorkspaceWarning,
    workspaceWarningKey,
  } from "../state/store.svelte";
  import { openInActivePane } from "../state/tabs.svelte";
  import { windowCaps } from "../state/windowCaps";

  let { rightDock = false }: { rightDock?: boolean } = $props();

  const shown = $derived(
    windowCaps.workspace &&
      (drafts.preflight !== null || drafts.rows.length > 0 || drafts.broken.length > 0),
  );

  onMount(() => {
    if (windowCaps.workspace) void refreshDrafts();
  });

  function open(row: DraftListEntry): void {
    if (row.path !== null) void openInActivePane(row.path);
  }

  /// What a damaged draft is called: the name the server gives it, else the
  /// path its warning names.
  function brokenName(warning: WorkspaceWarning): string {
    return warning.source?.root === "draft" ? warning.source.path : warning.path;
  }

  // The damaged draft whose discard the server refused, and what it said.
  // The warnings dialog shows a refusal only while it is open, and a click
  // here is made with it closed, so the group says it under the row.
  let refused = $state<{ key: string; message: string } | null>(null);

  async function discard(warning: WorkspaceWarning): Promise<void> {
    const message = await discardWorkspaceWarning(warning);
    refused = message === null ? null : { key: workspaceWarningKey(warning), message };
    void refreshDrafts();
  }
</script>

{#if shown}
  <section class="drafts-group" class:right-dock={rightDock} aria-label="Drafts">
    <div class="drafts-title">Drafts</div>
    <p class="drafts-note">
      Drafts are kept outside the workspace. They are not in search or the graph until saved
      to the workspace.
    </p>
    {#if drafts.preflight}
      <div class="drafts-banner" role="alert">
        <span>Drafts are unavailable: {drafts.preflight.message}</span>
        <code>{drafts.preflight.path}</code>
      </div>
    {:else}
      <ul class="drafts-rows">
        {#each drafts.rows as row (row.draftId)}
          <li>
            <button
              type="button"
              class="draft-row"
              disabled={row.path === null}
              title={row.path === null ? `${row.name} is busy` : `Open draft ${row.name}`}
              onclick={() => open(row)}
            >
              <span class="draft-name">{row.name}</span>
              {#if row.hasAttachments}
                <span class="draft-mark" title="has attachments" aria-label="has attachments">+</span>
              {/if}
              {#if row.busy}
                <span class="draft-busy">busy</span>
              {/if}
            </button>
          </li>
        {/each}
        {#each drafts.broken as warning (workspaceWarningKey(warning))}
          <li class="draft-broken">
            <span class="draft-name">{brokenName(warning)}</span>
            <span class="draft-problem">{warning.message}</span>
            {#if canDiscardWorkspaceWarning(warning)}
              <button type="button" class="draft-discard" onclick={() => void discard(warning)}
                >Discard</button
              >
            {/if}
          </li>
          {#if refused?.key === workspaceWarningKey(warning)}
            <li class="draft-refusal" role="alert">Not discarded: {showMarked(refused.message)}</li>
          {/if}
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .drafts-group {
    padding: 4px 0 6px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }
  .drafts-group.right-dock {
    text-align: right;
  }
  .drafts-title {
    padding: 0 16px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fb-drafts-fg, var(--text-secondary));
  }
  .drafts-note {
    margin: 2px 0 4px;
    padding: 0 16px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--text-secondary);
  }
  .drafts-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .draft-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 22px;
    padding: 0 16px;
    border: 0;
    background: none;
    font: inherit;
    font-size: 15px;
    color: var(--text);
    text-align: inherit;
    cursor: pointer;
  }
  .draft-row:hover:not(:disabled) {
    background: var(--hover-bg);
  }
  .draft-row:disabled {
    cursor: default;
    color: var(--text-secondary);
  }
  .draft-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .draft-mark,
  .draft-busy {
    flex: none;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .draft-broken {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 0 16px;
    font-size: 15px;
  }
  .draft-problem {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .draft-discard {
    flex: none;
    font-size: 12px;
  }
  .draft-refusal {
    padding: 0 16px 2px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--warn-text);
    overflow-wrap: anywhere;
  }
  .drafts-banner {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 16px;
    font-size: 13px;
  }
  .drafts-banner code {
    font-size: 12px;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
</style>
