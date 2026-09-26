<script lang="ts">
  // The chrome the app-root dialogs share: a dim backdrop over the whole
  // window that dismisses on a click, and a centered panel beside it. The
  // dialog's content (title, fields, action row) and its open state are the
  // caller's; the shell renders only while the caller shows it.

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

  // The element that held focus when the dialog opened, read before the
  // panel takes it. Closing hands focus back, so the caret returns to the
  // surface that asked (a terminal, an editor) with no click. A target the
  // answer removed (a closed tab, a restarted terminal) is skipped.
  const active = document.activeElement;
  const returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;

  // Focus enters the dialog as it opens, so keys land here rather than in
  // the surface behind it. A body that parks focus on a control does so
  // after it renders and moves it on from the panel.
  onMount(() => {
    panel?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  });

  // Elements whose kind can put them in the tab order, plus anything a body
  // gave a tabindex. An editing host and a media element with controls are
  // tab stops although their default tabIndex reads -1, so they are named.
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';
  const STOP_WITHOUT_TABINDEX =
    'audio[controls], video[controls], [contenteditable]:not([contenteditable="false"])';

  // The controls Tab stops on inside the panel, in DOM order: a tabindex
  // puts an element in the order or takes it out, and without one its kind
  // decides; a disabled control (a disabled fieldset disables what it
  // holds), an inert one, and one that is not displayed or not visible are
  // skipped, as the browser skips them.
  function tabStops(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
      const index = Number.parseInt(el.getAttribute("tabindex") ?? "", 10);
      const inOrder = Number.isNaN(index)
        ? el.tabIndex >= 0 || el.matches(STOP_WITHOUT_TABINDEX)
        : index >= 0;
      return inOrder && !el.matches(":disabled") && !el.closest("[inert]") && isRendered(el, root);
    });
  }

  function isRendered(el: HTMLElement, root: HTMLElement): boolean {
    if (getComputedStyle(el).visibility !== "visible") return false;
    for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
      if (getComputedStyle(n).display === "none") return false;
    }
    return true;
  }

  // Tab and Shift+Tab wrap inside the panel, so focus cannot leave a
  // dialog marked modal: Tab past the last control goes to the first, and
  // Shift+Tab before the first, or from the panel itself where focus lands
  // on open, goes to the last. Between the ends the browser moves focus,
  // and a Tab a control inside has already taken (PathPromptModal's input
  // completes a path with it) stays that control's.
  function wrapTab(e: KeyboardEvent): void {
    if (!panel || e.defaultPrevented) return;
    const stops = tabStops(panel);
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Escape closes this dialog and goes no further. App's document-level
  // handler answers Escape too, by closing the topmost overlay, and must
  // not act on a press the dialog has already taken.
  function onPanelKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    onKeydown?.(e);
    if (e.key === "Tab") wrapTab(e);
  }
</script>

<div class="overlay">
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
    onclick={onClose}
  ></button>
  <div
    bind:this={panel}
    class="modal"
    style:min-width={minWidth}
    style:gap
    onkeydown={onPanelKeydown}
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
