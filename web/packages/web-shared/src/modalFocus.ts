export function createModalFocus(options: {
  onClose: () => void;
  onKeydown?: (event: KeyboardEvent) => void;
  // A stack of workspace shells owns restoration across overlapping lifetimes.
  restoreFocus?: boolean;
}): {
  mount: (panel: HTMLElement) => () => void;
  onKeydown: (event: KeyboardEvent) => void;
} {
  let panel: HTMLElement | undefined;

  // The element that held focus when the dialog opened, read before the
  // panel takes it. Closing hands focus back, so the caret returns to the
  // surface that asked (a terminal, an editor) with no click. A target the
  // answer removed (a closed tab, a restarted terminal) is skipped.
  const active = document.activeElement;
  const returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;

  // Focus enters the dialog as it opens, so keys land here rather than in
  // the surface behind it. A body that parks focus on a control does so
  // after it renders and moves it on from the panel.
  function mount(node: HTMLElement): () => void {
    panel = node;
    panel.focus();
    return () => {
      if (options.restoreFocus !== false && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }

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
  // Shift+Tab before the first goes to the last. From the panel or outside,
  // either direction starts at its corresponding end. Between the ends the browser moves focus,
  // and a Tab a control inside has already taken (PathPromptModal's input
  // completes a path with it) stays that control's.
  function wrapTab(e: KeyboardEvent): void {
    if (!panel || e.defaultPrevented) return;
    const stops = tabStops(panel);
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const at = document.activeElement;
    const fromOutside = at === panel || !panel.contains(at);
    if (e.shiftKey && (at === first || fromOutside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || fromOutside)) {
      e.preventDefault();
      first.focus();
    }
  }

  // Escape closes this dialog and goes no further. App's document-level
  // handler answers Escape too, by closing the topmost overlay, and must
  // not act on a press the dialog has already taken.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      options.onClose();
      return;
    }
    options.onKeydown?.(e);
    if (e.key === "Tab") wrapTab(e);
  }

  return { mount, onKeydown };
}
