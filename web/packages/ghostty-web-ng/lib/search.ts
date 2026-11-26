import type { MatchRange, VtSearch } from '../vt/ghosttyVt';
import { EventEmitter } from './event-emitter';
import type { HighlightRange, HighlightsManager, HighlightStyle } from './highlights';
import type {
  ITheme, TerminalChange, TerminalCore, TerminalCoreTrackedCell, TerminalSearchState, TerminalViewport,
} from './interfaces';

const SCAN_BUDGET_MS = 4;
const PLACEMENT_BUDGET_MS = 4;
const FRAME_BUDGET_MS = 12;
const WAIT_CAP_MS = 1000;
const COST_PRIORS = { read: 4e-6, check: 2e-11, complete: 3e-11 } as const;
const LEARN_ROWS = 64;
const LEARN_CHECK = 1e11;
const STEP_FLOOR_MS = 1;
// Matches kept on each side of the active one from the list a write
// discards; presses beyond them wait for placement.
const BEFORE_REACH = 1024;
// Ranges per chunk of the canonical list; an insert splits a chunk that
// grows past twice this.
const CHUNK = 256;
const EMPTY: TerminalSearchState = Object.freeze({ index: 0, total: 0, partial: false });
type Direction = 'older' | 'newer';
type Waiting = { direction: Direction; at: number; newest?: boolean };
// A window of the list placed before a write, in the rows of the moment it
// was read: `ranges[0]` is entry `offset` of `total`, `index` the active
// match's entry, `history` the history rows then, and `anchor` a cell
// tracked on the last of them (null with no history), which only pruning
// moves.
type Before = {
  ranges: HighlightRange[]; offset: number; total: number; complete: boolean; index: number; history: number;
  anchor: TerminalCoreTrackedCell | null;
};
type Styles = { all: HighlightStyle; active: HighlightStyle };
type Parked = { start: TerminalCoreTrackedCell; end: TerminalCoreTrackedCell; before: Before | null };

/** Internal search and tracked-cell owner. Terminal exposes only its frozen facade. */
export class SearchOwner {
  private search: VtSearch | null = null;
  private needle = '';
  // The canonical list in position order, newest (bottom-most) first, each
  // complete range once. Chunked so growth never copies every known match
  // in one animation frame and an insert moves one chunk: `starts[i]` is
  // the list index of `chunks[i][0]`.
  private chunks: HighlightRange[][] = [];
  private starts: number[] = [];
  private total = 0;
  // The total before a change emptied the list. The count keeps it, as a
  // partial one, until the rebuilt list passes it or completes.
  private lastTotal = 0;
  private readCursor = 0;
  // Entries the core lists for its active area, ahead of its history, in
  // the list being placed. Where the page above soft-wraps into the active
  // area it lists that page's matches ahead of the screen page's, so until
  // placement has passed these entries the list placed so far can lack
  // matches newer than ones it holds. Read at the first feed of a scan;
  // null, unknown, once a write fed it again, until a press reads it.
  private head: number | null = null;
  // How many listed entries placement must read before the list placed so
  // far is the head of the whole one, read from those entries
  // (`orderedFrom`); null until read.
  private orderedAt: number | null = null;
  // While a list is placed: its first entry, the newest match of the first
  // page the core listed; the first entry of the page it is listing; the
  // first of the page it listed before that, which is that page's newest
  // match; and the last entry read. An entry newer than the one listed
  // before it starts a page.
  private firstListed: MatchRange | null = null;
  private listedPage: MatchRange | null = null;
  private pageAbove: MatchRange | null = null;
  private lastListed: MatchRange | null = null;
  // The scan starts from scratch at its next feed (a new needle, a restart,
  // a resize), which lists only the core's active area at first.
  private fresh = false;
  private index: number | null = null;
  private complete = true;
  private waiting: Waiting[] = [];
  private askedOver: HighlightRange | null = null;
  private kept: MatchRange | null = null;
  private keptStart: TerminalCoreTrackedCell | null = null;
  private keptEnd: TerminalCoreTrackedCell | null = null;
  // The last list that placed the active match, kept across the writes
  // since, so a press can step from it before placement reaches the match.
  private before: Before | null = null;
  // History rows when the list being placed was read, and a cell tracked on
  // the last of them for the window taken from that list.
  private listHistory = 0;
  private listAnchor: TerminalCoreTrackedCell | null = null;
  // The primary screen's active match, and the window to step from it,
  // while the alternate screen shows.
  private parked: Parked | null = null;
  private backlogCell: TerminalCoreTrackedCell | null = null;
  private keptOnScreen = false;
  private dirty = false;
  // Search work is waiting for the widget's next frame.
  private due = false;
  private readMs: number = COST_PRIORS.read;
  private checkMs: number = COST_PRIORS.check;
  private completeMs: number = COST_PRIORS.complete;
  private held = 0;
  private count = EMPTY;
  private disposed = false;
  private styles: Styles;
  private readonly changes = new EventEmitter<TerminalSearchState>();
  private readonly stopResizing: () => void;
  readonly onChange = this.changes.event;

  constructor(
    private readonly core: TerminalCore,
    private readonly highlights: HighlightsManager,
    private readonly viewport: TerminalViewport,
    private alternateScreen: boolean,
    private readonly selection: () => HighlightRange | null,
    private readonly createSearch: () => VtSearch,
    private readonly theme: () => ITheme,
  ) {
    this.styles = searchStyles(theme());
    this.stopResizing = core.beforeResize(({ rows }) => {
      const start = this.keptStart?.point();
      const top = this.core.getScrollbackLength() - Math.floor(this.viewport.offset);
      this.keptOnScreen = !!start && start.row >= top && start.row < top + rows;
    });
  }

  get state(): TerminalSearchState { return this.count; }

  find(query: string): void {
    if (this.disposed) return;
    if (!query) return this.close();
    if (this.prepare(query)) {
      this.waiting.push({ direction: 'older', at: performance.now(), newest: true });
      this.askedOver = this.selection();
    }
    this.schedule();
    this.publish();
  }

  step(query: string, direction: Direction): void {
    if (this.disposed) return;
    if (!query) return this.close();
    const deadline = performance.now() + PLACEMENT_BUDGET_MS;
    this.prepare(query);
    this.catchUp();
    this.readResults(deadline);
    this.waiting.push({ direction, at: performance.now() });
    this.askedOver = this.selection();
    const reveal = this.applyWaiting();
    this.schedule();
    this.show(reveal);
  }

  close(): void {
    this.release();
    this.publish();
  }

  /** Takes the theme's search colours. The terminal calls it on a theme change, ahead of its repaint. */
  restyle(): void {
    this.styles = searchStyles(this.theme());
    this.highlights.restyle('search-all', this.styles.all);
    if (this.kept) this.highlightActive();
  }

  dispose(): void {
    this.disposed = true;
    this.changes.dispose();
    this.release();
    this.count = EMPTY;
    this.stopResizing();
  }

  /**
   * Run the search work that is due. The widget calls this once in each
   * animation frame, ahead of its paint, and ahead of the echo paint inside
   * a write, so a paint that follows a change shows the refreshed matches
   * rather than the emptied layer.
   */
  runDue(): void {
    if (!this.due) return;
    this.due = false;
    this.pump();
  }

  /** Called after the core and viewport change, before a synchronous repaint. */
  changed(kind: TerminalChange['kind'], alternate: boolean): void {
    const switched = alternate !== this.alternateScreen;
    this.alternateScreen = alternate;
    if (!this.search) return;
    // Reflow moves rows unevenly, so only a write keeps a list to step
    // from. The primary screen's waits out the alternate screen with its
    // active match, since the other screen leaves its rows alone.
    if (kind === 'resize') {
      this.setBefore(null);
      this.parked?.before?.anchor?.free();
      if (this.parked) this.parked.before = null;
    } else if (this.kept && this.index !== null) {
      this.setBefore(this.window(this.index));
    }
    this.markList();
    this.dirty = true;
    // A resize resets the core's scan; after a write its listing has the
    // history it holds behind a new active area of unknown length.
    if (kind === 'resize') this.fresh = true;
    this.head = this.orderedAt = null;
    // The other screen's total says nothing about this one.
    this.lastTotal = switched ? 0 : Math.max(this.lastTotal, this.total);
    this.chunks = [];
    this.starts = [];
    this.total = 0;
    this.readCursor = 0;
    this.firstListed = this.listedPage = this.pageAbove = this.lastListed = null;
    this.index = null;
    this.complete = false;
    this.highlights.clear('search-all');
    if (switched && alternate) this.park();
    const range = switched ? null : this.keptRange();
    if (range) {
      this.kept = range;
      this.highlightActive();
      if (kind === 'resize' && this.keptOnScreen) this.viewport.reveal(range.startRow);
    } else {
      const lost = this.kept !== null;
      this.forget();
      if (switched && !alternate) this.unpark();
      if (switched || kind === 'resize' || lost) this.waiting = this.waiting.filter(step => step.newest);
    }
    this.schedule();
    this.publish();
  }

  private prepare(query: string): boolean {
    if (this.search && query === this.needle) return false;
    this.release();
    this.search = this.createSearch();
    this.search.setNeedle(query);
    this.needle = query;
    this.complete = false;
    this.fresh = true;
    this.markList();
    this.markBacklog();
    return true;
  }

  private release(): void {
    this.due = false;
    this.search?.free();
    this.search = null;
    this.forget();
    this.parked?.start.free();
    this.parked?.end.free();
    this.parked?.before?.anchor?.free();
    this.parked = null;
    this.backlogCell?.free();
    this.backlogCell = null;
    this.listAnchor?.free();
    this.listAnchor = null;
    this.highlights.clear('search-all');
    this.needle = '';
    this.chunks = [];
    this.starts = [];
    this.total = 0;
    this.lastTotal = 0;
    this.readCursor = 0;
    this.head = this.orderedAt = null;
    this.firstListed = this.listedPage = this.pageAbove = this.lastListed = null;
    this.waiting = [];
    this.askedOver = null;
    this.complete = true;
    this.dirty = this.fresh = false;
    this.readMs = COST_PRIORS.read;
    this.checkMs = COST_PRIORS.check;
    this.completeMs = COST_PRIORS.complete;
    this.held = 0;
  }

  private catchUp(): void {
    if (this.fresh) return this.feedFresh();
    if (!this.dirty) return;
    this.dirty = false;
    const search = this.search!;
    const point = this.backlogCell?.point();
    const rows = !this.backlogCell ? 0 : !point ? Infinity : Math.max(0, this.core.getScrollbackLength() - point.row);
    const cells = rows * this.core.cols;
    const checked = this.checked();
    const check = checked * this.checkMs;
    const complete = search.caughtUp();
    if (Number.isFinite(rows)) {
      const read = cells * this.readMs;
      const completion = checked * this.completeMs;
      const restart = complete
        ? check + read > FRAME_BUDGET_MS && completion < check + read
        : read >= SCAN_BUDGET_MS && read + completion > FRAME_BUDGET_MS;
      if (restart) {
        search.restart();
        return this.feedFresh();
      }
    }
    const started = performance.now();
    search.feed();
    const took = performance.now() - started;
    this.markBacklog();
    // Learn only complete-scan feeds large enough to exceed clock grain;
    // running scans skip the cost of dropping pruned matches.
    if (!Number.isFinite(rows) || took <= 0 || !complete) return;
    if (rows >= LEARN_ROWS) this.readMs = learned(this.readMs, Math.max(0, took - check) / cells, COST_PRIORS.read);
    else if (checked >= LEARN_CHECK) this.checkMs = learned(this.checkMs, took / checked, COST_PRIORS.check);
  }

  private feedFresh(): void {
    const search = this.search!;
    this.fresh = this.dirty = false;
    search.feed();
    this.markBacklog();
    this.head = search.state().total;
    this.orderedAt = null;
  }

  /**
   * Whether the list placed so far is the head of the whole list in
   * position order: complete, or placement has read as many listed
   * entries as the core's active-area entries ask (`orderedFrom`). With
   * `measure` an unknown count of them is read from a scratch search's
   * first feed, which lists the same active area alone, a cost only a
   * press pays; without it an unknown count reads as passed.
   */
  private ordered(measure: boolean): boolean {
    if (this.complete) return true;
    if (this.head === null && !measure) return true;
    const head = this.activeEntries();
    if (head === 0) return true;
    this.orderedAt ??= this.orderedFrom(head);
    return this.readCursor >= this.orderedAt;
  }

  // The count of the core's active-area entries, read where output made it
  // unknown. The core lists its active area first, so a search that lists
  // nothing has none and needs no scratch search.
  private activeEntries(): number {
    this.head ??= this.search!.state().total === 0 ? 0 : this.activeCount();
    return this.head;
  }

  private activeCount(): number {
    const scratch = this.createSearch();
    try {
      scratch.setNeedle(this.needle);
      scratch.feed();
      return scratch.state().total;
    } finally {
      scratch.free();
    }
  }

  // How many listed entries placement must read before the list placed so
  // far is the head of the whole one. The first `head` entries list the
  // core's active-area pages oldest first, each newest first, so their
  // last is newer than their first exactly when two pages hold matches;
  // otherwise every prefix of them is in position order. Where two do,
  // placement reads them all, and the entry after them too where the first
  // listed page can be the page above, which lies above the screen and
  // soft-wraps into it: a match wrapped across the boundary below it is in
  // neither page's entries, and the core lists it first in its history. A
  // match wrapped across a boundary on the screen is not listed while it
  // is there, so where the first listed page's newest match ends on the
  // screen, which puts that page on it, its entries suffice. An entry the
  // core cannot place reads as a page ahead of the page above, which only
  // makes a press wait.
  private orderedFrom(head: number): number {
    const first = this.search!.matchAt(0);
    const last = this.search!.matchAt(head - 1);
    if (!first || !last) return head + 1;
    if (order(last, highlight(first)) <= 0) return 0;
    return first.endRow >= this.core.getScrollbackLength() ? head : head + 1;
  }

  /**
   * The newest match, read from the core's listing while placement has
   * not passed the active-area entries, whatever shape they list; null
   * once it has, where the placed list's first entry is the newest, and
   * where the active area holds no match. Those entries list their pages
   * oldest first, each newest first, so the last page's entries are the
   * ones not older than the last entry, and the first of them is the
   * newest (entry 0 where they list one page); a binary search finds it.
   * An entry the core cannot place gives null, which leaves the press to
   * the ordering rule.
   */
  private listedNewest(): MatchRange | null {
    if (this.complete) return null;
    const head = this.activeEntries();
    if (head === 0 || this.readCursor > head) return null;
    const search = this.search!;
    const last = search.matchAt(head - 1);
    if (!last) return null;
    const oldest = highlight(last);
    let lo = 0;
    let hi = head - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const range = search.matchAt(mid);
      if (!range) return null;
      if (order(range, oldest) >= 0) hi = mid;
      else lo = mid + 1;
    }
    return search.matchAt(lo);
  }

  private checked(): number {
    return this.held * this.core.getScrollbackLength() * this.core.cols;
  }

  private markBacklog(): void {
    this.backlogCell = this.retrack(this.backlogCell, this.core.getScrollbackLength(), 0);
  }

  private markList(): void {
    this.listHistory = this.core.getScrollbackLength();
    // A list with no history has no history neighbour for a cell to measure.
    if (this.listHistory > 0) this.listAnchor = this.retrack(this.listAnchor, this.listHistory - 1, 0);
  }

  private schedule(): void {
    if (this.search) this.due = true;
  }

  private pump(): void {
    const search = this.search;
    if (!search) return;
    const started = performance.now();
    this.catchUp();
    const scanning = !search.caughtUp();
    const completion = this.checked() * this.completeMs;
    const left = FRAME_BUDGET_MS - (performance.now() - started) - completion;
    const budget = completion >= FRAME_BUDGET_MS ? SCAN_BUDGET_MS : Math.min(SCAN_BUDGET_MS, Math.max(STEP_FLOOR_MS, left));
    // Drain discovered results before scanning further. Placement and
    // publication have their own budget, shared across every batch.
    const pending = this.readCursor < search.state().total;
    const running = pending || performance.now() - started >= SCAN_BUDGET_MS
      ? scanning : search.step(budget) === 'running';
    if (scanning && !running && search.completingUnitMs) {
      this.held = search.state().total;
      const checked = this.checked();
      if (checked >= LEARN_CHECK) this.completeMs = learned(this.completeMs, search.completingUnitMs / checked, COST_PRIORS.complete);
    }
    // A new core snapshot can require a whole-buffer copy. Do not stack it
    // on a spent scan slice; pending placement gets a fresh slice next frame.
    this.readResults(pending
      ? Math.min(started + SCAN_BUDGET_MS + PLACEMENT_BUDGET_MS, performance.now() + PLACEMENT_BUDGET_MS)
      : started + SCAN_BUDGET_MS);
    const reveal = this.applyWaiting();
    // Schedule before notifying: a subscriber can close or replace the query.
    if (!this.complete || this.waiting.length > 0) this.schedule();
    this.show(reveal && this.askStands());
  }

  private readResults(deadline: number): void {
    const search = this.search!;
    const state = search.state();
    this.held = state.complete ? state.total : Math.max(state.total, this.held);
    while (this.readCursor < state.total && performance.now() < deadline) {
      const batch = search.readMatches(this.readCursor, deadline - performance.now());
      this.readCursor = batch.next;
      const added: HighlightRange[] = [];
      // The canonical list persists across scan pumps, but never across a
      // terminal mutation, which may move rows.
      for (const range of batch.ranges) {
        this.firstListed ??= range;
        if (!this.lastListed || compare(range, this.lastListed) > 0) {
          this.pageAbove = this.listedPage;
          this.listedPage = range;
        }
        this.lastListed = range;
        const painted = this.place(range);
        if (painted) added.push(painted);
      }
      this.highlights.append('search-all', added, this.styles.all);
      if (performance.now() >= deadline) break;
    }
    this.complete = state.complete && this.readCursor >= state.total;
    if (this.complete) this.lastTotal = 0;
    const range = this.keptRange();
    this.index = range ? this.placedIndex(range) : null;
    if (range) {
      // The tracked cells hold the match however long placement takes; a
      // completed list without it is what loses it.
      this.kept = range;
      if (this.index === null && this.complete) this.forget();
    }
  }

  /** Adds `range` at its position unless that complete range is listed; returns its highlight when added. */
  private place(range: MatchRange): HighlightRange | null {
    const last = this.chunks.at(-1);
    // The core lists newest first apart from its active area's pages, so
    // nearly every range is older than everything placed.
    if (!last || order(range, last[last.length - 1]) < 0) {
      const painted = highlight(range);
      if (!last || last.length >= CHUNK) {
        this.chunks.push([painted]);
        this.starts.push(this.total);
      } else {
        last.push(painted);
      }
      this.total++;
      return painted;
    }
    const { chunk, offset, found } = this.locate(range);
    if (found) return null;
    const painted = highlight(range);
    const ranges = this.chunks[chunk];
    ranges.splice(offset, 0, painted);
    for (let i = chunk + 1; i < this.starts.length; i++) this.starts[i]++;
    if (ranges.length > 2 * CHUNK) {
      this.chunks.splice(chunk + 1, 0, ranges.splice(CHUNK));
      this.starts.splice(chunk + 1, 0, this.starts[chunk] + CHUNK);
    }
    this.total++;
    return painted;
  }

  /** Where `range` belongs in a nonempty list: its chunk, its offset there, and whether that entry is the same range. */
  private locate(range: MatchRange): { chunk: number; offset: number; found: boolean } {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const ranges = this.chunks[mid];
      if (order(range, ranges[ranges.length - 1]) >= 0) hi = mid;
      else lo = mid + 1;
    }
    const ranges = this.chunks[lo];
    let offset = 0;
    let end = ranges.length;
    while (offset < end) {
      const mid = (offset + end) >> 1;
      if (order(range, ranges[mid]) >= 0) end = mid;
      else offset = mid + 1;
    }
    return { chunk: lo, offset, found: offset < ranges.length && order(range, ranges[offset]) === 0 };
  }

  /**
   * `range`'s index in the list placed so far; null when it is unplaced, or
   * while that list is not yet a prefix of the whole one, where its place
   * is not its index.
   */
  private placedIndex(range: MatchRange): number | null {
    return this.ordered(false) ? this.indexOf(range) ?? null : null;
  }

  private indexOf(range: MatchRange): number | undefined {
    if (this.total === 0) return undefined;
    const { chunk, offset, found } = this.locate(range);
    return found ? this.starts[chunk] + offset : undefined;
  }

  private at(index: number): HighlightRange {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return this.chunks[lo][index - this.starts[lo]];
  }

  private applyWaiting(): boolean {
    let selected = false;
    while (this.waiting.length) {
      const { direction, at } = this.waiting[0];
      if (this.kept !== null && this.index === null) {
        // Output, a restarted scan, a resize or the switch back from the
        // alternate screen has left the active match's index unplaced.
        // Applied from no active match the press would start over from the
        // newest or oldest match, so it steps from the list placed before
        // where it can (a resize keeps none), and otherwise waits for
        // placement up to its cap.
        const next = this.stepBefore(direction);
        if (next === 'newest' || (next === null && performance.now() - at >= WAIT_CAP_MS)) {
          this.forget();
          continue;
        }
        if (next === null) break;
        this.waiting.shift();
        this.index = this.placedIndex(next);
        this.keep(next);
        selected = true;
        continue;
      }
      // From no active match older lands on the newest, read from the
      // core's listing while placement has not passed the active-area
      // entries, so neither the order of the matches placed so far nor a
      // frame that placed none holds it back.
      const newest = direction === 'older' && this.index === null ? this.listedNewest() : null;
      if (newest) {
        this.waiting.shift();
        this.index = this.placedIndex(newest);
        this.keep(newest);
        selected = true;
        continue;
      }
      const total = this.total;
      // A press lands among the placed matches once they are the head of
      // the whole list in position order; from no active match older lands
      // on the newest.
      const lands = (direction === 'newer' ? this.index !== null && this.index > 0
        : this.index === null ? total > 0 : this.index < total - 1) && this.ordered(true);
      const capped = performance.now() - at >= WAIT_CAP_MS && total > 0;
      if (!this.complete && !lands && !capped) break;
      this.waiting.shift();
      if (!total) continue;
      this.index = direction === 'newer'
        ? this.index === null ? total - 1 : (this.index + total - 1) % total
        : this.index === null ? 0 : (this.index + 1) % total;
      this.keep(matchRange(this.at(this.index)));
      selected = true;
    }
    return selected;
  }

  /**
   * The active match's neighbour in the list placed before the writes that
   * left its index unplaced, where it is now; `newest` when that list was
   * complete and the press wraps from its oldest match; null when the
   * neighbour is unknown. Only pruning moves a history row, every row by
   * the count it removed, which the window's anchor measures; output
   * inside the screen, a scroll region's included, moves screen rows and
   * may rewrite them, so a neighbour that was on the screen is unknown.
   * Erasing the history drops the anchor with it.
   */
  private stepBefore(direction: Direction): MatchRange | 'newest' | null {
    const before = this.before;
    if (!before) return null;
    const next = before.index + (direction === 'older' ? 1 : -1);
    if (next === before.total && before.complete) return 'newest';
    const target = before.ranges[next - before.offset];
    const anchor = before.anchor?.point();
    if (!target || !anchor || target.end.absoluteRow >= before.history) return null;
    const shift = before.history - 1 - anchor.row;
    if (target.start.absoluteRow < shift) return null;
    before.index = next;
    return {
      startRow: target.start.absoluteRow - shift, startCol: target.start.col,
      endRow: target.end.absoluteRow - shift, endCol: target.end.col,
    };
  }

  private window(index: number): Before {
    let from = Math.max(0, index - BEFORE_REACH);
    let to = Math.min(this.total, index + BEFORE_REACH + 1);
    // Unless the list placed so far is known to be the head of the whole
    // one, a list the core lists pages ahead in can lack the matches of the
    // page being placed that lie between its placed ones and the newest
    // match of the page listed before it, and a match wrapped across the
    // boundary below the first listed page, which the core lists after
    // every page's entries. That holds with the count of the core's
    // active-area entries unknown, and also once a press has read it and
    // found the list not yet in position order, which leaves the index it
    // placed before the read. So the window ends at both newest matches,
    // the page listed before's and the first page's, on the side away from
    // the active match.
    const known = this.complete || (this.head !== null && this.ordered(false));
    const edges = known ? [] : [this.pageAbove, this.firstListed];
    for (const edge of edges) {
      const split = edge ? this.indexOf(edge) : undefined;
      if (split === undefined || split <= 0) continue;
      if (index < split) to = Math.min(to, split);
      else from = Math.max(from, split);
    }
    const ranges: HighlightRange[] = [];
    for (let i = from; i < to; i++) ranges.push(this.at(i));
    // The window takes the list's anchor; the next list tracks its own.
    const anchor = this.listAnchor;
    this.listAnchor = null;
    return { ranges, offset: from, total: this.total, complete: this.complete, index, history: this.listHistory, anchor };
  }

  private setBefore(next: Before | null): void {
    this.before?.anchor?.free();
    this.before = next;
  }

  // The primary screen's active match waits out the alternate screen in its
  // tracked cells, which the core keeps on the primary's rows.
  private park(): void {
    if (!this.kept || !this.keptStart || !this.keptEnd) return;
    this.parked = { start: this.keptStart, end: this.keptEnd, before: this.before };
    this.keptStart = this.keptEnd = null;
    this.before = null;
    this.forget();
  }

  private unpark(): void {
    const parked = this.parked;
    if (!parked) return;
    this.parked = null;
    this.keptStart = parked.start;
    this.keptEnd = parked.end;
    this.before = parked.before;
    this.kept = this.trackedRange();
    if (this.kept) this.highlightActive();
    else this.forget();
  }

  private keep(range: MatchRange): void {
    this.keptStart = this.retrack(this.keptStart, range.startRow, range.startCol);
    this.keptEnd = this.retrack(this.keptEnd, range.endRow, range.endCol);
    this.kept = this.keptStart && this.keptEnd ? range : null;
    if (!this.kept) this.forget();
  }

  private keptRange(): MatchRange | null {
    return this.kept ? this.trackedRange() : null;
  }

  private trackedRange(): MatchRange | null {
    const start = this.keptStart?.point();
    const end = this.keptEnd?.point();
    return start && end ? { startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col } : null;
  }

  private retrack(cell: TerminalCoreTrackedCell | null, row: number, col: number): TerminalCoreTrackedCell | null {
    if (cell?.moveTo(row, col)) return cell;
    cell?.free();
    return this.core.trackCell(row, col);
  }

  private forget(): void {
    this.keptStart?.free();
    this.keptEnd?.free();
    this.keptStart = this.keptEnd = null;
    this.kept = null;
    this.index = null;
    this.setBefore(null);
    this.highlights.clear('search-active');
  }

  private highlightActive(): void {
    if (this.kept) this.highlights.set('search-active', [highlight(this.kept)], this.styles.active);
    else this.highlights.clear('search-active');
  }

  private askStands(): boolean {
    const selection = this.selection();
    // A delayed step must not pull the viewport away from a new selection.
    return selection === null || (this.askedOver !== null &&
      selection.start.absoluteRow === this.askedOver.start.absoluteRow && selection.start.col === this.askedOver.start.col &&
      selection.end.absoluteRow === this.askedOver.end.absoluteRow && selection.end.col === this.askedOver.end.col);
  }

  private show(reveal: boolean): void {
    this.highlightActive();
    if (reveal && this.kept) this.viewport.reveal(this.kept.startRow);
    this.publish();
  }

  private publish(): void {
    const total = this.complete ? this.total : Math.max(this.total, this.lastTotal);
    const next: TerminalSearchState = Object.freeze({
      // A kept match whose index is unplaced has a position, just not a
      // known one, even before the rescan has counted anything.
      index: this.index !== null ? this.index + 1 : total === 0 && !this.kept ? 0 : null,
      total,
      partial: !this.complete,
    });
    if (next.index === this.count.index && next.total === this.count.total && next.partial === this.count.partial) return;
    this.count = next;
    this.changes.fire(next);
  }
}

function searchStyles(theme: ITheme): Styles {
  const all: HighlightStyle = { background: theme.searchMatchBackground ?? '#806d36' };
  if (theme.searchMatchForeground !== undefined) all.foreground = theme.searchMatchForeground;
  return {
    all,
    active: { background: theme.searchActiveMatchBackground ?? '#ffb454', foreground: theme.searchActiveMatchForeground ?? '#000000' },
  };
}
function matchRange(range: HighlightRange): MatchRange {
  return { startRow: range.start.absoluteRow, startCol: range.start.col, endRow: range.end.absoluteRow, endCol: range.end.col };
}
function highlight(range: MatchRange): HighlightRange {
  return { start: { absoluteRow: range.startRow, col: range.startCol }, end: { absoluteRow: range.endRow, col: range.endCol } };
}
// Positive when `a` comes after `b` in text order: nearer the prompt.
function order(a: MatchRange, b: HighlightRange): number {
  return a.startRow - b.start.absoluteRow || a.startCol - b.start.col || a.endRow - b.end.absoluteRow || a.endCol - b.end.col;
}
// The same order between two match ranges.
function compare(a: MatchRange, b: MatchRange): number {
  return a.startRow - b.startRow || a.startCol - b.startCol || a.endRow - b.endRow || a.endCol - b.endCol;
}
function learned(estimate: number, measured: number, floor: number): number {
  return Math.max(floor, (estimate + Math.min(measured, 1.5 * estimate)) / 2);
}
