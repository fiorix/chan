// Body-attached popovers retain their editor's lifetime even when their
// anchor is a synthetic caret element outside the editor DOM.

const owners = new WeakMap<HTMLElement, EditorOverlayLifetime>();

function ownerOf(anchor: HTMLElement): EditorOverlayLifetime | undefined {
  for (let el: HTMLElement | null = anchor; el; el = el.parentElement) {
    const owner = owners.get(el);
    if (owner) return owner;
  }
}

export class EditorOverlayLifetime {
  private readonly dismissers = new Set<() => void>();
  private destroyed = false;

  constructor(root: HTMLElement, private readonly shown: () => boolean) {
    owners.set(root, this);
  }

  track(dismiss: () => void): () => void {
    if (this.destroyed || !this.shown()) {
      dismiss();
      return () => {};
    }
    this.dismissers.add(dismiss);
    return () => { this.dismissers.delete(dismiss); };
  }

  dismiss(): void {
    const pending = [...this.dismissers];
    this.dismissers.clear();
    for (const dismiss of pending) dismiss();
  }

  destroy(): void {
    this.destroyed = true;
    this.dismiss();
    // Keep the weak association: a deferred opener holding a detached
    // editor or caret anchor must still find its destroyed owner.
  }
}

/// Associate a body-attached caret anchor with its editor's owner.
export function inheritEditorOverlayLifetime(anchor: HTMLElement, editor: HTMLElement): void {
  const owner = ownerOf(editor);
  if (owner) owners.set(anchor, owner);
}

/// Register after constructing the popover: a hidden or destroyed editor
/// dismisses it immediately. The returned cleanup releases a normal close.
export function trackEditorOverlay(anchor: HTMLElement, dismiss: () => void): () => void {
  return ownerOf(anchor)?.track(dismiss) ?? (() => {});
}
