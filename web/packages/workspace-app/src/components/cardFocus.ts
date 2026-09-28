// The keyboard a corner card takes while it asks something (a `cs paste`
// request, a session handover) and gives back when it goes, so typing reaches
// the terminal again with no click.

/// `take` focuses the card and, the first time, remembers the element that
/// held focus. `release` gives focus back to that element when focus fell to
/// the page with the card; focus the user moved elsewhere, or an element that
/// is gone, is left alone.
export function createCardFocus(): { take: (card: HTMLElement) => void; release: () => void } {
  let taken = false;
  let returnTo: HTMLElement | null = null;
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
      card.focus();
    },
    release() {
      if (!taken) return;
      taken = false;
      const to = returnTo;
      returnTo = null;
      const now = document.activeElement;
      if (to?.isConnected && (now === null || now === document.body)) to.focus({ preventScroll: true });
    },
  };
}
