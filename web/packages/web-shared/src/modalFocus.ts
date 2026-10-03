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

  // Restore the connected caller element so its caret resumes after dismissal.
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

  // Tab stops follow DOM order and require an enabled, rendered control
  // outside inert subtrees. Explicit tabindex takes precedence over kind.
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

  // Wrap Tab at the panel's ends. Between them, the browser moves focus;
  // controls such as path completion can consume Tab before this handler.
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

  // Consume Escape here so one press dismisses one surface.
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
