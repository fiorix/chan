<script lang="ts">
  // The chrome the app-root dialogs share: a dim backdrop over the whole
  // window that dismisses on a click, and a centered panel beside it. The
  // dialog's content (title, fields, action row) and its open state are the
  // caller's; the shell renders only while the caller shows it.

  import { onMount, type Snippet } from "svelte";
  import { createModalFocus } from "@chan/web-shared/modal-focus";
  import { registerModalShell } from "./modalStack";

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
    // Keys other than Escape that the dialog answers wherever focus sits
    // inside the panel. It sees Tab before the shell wraps it, and a Tab it
    // takes stays taken.
    onKeydown?: (e: KeyboardEvent) => void;
    minWidth?: string;
    // The spacing between the panel's rows, when the content wants it
    // tighter or looser than the default.
    gap?: string;
    children: Snippet;
  } = $props();

  let panel: HTMLElement | undefined = $state();
  let layer: HTMLElement | undefined = $state();
  let registration: ReturnType<typeof registerModalShell> | undefined;
  const active = document.activeElement;
  const opener = active instanceof HTMLElement && active !== document.body ? active : null;

  const focus = createModalFocus({
    restoreFocus: false,
    onClose: () => onClose(),
    onKeydown: (event) => {
      onKeydown?.(event);
      if (!registration?.isTop()) event.preventDefault();
    },
  });
  onMount(() => {
    registration = registerModalShell({ layer: layer!, panel: panel!, opener, onKeydown: focus.onKeydown });
    const cleanup = focus.mount(panel!);
    return () => { cleanup(); registration?.destroy(); };
  });

  function panelKeydown(event: KeyboardEvent): void {
    if (!registration?.isTop()) return;
    focus.onKeydown(event);
    if (event.key === "Tab") event.stopPropagation();
  }

</script>

<div class="overlay" bind:this={layer}>
  <!-- A pointer target only: Escape and the dialog's own buttons are the
       keyboard's way out, so the backdrop stays out of the tab order. A
       press on it takes no focus either: focus held here would carry Escape
       past the panel to the app and let Enter or Space cancel the dialog.
       The click still lands. -->
  <button
    class="backdrop"
    type="button"
    aria-label="Close"
    tabindex="-1"
    onmousedown={(e) => e.preventDefault()}
    onclick={() => { if (registration?.isTop()) onClose(); }}
  ></button>
  <div
    bind:this={panel}
    class="modal"
    style:min-width={minWidth}
    style:gap
    onkeydown={panelKeydown}
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
