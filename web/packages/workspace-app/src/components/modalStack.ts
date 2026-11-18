import { canTakeFocus } from "@chan/web-shared/modal-focus";
import { handKeyboardToOwner, mayFocus, owner, registerKeyboardTaker } from "../state/keyboardOwner.svelte";

type ShellOptions = {
  layer: HTMLElement;
  panel: HTMLElement;
  opener: HTMLElement | null;
  onKeydown: (event: KeyboardEvent) => void;
};

type Shell = ShellOptions & { openers: HTMLElement[]; lastFocus: HTMLElement | null; untake: () => void };

const shells: Shell[] = [];
let generation = 0;
let queuedRepair: number | undefined;
let observer: MutationObserver | undefined;

function top(): Shell | undefined {
  return shells.at(-1);
}

function inside(shell: Shell, element: Element | null): element is HTMLElement {
  return canTakeFocus(element) && shell.panel.contains(element);
}

function repair(): void {
  const shell = top();
  if (!shell || inside(shell, document.activeElement)) return;
  // An owner of the dialogs' tier painted above them (a window-wide
  // survey) holds the keyboard, as does a cover over the window; the dialog
  // takes it back when the keyboard is handed back to it.
  if (owner()?.kind === "modal" && !mayFocus(shell.panel)) return;
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
  if (inside(shell, document.activeElement)) {
    shell.lastFocus = document.activeElement;
    // A dialog that takes focus under an owner of its tier painted above
    // it (its mount, its own field) hands that owner the keyboard back.
    if (owner()?.kind === "modal" && !mayFocus(shell.panel)) queueMicrotask(handKeyboardToOwner);
  } else {
    queueRepair();
  }
}

function onFocusOut(): void {
  const version = generation;
  setTimeout(() => {
    if (generation === version) repair();
  }, 0);
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
    // Handed the keyboard back, the top dialog's focus is repaired.
    untake: registerKeyboardTaker(options.panel, repair),
  };
  if (!previous) {
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
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
      const shouldRestore = !canTakeFocus(document.activeElement) || shell.panel.contains(document.activeElement);
      shells.splice(index, 1);
      shell.untake();
      const version = ++generation;
      setLayers();
      if (wasTop) observeTop();
      if (!top()) {
        document.removeEventListener("keydown", onKeydown, true);
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("focusout", onFocusOut, true);
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
        } else if (shouldRestore && !canTakeFocus(document.activeElement)) {
          // The last dialog gone, its opener gets the keyboard back only
          // where the keyboard's owner lets it. With every opener refused,
          // the keyboard is handed to that owner: a survey's card takes it,
          // and an overlay or the Computers launcher keeps what it holds.
          const opener = shell.openers.find((node) => canTakeFocus(node) && mayFocus(node));
          if (opener) opener.focus({ preventScroll: true });
          else handKeyboardToOwner();
        }
      });
    },
  };
}
