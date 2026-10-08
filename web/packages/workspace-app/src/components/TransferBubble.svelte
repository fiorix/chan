<script lang="ts">
  // The transfer bubble: the prominent surface for cs upload / cs download
  // progress, opened from the status-bar transfers entry. One row per transfer
  // with a progress bar + a state-appropriate action -- Cancel while active,
  // Dismiss for any finished row, and Retry beside it for an interrupted or
  // failed download.
  // Bound to browser XHR or desktop-native progress + cancellation; the bar
  // look mirrors the SPA's download-progress idiom (adapted, not cross-imported).
  import {
    transfers,
    dismissTransfer,
    hideTransfers,
    type Transfer,
  } from "../state/transfers.svelte";
  import { uploadRequestState, uploadRequestCount, uploadDestination, chooseUploadRequest, cancelUploadRequest, dismissReplacedUpload, dismissOlderUploads, uploadRequestFocus, uploadRequestKeydown } from "../state/uploadRequest.svelte";

  const pending = $derived(uploadRequestState.pending);

  // A Retry starts a transfer of its own, so the row it answers goes.
  function retry(t: Transfer): void {
    const run = t.retry;
    dismissTransfer(t.id);
    run?.();
  }

  function pct(t: Transfer): number | null {
    return t.progress === null ? null : Math.round(t.progress * 100);
  }

  function statusLine(t: Transfer): string {
    const verb = t.kind === "upload" ? "Uploading" : "Downloading";
    switch (t.state) {
      case "active": {
        // The server holds this one. Its rank is among THIS tenant's waiting
        // transfers, so the wording says where it sits in our own queue and
        // never implies a position on the server as a whole. With no rank, and
        // for a transfer the server never reported on at all, the row just says
        // it is waiting rather than inventing a number.
        if (t.queue?.state === "waiting") {
          // A 1-based rank: 1 is next among ours, not next on the server.
          // "your queue" scopes it to this tenant without claiming a global
          // position and without having to say whether the tenant is a
          // workspace or a standalone terminal.
          return t.queue.position === null
            ? `Waiting to start ${t.filename}`
            : `Waiting to start ${t.filename} (#${t.queue.position} in your queue)`;
        }
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

{#if transfers.shown && (transfers.items.length || uploadRequestCount())}
  <div class="transfer-bubble" role="dialog" aria-label="File transfers">
    <div class="tb-head">
      <span class="tb-title">Transfers</span>
      <button class="tb-close" type="button" aria-label="Hide transfers" onclick={hideTransfers}
        >×</button>
    </div>
    <ul class="tb-rows">
      {#if pending}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
        <li class="tb-row tb-request" role="group" aria-label="Upload request" tabindex="-1" use:uploadRequestFocus={pending.id} onkeydown={(event) => uploadRequestKeydown(event, pending.id)}>
          <p>Waiting for file selection: <strong>{uploadDestination(pending)}</strong></p>
          {#if pending.replaced}<p>Replaces the waiting request for {pending.replaced}.</p>{/if}
          {#if pending.error}<p role="alert">{pending.error}</p>{/if}
          <div class="tb-actions">
            <button class="tb-action" type="button" onclick={() => chooseUploadRequest(pending.id)}>Choose files</button>
            <button class="tb-action" type="button" onclick={() => cancelUploadRequest(pending.id)}>Cancel</button>
          </div>
        </li>
      {/if}
      {#each uploadRequestState.replaced as request (request.id)}
        <li class="tb-row tb-request-disposition">
          <p>Upload request for {request.destination} replaced by a newer command for {request.replacement}. No files were selected for the replaced request.</p>
          <button class="tb-action" type="button" onclick={() => dismissReplacedUpload(request.id)}>Dismiss</button>
        </li>
      {/each}
      {#if uploadRequestState.olderReplacements}
        <li class="tb-row tb-request-disposition">
          <p>{uploadRequestState.olderReplacements} earlier upload requests were replaced.</p>
          <button class="tb-action" type="button" onclick={dismissOlderUploads}>Dismiss</button>
        </li>
      {/if}
      {#each transfers.items as t (t.id)}
        <li class="tb-row">
          <div class="tb-track" aria-hidden="true">
            <div
              class="tb-bar"
              class:indeterminate={t.state === "active" &&
                t.progress === null &&
                t.queue?.state !== "waiting"}
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
            <span class="tb-actions">
              {#if t.state === "active" && t.cancel}
                <button class="tb-action" type="button" onclick={() => t.cancel?.()}>Cancel</button>
              {:else}
                {#if t.retry}
                  <button class="tb-action" type="button" onclick={() => retry(t)}>Retry</button>
                {/if}
                <button class="tb-action" type="button" onclick={() => dismissTransfer(t.id)}
                  >Dismiss</button>
              {/if}
            </span>
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
  .tb-request:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .tb-request p, .tb-request-disposition p {
    margin: 0 0 0.4rem;
    color: var(--text-secondary);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
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

  .tb-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.375rem;
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
