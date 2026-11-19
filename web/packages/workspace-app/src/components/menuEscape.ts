import { appInputBlocked } from "../state/store.svelte";

type MenuEscapeOptions = {
  open: () => boolean;
  inside: (target: EventTarget | null) => boolean;
  close: () => void;
};

/// An open menu owns Escape. Capture stops a key aimed outside the menu before
/// the focused surface sees it; a key from inside reaches its field first and
/// closes the menu as it bubbles out. Closed menus and other keys are untouched,
/// and so is Escape aimed outside while a cover over the window, which paints
/// over every menu, holds the keyboard: that key is the cover's.
export function menuEscape({ open, inside, close }: MenuEscapeOptions): {
  capture: (event: KeyboardEvent) => void;
  bubble: (event: KeyboardEvent) => void;
} {
  return {
    capture(event) {
      if (event.key !== "Escape" || !open() || inside(event.target) || appInputBlocked()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    bubble(event) {
      if (event.key !== "Escape" || !open()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
  };
}
