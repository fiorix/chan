import type { Terminal } from "@chan/ghostty-web-ng";
import { isTauriDesktop, readPrimarySelection } from "../api/desktop";
import { currentOS } from "../state/shortcuts";
import { pasteIntoGhostty } from "./ghosttyPaste";

export function isPrimarySelectionDesktop(): boolean {
  return isTauriDesktop() && currentOS() === "linux";
}

/// Mouse-only PRIMARY integration. The widget's selection writer handles
/// its automatic copies (TerminalTab's `copy` option writes PRIMARY as
/// well as the clipboard). Capture owns the middle button before the widget can report it or
/// WebKit can paste it, and the right click before the widget can select
/// its textarea; `openMenu` opens chan's terminal menu for that click. The
/// middle press reaches neither the widget nor the pane around it, so
/// `focus` does what a left press does through both: it makes the
/// terminal's pane the active one and gives the terminal the keyboard.
export function installTerminalPrimarySelection(
  host: HTMLElement,
  term: Terminal,
  openMenu: (event: MouseEvent) => void,
  focus: () => void,
): (() => void) | null {
  if (!isPrimarySelectionDesktop()) return null;
  let alive = true;
  // The widget captures and reports a press from its pointerdown and leaves
  // a cancelled one to the embedder, so the middle press is cancelled here,
  // before the canvas sees it; auxclick owns the PRIMARY paste.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 1) event.preventDefault();
  };
  const holdMiddle = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onMiddle = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focus();
    void readPrimarySelection().then((text) => {
      if (!alive || !text) return;
      pasteIntoGhostty(term, text);
    });
  };
  // The widget answers a right click by putting the selection in its
  // textarea and selecting it there, for a browser menu's Copy, and
  // WebKitGTK copies that selection into PRIMARY with line breaks as
  // spaces and runs of spaces collapsed. chan's menu copies the terminal's
  // own selection, so the click goes to it before the widget sees it.
  const onContextMenu = (event: MouseEvent): void => {
    event.stopImmediatePropagation();
    openMenu(event);
  };
  host.addEventListener("pointerdown", onPointerDown, true);
  host.addEventListener("mousedown", holdMiddle, true);
  host.addEventListener("mouseup", holdMiddle, true);
  host.addEventListener("auxclick", onMiddle, true);
  host.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    alive = false;
    host.removeEventListener("pointerdown", onPointerDown, true);
    host.removeEventListener("mousedown", holdMiddle, true);
    host.removeEventListener("mouseup", holdMiddle, true);
    host.removeEventListener("auxclick", onMiddle, true);
    host.removeEventListener("contextmenu", onContextMenu, true);
  };
}
