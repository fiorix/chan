import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { Terminal as GhosttyTerminal } from "ghostty-web";
import { isTauriDesktop, readPrimarySelection, writePrimarySelection } from "../api/desktop";
import { currentOS } from "../state/shortcuts";
import { pasteIntoGhostty } from "./ghosttyPaste";

export function isPrimarySelectionDesktop(): boolean {
  return isTauriDesktop() && currentOS() === "linux";
}

/// Mouse-only PRIMARY integration. Ghostty's selection writer handles its
/// automatic copies; xterm announces selection changes on document mouseup.
/// Capture owns the middle button before the renderer or WebKit can paste it.
export function installTerminalPrimarySelection(
  host: HTMLElement,
  term: XtermTerminal | GhosttyTerminal,
  backend: "xterm" | "ghostty",
): (() => void) | null {
  if (!isPrimarySelectionDesktop()) return null;
  let alive = true;
  let selecting = false;
  let changed = false;
  const selection = backend === "xterm" ? (term as XtermTerminal).onSelectionChange(() => {
    if (selecting) changed = true;
  }) : null;
  const onDown = (event: MouseEvent): void => {
    if (event.button === 0) {
      selecting = true;
      changed = false;
    } else if (event.button === 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const onUp = (event: MouseEvent): void => {
    if (event.button === 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const onRelease = (event: MouseEvent): void => {
    if (event.button !== 0 || !selecting) return;
    // xterm registers its document mouseup listener when the drag starts,
    // after ours. Read once it has fired the final selection change.
    queueMicrotask(() => {
      if (!alive) return;
      if (changed) {
        const text = term.getSelection();
        if (text) void writePrimarySelection(text);
      }
      selecting = false;
      changed = false;
    });
  };
  const onMiddle = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    term.focus();
    void readPrimarySelection().then((text) => {
      if (!alive || !text) return;
      if (backend === "ghostty") pasteIntoGhostty(term as GhosttyTerminal, text);
      else term.paste(text);
    });
  };
  host.addEventListener("mousedown", onDown, true);
  host.addEventListener("mouseup", onUp, true);
  host.addEventListener("auxclick", onMiddle, true);
  host.ownerDocument.addEventListener("mouseup", onRelease);
  return () => {
    alive = false;
    selection?.dispose();
    host.removeEventListener("mousedown", onDown, true);
    host.removeEventListener("mouseup", onUp, true);
    host.removeEventListener("auxclick", onMiddle, true);
    host.ownerDocument.removeEventListener("mouseup", onRelease);
  };
}
