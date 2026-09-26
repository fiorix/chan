<script lang="ts">
  // The chrome the app-root dialogs share: a dim backdrop over the whole
  // window that dismisses on a click, and a centered panel beside it that
  // swallows its own clicks. The dialog's content (title, fields, action
  // row) and its open state are the caller's; the shell renders only while
  // the caller shows it.

  import { onMount, type Snippet } from "svelte";

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

  let panel: HTMLElement | undefined = $state();

  // Focus enters the dialog as it opens, so keys land here rather than in
  // the surface behind it. A body that parks focus on a control does so
  // after it renders and moves it on from the panel.
  onMount(() => panel?.focus());
</script>

<div class="overlay">
  <!-- A pointer target only: the dialog's own buttons are the keyboard's
       way out, so the backdrop stays out of the tab order. -->
  <button
    class="backdrop"
    type="button"
    aria-label="Close"
    tabindex="-1"
    onclick={onClose}
  ></button>
  <div
    bind:this={panel}
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
  .backdrop {
    position: absolute;
    inset: 0;
    border: none;
    padding: 0;
    background: transparent;
    cursor: default;
  }
  .modal {
    position: relative;
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
