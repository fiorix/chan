<script lang="ts">
  // A centered modal over a dimmed backdrop. The backdrop is a real button so
  // clicking it (or pressing Escape) closes the dialog without tripping a11y
  // rules; the content sits above it and is never dismissed by an in-body
  // click. The launcher uses in-SPA modals only (WKWebView blocks native
  // dialogs), so this is the single dialog surface.
  import { onMount, type Snippet } from "svelte";
  import { createModalFocus } from "@chan/web-shared/modal-focus";

  interface Props {
    title: string;
    onclose: () => void;
    children: Snippet;
  }

  let { title, onclose, children }: Props = $props();

  const titleId = $props.id();
  let panel: HTMLElement | undefined = $state();
  const focus = createModalFocus({ onClose: () => onclose() });
  onMount(() => focus.mount(panel!));
</script>

<div class="overlay">
  <!-- The backdrop takes pointer clicks without taking focus: Escape must
       stay inside the panel, and Tab must reach only the dialog's controls. -->
  <button
    class="backdrop"
    type="button"
    aria-label="Close"
    tabindex="-1"
    onmousedown={(event) => event.preventDefault()}
    onclick={onclose}
  ></button>
  <div
    bind:this={panel}
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    onkeydown={focus.onKeydown}
  >
    <header class="modal-header">
      <h2 id={titleId}>{title}</h2>
      <button class="modal-close" type="button" aria-label="Close" onclick={onclose}>×</button>
    </header>
    <div class="modal-body">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1.5rem;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    border: none;
    padding: 0;
    background: rgba(0, 0, 0, 0.45);
    cursor: default;
  }

  .modal {
    position: relative;
    width: min(34rem, 100%);
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }

  .modal:focus {
    outline: none;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .modal-close {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
  }

  .modal-close:hover {
    color: var(--text);
  }

  /* The corrected dialog spacing: the body has its own bottom padding so the
     action row never overlaps the last field (the old launcher's bug). */
  .modal-body {
    padding: 1.25rem;
  }
</style>
