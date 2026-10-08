// The keyboard a corner card takes while it asks something (a `cs paste`
// request, a session handover) and gives back when it goes, so typing reaches
// the terminal again with no click.

interface FocusTarget {
  element: HTMLElement;
  previous: FocusTarget | null;
}

// Snapshot the chain while the DOM still connects a focused button to its card.
const predecessors = new WeakMap<HTMLElement, FocusTarget | null>();

function remember(element: HTMLElement): FocusTarget {
  let ancestor: HTMLElement | null = element;
  while (ancestor && !predecessors.has(ancestor)) ancestor = ancestor.parentElement;
  const previous = ancestor ? predecessors.get(ancestor) ?? null : null;
  return { element, previous: ancestor && ancestor !== element ? { element: ancestor, previous } : previous };
}

/// `take` remembers the prior focus once per lifetime. `release` follows removed cards to a connected predecessor, leaving focus the user moved elsewhere alone.
export function createCardFocus(): { take: (card: HTMLElement) => void; release: () => void } {
  let taken = false;
  let returnTo: FocusTarget | null = null;
  let owner: HTMLElement | null = null;
  return {
    take(card) {
      if (!taken) {
        const active = document.activeElement;
        returnTo =
          active instanceof HTMLElement && active !== document.body && !card.contains(active)
            ? remember(active)
            : null;
        taken = true;
      }
      owner = card;
      predecessors.set(card, returnTo);
      card.focus();
    },
    release() {
      if (!taken) return;
      taken = false;
      let to = returnTo;
      returnTo = null;
      const now = document.activeElement;
      const canRestore = now === null || now === document.body || !!owner?.contains(now);
      owner = null;
      while (to && !to.element.isConnected) to = to.previous;
      if (to && canRestore) to.element.focus({ preventScroll: true });
    },
  };
}
