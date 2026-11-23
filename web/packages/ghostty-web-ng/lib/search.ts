import type { MatchRange } from '../vt/ghosttyVt';
import { EventEmitter } from './event-emitter';
import type { HighlightRange } from './highlights';
import type {
  TerminalChange, TerminalCore, TerminalCoreSearch, TerminalCoreTrackedCell,
  TerminalHighlights, TerminalSearchState, TerminalViewport,
} from './interfaces';

const SCAN_BUDGET_MS = 4;
const FRAME_BUDGET_MS = 12;
const WAIT_CAP_MS = 1000;
const COST_PRIORS = { read: 4e-6, check: 2e-11, complete: 3e-11 } as const;
const LEARN_ROWS = 64;
const LEARN_CHECK = 1e11;
const STEP_FLOOR_MS = 1;
const EMPTY: TerminalSearchState = Object.freeze({ index: 0, total: 0, partial: false });
type Direction = 'older' | 'newer';
type Waiting = { direction: Direction; at: number; newest?: boolean };

/** Internal search and tracked-cell owner. Terminal exposes only its frozen facade. */
export class SearchOwner {
  private search: TerminalCoreSearch | null = null;
  private needle = '';
  private matches: MatchRange[] = [];
  private index: number | null = null;
  private complete = true;
  private waiting: Waiting[] = [];
  private kept: MatchRange | null = null;
  private keptStart: TerminalCoreTrackedCell | null = null;
  private keptEnd: TerminalCoreTrackedCell | null = null;
  private backlogCell: TerminalCoreTrackedCell | null = null;
  private restoreAt: number | null = null;
  private keptOnScreen = false;
  private dirty = false;
  private resized = false;
  private frame: number | undefined;
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
    private readonly highlights: TerminalHighlights,
    private readonly viewport: TerminalViewport,
    private alternateScreen: boolean,
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
    if (this.prepare(query)) this.waiting.push({ direction: 'older', at: performance.now(), newest: true });
    this.schedule();
    this.publish();
  }

  step(query: string, direction: Direction): void {
    if (this.disposed) return;
    if (!query) return this.close();
    if (this.prepare(query)) this.search!.feed();
    else this.catchUp();
    this.readResults();
    this.waiting.push({ direction, at: performance.now() });
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

  /** Called after the core and viewport change, before a synchronous repaint. */
  changed(kind: TerminalChange['kind'], alternate: boolean): void {
    const switched = alternate !== this.alternateScreen;
    this.alternateScreen = alternate;
    if (!this.search) return;
    this.dirty = true;
    this.resized ||= kind === 'resize';
    this.matches = [];
    this.index = null;
    this.complete = false;
    this.highlights.clear('search-all');
    const range = switched ? null : this.keptRange();
    if (range) {
      this.kept = range;
      // Repeated output restarts must not renew the restoration deadline.
      if (kind === 'resize' || this.restoreAt === null) this.restoreAt = performance.now();
      this.highlightActive();
      if (kind === 'resize' && this.keptOnScreen) this.viewport.reveal(range.startRow);
    } else {
      const lost = this.kept !== null;
      this.forget();
      if (switched || kind === 'resize' || lost) this.waiting = this.waiting.filter(step => step.newest);
    }
    this.schedule();
    this.publish();
  }

  private prepare(query: string): boolean {
    if (this.search && query === this.needle) return false;
    this.release();
    this.search = this.core.createSearch();
    this.search.setNeedle(query);
    this.needle = query;
    this.complete = false;
    this.markBacklog();
    return true;
  }

  private release(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.search?.free();
    this.search = null;
    this.forget();
    this.backlogCell?.free();
    this.backlogCell = null;
    this.highlights.clear('search-all');
    this.needle = '';
    this.matches = [];
    this.waiting = [];
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
    if (this.frame !== undefined || !this.search) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.pump();
    });
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
    const running = search.step(budget) === 'running';
    if (scanning && !running && search.completingUnitMs) {
      this.held = search.state().total;
      const checked = this.checked();
      if (checked >= LEARN_CHECK) this.completeMs = learned(this.completeMs, search.completingUnitMs / checked, COST_PRIORS.complete);
    }
    this.readResults();
    const reveal = this.applyWaiting();
    // Schedule before notifying: a subscriber can close or replace the query.
    if (running || this.waiting.length > 0 || this.restoreAt !== null) this.schedule();
    this.show(reveal);
  }

  private readResults(): void {
    const search = this.search!;
    const state = search.state();
    this.complete = state.complete;
    this.held = state.complete ? state.total : Math.max(state.total, this.held);
    const seen = new Set<string>();
    // Canonicalize the complete cell range, preserving the core's first
    // occurrence in newest-first order and distinct overlapping matches.
    this.matches = search.matchesBetween(0, Number.MAX_SAFE_INTEGER, Infinity).filter(range => {
      const key = `${range.startRow}:${range.startCol}:${range.endRow}:${range.endCol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const range = this.keptRange();
    const index = range ? this.matches.findIndex(match => sameRange(match, range)) : -1;
    this.index = index < 0 ? null : index;
    if (range) {
      this.kept = range;
      if (index >= 0) this.restoreAt = null;
      else if (this.complete || (this.restoreAt !== null && performance.now() - this.restoreAt >= WAIT_CAP_MS)) this.forget();
    } else if (this.kept) {
      this.forget();
    }
  }

  private applyWaiting(): boolean {
    if (this.restoreAt !== null) return false;
    let selected = false;
    while (this.waiting.length) {
      const { direction, at } = this.waiting[0];
      const total = this.matches.length;
      const lands = direction === 'newer' ? this.index !== null && this.index > 0
        : this.index === null ? total > 0 : this.index < total - 1;
      const capped = performance.now() - at >= WAIT_CAP_MS && total > 0;
      if (!this.complete && !lands && !capped) break;
      this.waiting.shift();
      if (!total) continue;
      this.index = direction === 'newer'
        ? this.index === null ? total - 1 : (this.index + total - 1) % total
        : this.index === null ? 0 : (this.index + 1) % total;
      this.keep(this.matches[this.index]);
      selected = true;
    }
    return selected;
  }

  private keep(range: MatchRange): void {
    this.keptStart = this.retrack(this.keptStart, range.startRow, range.startCol);
    this.keptEnd = this.retrack(this.keptEnd, range.endRow, range.endCol);
    this.kept = this.keptStart && this.keptEnd ? range : null;
    this.restoreAt = null;
    if (!this.kept) this.forget();
  }

  private keptRange(): MatchRange | null {
    if (!this.kept) return null;
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

  private show(reveal: boolean): void {
    this.highlights.set('search-all', this.matches.map(highlight), { background: '#806d36' });
    this.highlightActive();
    if (reveal && this.kept) this.viewport.reveal(this.kept.startRow);
    this.publish();
  }

  private publish(): void {
    const total = this.matches.length;
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
function sameRange(a: MatchRange, b: MatchRange): boolean {
  return a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol;
}
function learned(estimate: number, measured: number, floor: number): number {
  return Math.max(floor, (estimate + Math.min(measured, 1.5 * estimate)) / 2);
}
