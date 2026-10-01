<script lang="ts">
  // Generic chat-style bubble around compact text.
  //
  // The shell intentionally exposes no interaction: click handling,
  // keyboard focus, and the `active` highlight are owned by the
  // caller (an outer <li>, <button>, etc.). The `active` prop only
  // toggles a visual ring so the parent's list-level keyboard nav
  // can light up the right bubble without reaching into our DOM.

  import type { Snippet } from "svelte";

  let {
    active = false,
    children,
  }: {
    /// Visual highlight for keyboard / list-driven focus. The
    /// caller still owns scroll-into-view and `aria-selected`.
    active?: boolean;
    /// Body content. Required.
    children: Snippet;
  } = $props();
</script>

<div class="bubble left" class:active>
  <div class="body">{@render children()}</div>
</div>

<style>
  /* Left-aligned in the caller's column, capped at 85% of its width. */
  .bubble {
    max-width: 85%;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .bubble.left { align-self: flex-start; align-items: flex-start; }

  .body {
    background: var(--bubble-bg);
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 15px;
    line-height: 1.5;
    word-break: break-word;
  }

  /* Active highlight for list-driven keyboard navigation. Soft
     ring around the body so the row reads as "selected" without
     fighting the body background. Uses --link to match the active
     border-left treatment search results had pre-bubble. */
  .bubble.active .body {
    box-shadow: 0 0 0 2px var(--link);
  }
</style>
