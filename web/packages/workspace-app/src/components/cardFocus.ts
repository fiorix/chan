// The keyboard a corner card takes while it asks something (a `cs paste`
// request, a session handover) and gives back when it goes, so typing reaches
// the terminal again with no click.

// Weak keys retain a removed card's predecessor while another request still remembers that card, without retaining detached DOM forever.
const predecessors = new WeakMap<HTMLElement, HTMLElement | null>();

/// `take` remembers the prior focus once per lifetime. `release` follows removed cards to a connected predecessor, leaving focus the user moved elsewhere alone.
export function createCardFocus(): { take: (card: HTMLElement) => void; release: () => void } {
  let taken = false;
  let returnTo: HTMLElement | null = null;
  let owner: HTMLElement | null = null;
  return {
    take(card) {
      if (!taken) {
        const active = document.activeElement;
        returnTo =
          active instanceof HTMLElement && active !== document.body && !card.contains(active)
            ? active
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
      const visited = new Set<HTMLElement>();
      while (to && !to.isConnected && !visited.has(to)) {
        visited.add(to);
        to = predecessors.get(to) ?? null;
      }
      if (to?.isConnected && canRestore) to.focus({ preventScroll: true });
    },
  };
}
