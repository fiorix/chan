// The carousel decks' positions, one per screen (Computers, Gateways). They
// live in a module across screen flips and in session storage across reloads
// of this browser tab or native panel. A card's own actions can turn its deck.
//
// `activeKey` names the card in front; `turn` counts whole steps around the
// ring, so a full ring keeps turning the same way past its last card instead of
// spinning back. `focusSeq` asks the carousel to move keyboard focus onto the
// card in front once it has turned. `openForm` asks the deck's Add card to turn
// over to its form; the card clears it when it does, so a later remount of the
// deck finds the card on its front again.

export type DeckName = "computers" | "gateways";

export interface DeckPosition {
  activeKey: string | null;
  turn: number;
  focusSeq: number;
  openForm: boolean;
}

function start(): DeckPosition {
  return { activeKey: null, turn: 0, focusSeq: 0, openForm: false };
}

const storageKey = (deck: DeckName): string => `chan.launcher-deck.v1:${deck}`;

function restore(deck: DeckName): DeckPosition {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey(deck)) ?? "null");
    if (saved && (saved.activeKey === null || typeof saved.activeKey === "string") && Number.isSafeInteger(saved.turn)) {
      return { ...start(), activeKey: saved.activeKey, turn: saved.turn };
    }
  } catch { /* A blocked or corrupt store starts this panel at its first card. */ }
  return start();
}

function persist(deck: DeckName): void {
  const { activeKey, turn } = decks[deck];
  try {
    window.sessionStorage.setItem(storageKey(deck), JSON.stringify({ activeKey, turn }));
  } catch { /* Navigation still works when storage is unavailable. */ }
}

export const decks = $state<Record<DeckName, DeckPosition>>({
  computers: restore("computers"),
  gateways: restore("gateways"),
});

/** Bring the card keyed `key` to the front of `deck`, optionally moving focus
 * onto it. */
export function showCard(deck: DeckName, key: string, options: { focus?: boolean; turn?: number } = {}): void {
  decks[deck].activeKey = key;
  if (options.turn !== undefined) decks[deck].turn = options.turn;
  if (options.focus) decks[deck].focusSeq += 1;
  persist(deck);
}

/** Bring the Add card keyed `key` to the front of `deck` already turned over to
 * its form, as a press on its front does, but leaving keyboard focus where it
 * is: the manual's devserver demo opens on the form inside a page the reader is
 * scrolling. */
export function showAddForm(deck: DeckName, key: string): void {
  showCard(deck, key);
  decks[deck].openForm = true;
}

/** Forget every deck's saved position. */
export function resetDeck(): void {
  decks.computers = start();
  decks.gateways = start();
  for (const deck of ["computers", "gateways"] as const) {
    try { window.sessionStorage.removeItem(storageKey(deck)); } catch { /* Best effort. */ }
  }
}
