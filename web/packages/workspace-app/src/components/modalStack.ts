type ShellOptions = {
  layer: HTMLElement;
  panel: HTMLElement;
  opener: HTMLElement | null;
  onKeydown: (event: KeyboardEvent) => void;
};

type Shell = ShellOptions & { openers: HTMLElement[]; lastFocus: HTMLElement | null };

const shells: Shell[] = [];
let generation = 0;
let queuedRepair: number | undefined;
let observer: MutationObserver | undefined;

function top(): Shell | undefined {
  return shells.at(-1);
}

function usable(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || element === document.body) return false;
  if (element.matches(":disabled") || element.closest("[inert], [hidden]")) return false;
  if (getComputedStyle(element).visibility !== "visible") return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

function inside(shell: Shell, element: Element | null): element is HTMLElement {
  return usable(element) && shell.panel.contains(element);
}

function repair(): void {
  const shell = top();
  if (!shell || inside(shell, document.activeElement)) return;
  const target = inside(shell, shell.lastFocus) ? shell.lastFocus : shell.panel;
  target.focus({ preventScroll: true });
  // A focus callback can mount or remove a shell synchronously.
  if (top() !== shell) queueRepair();
}

function queueRepair(): void {
  const version = generation;
  if (queuedRepair === version) return;
  queuedRepair = version;
  queueMicrotask(() => {
    if (queuedRepair === version) queuedRepair = undefined;
    if (generation === version) repair();
  });
}

function onFocusIn(): void {
  const shell = top();
  if (!shell) return;
  if (inside(shell, document.activeElement)) shell.lastFocus = document.activeElement;
  else queueRepair();
}

function onKeydown(event: KeyboardEvent): void {
  let shell = top();
  if (!shell) return;
  if (event.key === "Escape") {
    event.stopPropagation();
    shell.onKeydown(event);
  } else if (event.key === "Tab" &&
      (!inside(shell, document.activeElement) || !inside(shell, event.target as Element | null))) {
    // A disabled control may remain activeElement. The shared wrapper must
    // start from the panel, not mistake it for an interior native Tab stop.
    event.stopPropagation();
    shell.panel.focus({ preventScroll: true });
    shell = top();
    shell?.onKeydown(event);
  }
}

function observeTop(): void {
  observer?.disconnect();
  const shell = top();
  if (!shell) return;
  observer ??= new MutationObserver(queueRepair);
  observer.observe(shell.panel, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "inert", "style", "class", "tabindex"],
  });
}

function setLayers(): void {
  shells.forEach((shell, index) => { shell.layer.style.zIndex = String(26000 + index); });
}

/** Register one mounted ModalShell. Only actual unmount ends its ownership. */
export function registerModalShell(options: ShellOptions): { isTop: () => boolean; destroy: () => void } {
  const previous = top();
  const shell: Shell = {
    ...options,
    openers: [...new Set([options.opener, ...(previous?.openers ?? [])].filter((node): node is HTMLElement => node !== null))],
    lastFocus: null,
  };
  if (!previous) {
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", queueRepair, true);
  }
  shells.push(shell);
  generation++;
  setLayers();
  observeTop();

  return {
    isTop: () => top() === shell,
    destroy: () => {
      const index = shells.indexOf(shell);
      if (index === -1) return;
      const wasTop = top() === shell;
      const shouldRestore = !usable(document.activeElement) || shell.panel.contains(document.activeElement);
      shells.splice(index, 1);
      const version = ++generation;
      setLayers();
      if (wasTop) observeTop();
      if (!top()) {
        document.removeEventListener("keydown", onKeydown, true);
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("focusout", queueRepair, true);
        observer = undefined;
      }
      if (!wasTop) {
        queueRepair();
        return;
      }
      // Wait for unmount and caller focus work. A new mount invalidates this
      // restoration, even if it happens before the same flush finishes.
      queueMicrotask(() => {
        if (generation !== version) return;
        const remaining = top();
        if (remaining) {
          if (inside(remaining, document.activeElement)) return;
          const opener = shell.openers.find((node) => inside(remaining, node));
          if (opener) opener.focus({ preventScroll: true });
          repair();
        } else if (shouldRestore && !usable(document.activeElement)) {
          shell.openers.find(usable)?.focus({ preventScroll: true });
        }
      });
    },
  };
}
