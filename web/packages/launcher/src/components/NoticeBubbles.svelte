<script lang="ts">
  // Corner notice cards (the workspace-app bubble shell): fixed bottom-right,
  // newest at the bottom, each with a source chip, title, age, a clamped
  // message that expands on click, and a Dismiss. Renders the notices ring;
  // the desktop's launcher-notice events and local action errors land here
  // alike. Errors announce as alerts, info as status.
  import { notices, dismissNotice, toggleExpanded, type Notice } from "../state/notices.svelte";
  import { exactStamp, relativeAge } from "@chan/web-shared/relative-time";

  function sourceChip(n: Notice): string {
    if (n.source.label) return `${n.source.type} ${n.source.label}`;
    return n.source.type === "desktop" ? "" : n.source.type;
  }
</script>

{#if notices.items.length > 0}
  <div class="notice-stack">
    {#each notices.items as n (n.id)}
      <div
        class="notice-bubble"
        class:error={n.kind === "error"}
        role={n.kind === "error" ? "alert" : "status"}>
        <div class="nb-head">
          {#if sourceChip(n)}
            <span class="nb-source">{sourceChip(n)}</span>
          {/if}
          <span class="nb-title">{n.title}</span>
          <time class="nb-age" datetime={new Date(n.at).toISOString()} title={exactStamp(n.at)}>{relativeAge(n.at, notices.now)}</time>
          <button
            class="nb-close"
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onclick={() => dismissNotice(n.id)}>×</button>
        </div>
        <button
          class="nb-body"
          type="button"
          aria-expanded={notices.expandedId === n.id}
          onclick={() => toggleExpanded(n.id)}>
          <span class="nb-message" class:expanded={notices.expandedId === n.id}>{n.message}</span>
          {#if notices.expandedId === n.id}
            <span class="nb-stamp">{exactStamp(n.at)}</span>
          {/if}
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .notice-stack {
    position: fixed;
    bottom: 2rem;
    right: 0.6rem;
    z-index: 41;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 22rem;
    max-width: calc(100vw - 1.2rem);
  }

  .notice-bubble {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }

  .notice-bubble.error {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }

  .nb-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .nb-source {
    flex-shrink: 0;
    padding: 0.05rem 0.35rem;
    border-radius: 5px;
    background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
    color: var(--text-secondary);
    font-size: 0.7rem;
    white-space: nowrap;
  }

  .notice-bubble.error .nb-source {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }

  .nb-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }

  .nb-age {
    flex-shrink: 0;
    color: var(--text-secondary);
    font-size: 0.7rem;
    white-space: nowrap;
  }

  .nb-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }

  .nb-close:hover {
    color: var(--text);
  }

  /* The whole body is the expand toggle: full-width bare button so the
     clamped message stays keyboard-reachable. */
  .nb-body {
    display: block;
    width: 100%;
    margin: 0;
    padding: 0.5rem 0.6rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }

  .nb-message {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.78rem;
    line-height: 1.4;
    color: var(--text-secondary);
    word-break: break-word;
  }

  .nb-message.expanded {
    display: block;
    overflow: visible;
  }

  .nb-stamp {
    display: block;
    margin-top: 0.4rem;
    color: var(--text-secondary);
    font-size: 0.7rem;
  }
</style>
