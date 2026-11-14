import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { isTauriDesktop, readPrimarySelection, writePrimarySelection } from "../api/desktop";
import { currentOS } from "../state/shortcuts";
import { pasteIntoGhostty } from "./ghosttyPaste";
import { pasteIntoXterm } from "./xtermPaste";

export function isPrimarySelectionDesktop(): boolean {
  return isTauriDesktop() && currentOS() === "linux";
}

/// Mouse-only PRIMARY integration. Ghostty's selection writer handles its
/// automatic copies; xterm announces selection changes on document mouseup.
/// Capture owns the middle button before the renderer or WebKit can paste
/// it, and the right click before either widget can select its textarea;
/// `openMenu` opens chan's terminal menu for that click.
export function installTerminalPrimarySelection(
  host: HTMLElement,
  term: XtermTerminal | GhosttyTerminal,
  backend: "xterm" | "ghostty",
  openMenu: (event: MouseEvent) => void,
): (() => void) | null {
  if (!isPrimarySelectionDesktop()) return null;
  let alive = true;
  let gesture = 0;
  let selecting = false;
  let changed = false;
  let dragged = false;
  const selection = backend === "xterm" ? (term as XtermTerminal).onSelectionChange(() => {
    if (selecting) changed = true;
  }) : null;
  const onDown = (event: MouseEvent): void => {
    if (event.button === 0) {
      gesture += 1;
      selecting = true;
      changed = false;
      dragged = false;
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
  // A drag that ends on the cells of the previous selection announces no
  // change, yet xterm put that selection in its textarea again on the way,
  // which WebKitGTK copied into PRIMARY; the drag itself is the signal.
  const onMove = (event: MouseEvent): void => {
    if (selecting && (event.buttons & 1) !== 0) dragged = true;
  };
  const onRelease = (event: MouseEvent): void => {
    if (event.button !== 0 || !selecting) return;
    // xterm adds its document mouseup listener when the drag starts, after
    // this one, and announces the final selection from it. WebKitGTK runs
    // microtasks between the listeners of a real release, so the read waits
    // for a task of its own. Writing then also lands after WebKitGTK's copy
    // of the selection xterm keeps in its textarea, which turns line breaks
    // into spaces, so PRIMARY ends with the copy's text. A press before the
    // read starts a new gesture, whose release writes instead.
    const released = gesture;
    setTimeout(() => {
      if (!alive || released !== gesture) return;
      if (changed || dragged) {
        const text = term.getSelection();
        if (text) void writePrimarySelection(text);
      }
      selecting = false;
      changed = false;
      dragged = false;
    }, 0);
  };
  const onMiddle = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    term.focus();
    void readPrimarySelection().then((text) => {
      if (!alive || !text) return;
      if (backend === "ghostty") pasteIntoGhostty(term as GhosttyTerminal, text);
      else pasteIntoXterm(term as XtermTerminal, text);
    });
  };
  // Both widgets answer a right click by putting the selection in their
  // textarea and selecting it there, for a browser menu's Copy, and
  // WebKitGTK copies that selection into PRIMARY with line breaks as
  // spaces and runs of spaces collapsed. chan's menu copies the terminal's
  // own selection, so the click goes to it before the widgets see it.
  const onContextMenu = (event: MouseEvent): void => {
    event.stopImmediatePropagation();
    openMenu(event);
  };
  host.addEventListener("mousedown", onDown, true);
  host.addEventListener("mouseup", onUp, true);
  host.addEventListener("auxclick", onMiddle, true);
  if (backend === "xterm") host.addEventListener("mousemove", onMove, true);
  host.addEventListener("contextmenu", onContextMenu, true);
  host.ownerDocument.addEventListener("mouseup", onRelease);
  return () => {
    alive = false;
    selection?.dispose();
    host.removeEventListener("mousedown", onDown, true);
    host.removeEventListener("mouseup", onUp, true);
    host.removeEventListener("auxclick", onMiddle, true);
    host.removeEventListener("mousemove", onMove, true);
    host.removeEventListener("contextmenu", onContextMenu, true);
    host.ownerDocument.removeEventListener("mouseup", onRelease);
  };
}
