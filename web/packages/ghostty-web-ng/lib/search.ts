import type { MatchRange, VtSearch } from '../vt/ghosttyVt';
import { EventEmitter } from './event-emitter';
import type { HighlightRange, HighlightsManager } from './highlights';
import type {
  TerminalChange, TerminalCore, TerminalCoreTrackedCell, TerminalSearchState, TerminalViewport,
} from './interfaces';

const SCAN_BUDGET_MS = 4;
const PLACEMENT_BUDGET_MS = 4;
const FRAME_BUDGET_MS = 12;
const WAIT_CAP_MS = 1000;
const COST_PRIORS = { read: 4e-6, check: 2e-11, complete: 3e-11 } as const;
const LEARN_ROWS = 64;
const LEARN_CHECK = 1e11;
const STEP_FLOOR_MS = 1;
const EMPTY: TerminalSearchState = Object.freeze({ index: 0, total: 0, partial: false });
type Direction = 'older' | 'newer';
type Waiting = { direction: Direction; at: number; newest?: boolean };
type MatchIndex = Map<number, number | number[]>;
type Parked = { start: TerminalCoreTrackedCell; end: TerminalCoreTrackedCell };

/** Internal search and tracked-cell owner. Terminal exposes only its frozen facade. */
export class SearchOwner {
  private search: VtSearch | null = null;
  private needle = '';
  private matches: HighlightRange[][] = [];
  private total = 0;
  // The total before a change emptied the list. The count keeps it, as a
  // partial one, until the rebuilt list passes it or completes.
  private lastTotal = 0;
  // Shard the index and chunk the list so growth never rehashes or copies
  // every known match in one animation frame.
  private indices: MatchIndex[] = Array.from({ length: 256 }, () => new Map());
  private readCursor = 0;
  private index: number | null = null;
  private complete = true;
  private waiting: Waiting[] = [];
  private askedOver: HighlightRange | null = null;
  private kept: MatchRange | null = null;
  private keptStart: TerminalCoreTrackedCell | null = null;
  private keptEnd: TerminalCoreTrackedCell | null = null;
  // The primary screen's active match while the alternate screen shows.
  private parked: Parked | null = null;
  private backlogCell: TerminalCoreTrackedCell | null = null;
  private restoreAt: number | null = null;
  private keptOnScreen = false;
  private dirty = false;
  private resized = false;
  // Search work is waiting for the widget's next frame.
  private due = false;
  private readMs: number = COST_PRIORS.read;
  private checkMs: number = COST_PRIORS.check;
  private completeMs: number = COST_PRIORS.complete;
  private held = 0;
  private count = EMPTY;
  private disposed = false;
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
  ) {
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
    if (this.prepare(query)) this.search!.feed();
    else this.catchUp();
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
    this.dirty = true;
    this.resized ||= kind === 'resize';
    // The other screen's total says nothing about this one.
    this.lastTotal = switched ? 0 : Math.max(this.lastTotal, this.total);
    this.matches = [];
    this.total = 0;
    this.indices = Array.from({ length: 256 }, () => new Map());
    this.readCursor = 0;
    this.index = null;
    this.complete = false;
    this.highlights.clear('search-all');
    if (switched && alternate) this.park();
    const range = switched ? null : this.keptRange();
    if (range) {
      this.kept = range;
      if (kind === 'resize') this.restoreAt = performance.now();
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
    this.parked = null;
    this.backlogCell?.free();
    this.backlogCell = null;
    this.highlights.clear('search-all');
    this.needle = '';
    this.matches = [];
    this.total = 0;
    this.lastTotal = 0;
    this.indices = Array.from({ length: 256 }, () => new Map());
    this.readCursor = 0;
    this.waiting = [];
    this.askedOver = null;
    this.complete = true;
    this.dirty = this.resized = false;
    this.readMs = COST_PRIORS.read;
    this.checkMs = COST_PRIORS.check;
    this.completeMs = COST_PRIORS.complete;
    this.held = 0;
  }

  private catchUp(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const search = this.search!;
    const resized = this.resized;
    this.resized = false;
    const point = this.backlogCell?.point();
    const rows = !this.backlogCell ? 0 : !point ? Infinity : Math.max(0, this.core.getScrollbackLength() - point.row);
    const cells = rows * this.core.cols;
    const checked = this.checked();
    const check = checked * this.checkMs;
    const complete = search.caughtUp();
    if (!resized && Number.isFinite(rows)) {
      const read = cells * this.readMs;
      const completion = checked * this.completeMs;
      const restart = complete
        ? check + read > FRAME_BUDGET_MS && completion < check + read
        : read >= SCAN_BUDGET_MS && read + completion > FRAME_BUDGET_MS;
      if (restart) {
        // Repeated output restarts must not renew the restoration deadline.
        if (this.kept && this.restoreAt === null) this.restoreAt = performance.now();
        search.restart();
        this.markBacklog();
        return;
      }
    }
    const started = performance.now();
    search.feed();
    const took = performance.now() - started;
    this.markBacklog();
    // Learn only complete-scan feeds large enough to exceed clock grain;
    // running scans skip the cost of dropping pruned matches.
    if (resized || !Number.isFinite(rows) || took <= 0 || !complete) return;
    if (rows >= LEARN_ROWS) this.readMs = learned(this.readMs, Math.max(0, took - check) / cells, COST_PRIORS.read);
    else if (checked >= LEARN_CHECK) this.checkMs = learned(this.checkMs, took / checked, COST_PRIORS.check);
  }

  private checked(): number {
    return this.held * this.core.getScrollbackLength() * this.core.cols;
  }

  private markBacklog(): void {
    this.backlogCell = this.retrack(this.backlogCell, this.core.getScrollbackLength(), 0);
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
    if (!this.complete || this.waiting.length > 0 || this.restoreAt !== null) this.schedule();
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
      // The canonical index persists across scan pumps, but never across a
      // terminal mutation: rows and the core's result order may then change.
      for (const range of batch.ranges) {
        if (this.indexOf(range) !== undefined) continue;
        const key = startKey(range);
        const indices = this.indexFor(range);
        const previous = indices.get(key);
        if (previous === undefined) indices.set(key, this.total);
        else if (typeof previous === 'number') indices.set(key, [previous, this.total]);
        else previous.push(this.total);
        const painted = highlight(range);
        if (this.total % 256 === 0) this.matches.push([]);
        this.matches.at(-1)!.push(painted);
        this.total++;
        added.push(painted);
      }
      this.highlights.append('search-all', added, { background: '#806d36' });
      if (performance.now() >= deadline) break;
    }
    this.complete = state.complete && this.readCursor >= state.total;
    if (this.complete) this.lastTotal = 0;
    const range = this.keptRange();
    const index = range ? this.indexOf(range) : undefined;
    this.index = index ?? null;
    if (range) {
      this.kept = range;
      if (this.restoreAt !== null && performance.now() - this.restoreAt >= WAIT_CAP_MS) this.forget();
      else if (index !== undefined) this.restoreAt = null;
      else if (this.complete) this.forget();
    } else if (this.kept) {
      this.forget();
    }
  }

  private indexFor(range: MatchRange): MatchIndex {
    return this.indices[(Math.imul(range.startRow, 31) + range.startCol) & 255];
  }

  private indexOf(range: MatchRange): number | undefined {
    const found = this.indexFor(range).get(startKey(range));
    if (found === undefined) return undefined;
    const sameEnd = (index: number) => {
      const end = this.matches[Math.floor(index / 256)][index % 256].end;
      return end.absoluteRow === range.endRow && end.col === range.endCol;
    };
    if (typeof found === 'number') return sameEnd(found) ? found : undefined;
    return found?.find(sameEnd);
  }

  private applyWaiting(): boolean {
    if (this.restoreAt !== null) return false;
    let selected = false;
    while (this.waiting.length) {
      const { direction, at } = this.waiting[0];
      const total = this.total;
      const restoring = this.kept !== null && this.index === null;
      const lands = !restoring && (direction === 'newer' ? this.index !== null && this.index > 0
        : this.index === null ? total > 0 : this.index < total - 1);
      // A press made while the kept match's index is unplaced has no
      // deadline: applied without the index it would start over from the
      // newest or oldest match. It goes through once placement finds the
      // index or the match is lost.
      const capped = !restoring && performance.now() - at >= WAIT_CAP_MS && total > 0;
      if (!this.complete && !lands && !capped) break;
      this.waiting.shift();
      if (!total) continue;
      this.index = direction === 'newer'
        ? this.index === null ? total - 1 : (this.index + total - 1) % total
        : this.index === null ? 0 : (this.index + 1) % total;
      const range = this.matches[Math.floor(this.index / 256)][this.index % 256];
      this.keep({ startRow: range.start.absoluteRow, startCol: range.start.col,
        endRow: range.end.absoluteRow, endCol: range.end.col });
      selected = true;
    }
    return selected;
  }

  // The primary screen's active match waits out the alternate screen in its
  // tracked cells, which the core keeps on the primary's rows.
  private park(): void {
    if (!this.kept || !this.keptStart || !this.keptEnd) return;
    this.parked = { start: this.keptStart, end: this.keptEnd };
    this.keptStart = this.keptEnd = null;
    this.forget();
  }

  private unpark(): void {
    const parked = this.parked;
    if (!parked) return;
    this.parked = null;
    this.keptStart = parked.start;
    this.keptEnd = parked.end;
    this.kept = this.trackedRange();
    if (this.kept) this.highlightActive();
    else this.forget();
  }

  private keep(range: MatchRange): void {
    this.keptStart = this.retrack(this.keptStart, range.startRow, range.startCol);
    this.keptEnd = this.retrack(this.keptEnd, range.endRow, range.endCol);
    this.kept = this.keptStart && this.keptEnd ? range : null;
    this.restoreAt = null;
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
    this.restoreAt = null;
    this.highlights.clear('search-active');
  }

  private highlightActive(): void {
    if (this.kept) this.highlights.set('search-active', [highlight(this.kept)], { background: '#ffb454', foreground: '#000000' });
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
      index: total === 0 ? 0 : this.index === null ? null : this.index + 1,
      total,
      partial: !this.complete,
    });
    if (next.index === this.count.index && next.total === this.count.total && next.partial === this.count.partial) return;
    this.count = next;
    this.changes.fire(next);
  }
}

function highlight(range: MatchRange): HighlightRange {
  return { start: { absoluteRow: range.startRow, col: range.startCol }, end: { absoluteRow: range.endRow, col: range.endCol } };
}
function startKey(range: MatchRange): number {
  // Core rows are u32 and columns u16, fitting exactly in a JS number.
  return range.startRow * 0x1_0000 + range.startCol;
}
function learned(estimate: number, measured: number, floor: number): number {
  return Math.max(floor, (estimate + Math.min(measured, 1.5 * estimate)) / 2);
}
