type MenuEscapeOptions = {
  open: () => boolean;
  inside: (target: EventTarget | null) => boolean;
  close: () => void;
};

/// An open menu owns Escape. Capture stops a key aimed outside the menu before
/// the focused surface sees it; a key from inside reaches its field first and
/// closes the menu as it bubbles out. Closed menus and other keys are untouched.
export function menuEscape({ open, inside, close }: MenuEscapeOptions): {
  capture: (event: KeyboardEvent) => void;
  bubble: (event: KeyboardEvent) => void;
} {
  return {
    capture(event) {
      if (event.key !== "Escape" || !open() || inside(event.target)) return;
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
