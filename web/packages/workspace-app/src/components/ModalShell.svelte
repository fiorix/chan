<script lang="ts">
  // The chrome the app-root dialogs share: a dim backdrop over the whole
  // window that dismisses on a click, and a centered panel that swallows
  // its own clicks so a click inside never reaches the backdrop. The
  // dialog's content (title, fields, action row) and its open state are
  // the caller's; the shell renders only while the caller shows it.

  import type { Snippet } from "svelte";

  let {
    labelledby,
    onClose,
    onKeydown,
    minWidth,
    gap,
    children,
  }: {
    // The id of the caller's title element, which names the dialog.
    labelledby: string;
    onClose: () => void;
    // Keys the dialog answers wherever focus sits inside the panel.
    onKeydown?: (e: KeyboardEvent) => void;
    minWidth?: string;
    // The spacing between the panel's rows, when the content wants it
    // tighter or looser than the default.
    gap?: string;
    children: Snippet;
  } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose}>
  <div
    class="modal"
    style:min-width={minWidth}
    style:gap
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledby}
    tabindex="-1"
  >
    {@render children()}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 26000;
  }
  .modal {
    background: var(--bg-elev);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    padding: 1rem;
    max-width: 80vw;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
</style>
