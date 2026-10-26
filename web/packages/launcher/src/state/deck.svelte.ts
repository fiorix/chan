// The carousel decks' positions, one per screen (Computers, Gateways). They
// live in a module so the card in front survives the remount that a flip
// between the two screens causes, and so a card's own actions (an Add card
// bringing the entry it saved forward) can turn its deck.
//
// `activeKey` names the card in front; `turn` counts whole steps around the
// ring, so a full ring keeps turning the same way past its last card instead of
// spinning back. `focusSeq` asks the carousel to move keyboard focus onto the
// card in front once it has turned.

export type DeckName = "computers" | "gateways";

export interface DeckPosition {
  activeKey: string | null;
  turn: number;
  focusSeq: number;
}

function start(): DeckPosition {
  return { activeKey: null, turn: 0, focusSeq: 0 };
}

export const decks = $state<Record<DeckName, DeckPosition>>({
  computers: start(),
  gateways: start(),
});

/** Bring the card keyed `key` to the front of `deck`, optionally moving focus
 * onto it. */
export function showCard(deck: DeckName, key: string, options: { focus?: boolean } = {}): void {
  decks[deck].activeKey = key;
  if (options.focus) decks[deck].focusSeq += 1;
}

/** Forget every deck's position (tests, and a fresh mount of the whole app). */
export function resetDeck(): void {
  decks.computers = start();
  decks.gateways = start();
}
