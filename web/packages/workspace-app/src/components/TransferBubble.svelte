<script lang="ts">
  // The transfer bubble: the prominent surface for cs upload / cs download
  // progress, opened from the status-bar transfers entry. One row per transfer
  // with a progress bar + a state-appropriate action -- Cancel while active,
  // Retry for an interrupted/failed download, Dismiss for any finished row.
  // Bound to browser XHR or desktop-native progress + cancellation; the bar
  // look mirrors the SPA's download-progress idiom (adapted, not cross-imported).
  import {
    transfers,
    dismissTransfer,
    hideTransfers,
    type Transfer,
  } from "../state/transfers.svelte";

  function pct(t: Transfer): number | null {
    return t.progress === null ? null : Math.round(t.progress * 100);
  }

  function statusLine(t: Transfer): string {
    const verb = t.kind === "upload" ? "Uploading" : "Downloading";
    switch (t.state) {
      case "queued":
        return `Queued ${t.filename}`;
      case "active": {
        const p = pct(t);
        return p === null ? `${verb} ${t.filename}...` : `${verb} ${t.filename} (${p}%)`;
      }
      case "done":
        return t.kind === "upload"
          ? `Uploaded ${t.filename}`
          : `Saved ${t.savedPath ?? t.filename}`;
      case "cancelled":
        return `Cancelled ${t.filename}`;
      case "failed":
        return `Failed ${t.filename}${t.error ? `: ${t.error}` : ""}`;
      case "interrupted":
        return `Interrupted ${t.filename} (window reloaded)`;
    }
  }
</script>

{#if transfers.shown && transfers.items.length}
  <div class="transfer-bubble" role="dialog" aria-label="File transfers">
    <div class="tb-head">
      <span class="tb-title">Transfers</span>
      <button class="tb-close" type="button" aria-label="Hide transfers" onclick={hideTransfers}
        >×</button>
    </div>
    <ul class="tb-rows">
      {#each transfers.items as t (t.id)}
        <li class="tb-row">
          <div class="tb-track" aria-hidden="true">
            <div
              class="tb-bar"
              class:indeterminate={t.state === "active" && t.progress === null}
              class:done={t.state === "done"}
              class:bad={t.state === "cancelled" ||
                t.state === "failed" ||
                t.state === "interrupted"}
              style={t.state === "active" && t.progress !== null
                ? `width: ${pct(t)}%`
                : t.state === "done"
                  ? "width: 100%"
                  : ""}
            ></div>
          </div>
          <div class="tb-line-row">
            <span class="tb-line">{statusLine(t)}</span>
            {#if (t.state === "queued" || t.state === "active") && t.cancel}
              <button class="tb-action" type="button" onclick={() => t.cancel?.()}>Cancel</button>
            {:else if t.retry}
              <button class="tb-action" type="button" onclick={() => t.retry?.()}>Retry</button>
            {:else}
              <button class="tb-action" type="button" onclick={() => dismissTransfer(t.id)}
                >Dismiss</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  /* Anchored top-right, just under the AppStatusBar pill (in lockstep
     with its top offset), so the rows grow DOWNWARD (a top anchor; the
     rows list flows top-to-bottom). fixed (not absolute) so it tracks
     the status bar's viewport anchor regardless of any positioned
     ancestor. */
  .transfer-bubble {
    position: fixed;
    top: 5.5rem;
    right: 0.6rem;
    z-index: 40;
    width: 22rem;
    max-width: calc(100vw - 1.2rem);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }

  .tb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .tb-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }

  .tb-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }

  .tb-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 16rem;
    overflow-y: auto;
  }

  .tb-row {
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .tb-row:last-child {
    border-bottom: none;
  }

  .tb-track {
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
    margin-bottom: 0.35rem;
  }

  .tb-bar {
    height: 100%;
    width: 0;
    background: var(--accent);
    transition: width 0.15s linear;
  }
  .tb-bar.done {
    background: var(--accent);
  }
  /* Cancelled / failed / interrupted: a muted track, no fill -- the row text
     carries the terminal reason. */
  .tb-bar.bad {
    background: var(--danger, #c0392b);
    width: 0;
  }
  /* No Content-Length: slide a chunk instead of faking a ratio. */
  .tb-bar.indeterminate {
    width: 40%;
    animation: tb-slide 1.1s ease-in-out infinite;
  }
  @keyframes tb-slide {
    0% {
      margin-left: -40%;
    }
    100% {
      margin-left: 100%;
    }
  }

  .tb-line-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }

  .tb-line {
    font-size: 0.8rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tb-action {
    flex-shrink: 0;
    border: 1px solid var(--btn-border);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--text-secondary);
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  .tb-action:hover {
    color: var(--text);
    border-color: var(--brand);
  }
</style>
