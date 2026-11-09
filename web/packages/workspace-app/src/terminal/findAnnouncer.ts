/// What the find bar's live region says. The count the bar shows follows
/// the search on every frame while a scan runs or output streams, and a
/// screen reader speaks each change to a live region, so the region takes
/// the count only once it settles: a final count at once, then nothing for
/// an interval, at whose end the latest count goes. A partial count (a scan
/// still running, or a total that is a floor) goes only once it has stood
/// for an interval of its own without settling.

/// The least time between two announcements, and how long a partial count
/// stands before it is announced.
export const FIND_ANNOUNCE_INTERVAL_MS = 1000;

export class FindAnnouncer {
  private readonly say: (text: string) => void;
  private readonly intervalMs: number;
  /// What the region holds.
  private said = "";
  /// The bar's count as last updated, and whether it is final.
  private latest = "";
  private settled = true;
  /// Runs for an interval after each announcement; its end takes the
  /// latest count.
  private cooling: ReturnType<typeof setTimeout> | null = null;
  /// A partial count's interval.
  private waiting: ReturnType<typeof setTimeout> | null = null;

  constructor(say: (text: string) => void, intervalMs = FIND_ANNOUNCE_INTERVAL_MS) {
    this.say = say;
    this.intervalMs = intervalMs;
  }

  /// The bar's count is now `text`, blank when the bar shows none;
  /// `settled` when it is final rather than partial.
  update(text: string, settled: boolean): void {
    this.latest = text;
    this.settled = settled;
    if (!text) {
      // The query emptied or the bar closed: the region empties with the
      // count, and nothing is left to say later.
      this.stopWaiting();
      this.set("");
      return;
    }
    if (this.cooling) return;
    if (settled) {
      this.stopWaiting();
      this.announce();
    } else {
      this.waiting ??= setTimeout(() => {
        this.waiting = null;
        this.announce();
      }, this.intervalMs);
    }
  }

  dispose(): void {
    this.stopWaiting();
    if (this.cooling) clearTimeout(this.cooling);
    this.cooling = null;
  }

  private announce(): void {
    if (this.latest === this.said) return;
    this.set(this.latest);
    this.cooling = setTimeout(() => {
      this.cooling = null;
      if (this.latest !== this.said) this.update(this.latest, this.settled);
    }, this.intervalMs);
  }

  private stopWaiting(): void {
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = null;
  }

  private set(text: string): void {
    if (text === this.said) return;
    this.said = text;
    this.say(text);
  }
}
