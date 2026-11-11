/// Find in a ghostty terminal: the find bar's query searched with
/// libghostty-vt's own engine (`VtSearch`), the active match shown as the
/// terminal's selection and scrolled into view, and a "k of n" count with k
/// counted from the newest match.
///
/// The direction is Ghostty's. A new query selects the newest match, the one
/// closest to the prompt; stepping "older" walks up through the history and
/// "newer" walks down, both wrapping. The scan is incremental, a few
/// milliseconds of it per animation frame, so a long history never holds up
/// a keystroke; the count grows as it goes and stays `partial` until it
/// ends. The scan works from the newest output up, so the first match it
/// finds is the newest of all and is selected on the frame that finds it.
///
/// While the scan runs the core knows only the newest matches, and its
/// steps wrap among those: older from the oldest found so far lands on the
/// newest, and newer from the newest, or with nothing selected, on the
/// oldest found so far rather than the oldest of all. A step that does not
/// wrap applies at once. One that would wrap, or newer with nothing
/// selected, waits while the frames scan on and applies on the first frame
/// it can without wrapping: once the scan has found the next older match,
/// or once it completes. It waits at most `FIND_WAIT_CAP_MS` from its
/// press, because output that outpaces the scan keeps it from completing
/// for as long as the output lasts. Past the cap it applies among the
/// matches found so far, wrapping as the core does, and the count stays
/// partial; with none found yet it waits until one is. Steps pressed while
/// one waits queue behind it and apply in the order pressed, each from
/// where the one before landed and each under its own cap, so a run of
/// presses ends where it would on a finished scan, or, past the cap, where
/// it would among the matches found by then. A new query or closing the bar
/// drops them; a resize keeps them behind the active match (below), or
/// drops them when it loses that match. A step that waited writes its
/// highlight over the selection there was when it was pressed; a selection
/// the user makes while it waits stays theirs, and the step moves only the
/// count.
///
/// Output keeps arriving while the bar is open. The viewport controller
/// reports every change to the terminal, each write (output and the lines
/// chan prints itself) and each resize; the search is fed once per
/// animation frame however many came, and the count and the highlight
/// follow it. Across output the core keeps the active match on its text,
/// so the highlight moves only when pruned history has moved the match's
/// rows.
///
/// A resize is different: the core forgets its selected match on every
/// resize, one that reflows nothing too, and scans again from scratch. So
/// the controller keeps the active match itself, as two tracked cells
/// (`VtTrackedCell`) on its first and last characters, which the core
/// moves with their text through output, pruning and reflow. On a resize
/// the highlight moves to where the cells now are before ghostty-web
/// repaints, and a match that was on the screen when the resize began is
/// scrolled back onto it if the reflow took it off. Once the rescan finds
/// the match that starts at the first cell, that match is selected again
/// and the count has its index back; until then the count shows the total
/// so far and no index. The core has no call that selects a given match,
/// only steps to the next older or newer one, each a feed of the terminal
/// (a fraction of a millisecond, a few on a large screen with many
/// matches), so selecting it again walks there a frame's budget at a time
/// from the nearer end of the matches found so far: the newest, or the
/// oldest found so far, which while the scan runs is where the scan has just
/// passed, so a walk that starts as the scan finds the match is short.
/// Steps pressed meanwhile wait behind it and apply from it, as steps wait
/// for a scan. The match is lost when its first cell's row was pruned, when the
/// finished scan has no match starting there (the alternate screen crops
/// its rows on a resize rather than reflowing them, which can cut a match),
/// or when the walk has not reached it `FIND_WAIT_CAP_MS` after the resize;
/// a walk that gave up has left the core on another match, so the search
/// drops its results and scans again. Then the highlight goes, the count
/// has no index, and the next step starts over, older on the newest match
/// and newer on the oldest. A new query's selection of its newest match
/// that has not landed yet needs no keeping: it starts from no match
/// selected anyway.
///
/// The highlight is ghostty-web's own selection, written through its
/// SelectionManager's anchors. ghostty-web's public `select()` counts its
/// viewport offset as an absolute row, so it is never called. A selection the
/// user makes while the bar is open is theirs: the controller moves and
/// clears only the selection it wrote last.

import type { Terminal } from "ghostty-web";
import { selectionManagerOf, type SelectionManagerLike } from "./ghosttySelection";
import type { GhosttyChange, GhosttyViewportController } from "./ghosttyViewport";
import { type MatchRange, type SearchState, type VtSearch, VtTerminal, type VtTrackedCell } from "./ghosttyVt";

/// The find bar's match count. `index` counts from the newest match (1 is
/// the one closest to the prompt) and is null when it is not knowable;
/// `partial` marks a `total` that is a floor rather than the whole buffer's.
export type FindCount = { index: number | null; total: number; partial: boolean };

/// What find needs of the terminal's viewport controller: word of every
/// change to the terminal, the one call that scrolls to a match, and
/// whether a row is on the screen.
export type FindViewport = Pick<GhosttyViewportController, "observeChanges" | "reveal" | "shows">;

/// A step's way through the matches: toward older output, up the buffer,
/// or toward newer output, down it.
type Direction = "older" | "newer";

/// A step held until the scan or its cap allows it: a press toward older
/// or newer output; a new query's selection of its newest match, which
/// lands as an older step from no match selected does; or, after a resize,
/// selecting the kept match again (`kept`). `at` is the clock when it was
/// asked for.
type Waiting = { step: Direction | "newest" | "kept"; at: number };

/// Runs a callback once on a coming animation frame; `cancel` drops one that
/// has not run.
export type FrameScheduler = { request(run: () => void): number; cancel(id: number): void };

/// Scanning per animation frame. The core's work comes in units and the
/// budget is checked after each, so a frame can run a few milliseconds over.
export const FIND_SCAN_BUDGET_MS = 4;

/// The longest a step that would wrap waits for the scan, from its press.
/// A full history at the largest scrollback setting, about 55,000 lines
/// at 200 columns, scans in about twenty frames at the budget above on a
/// desktop, a third of a second at 60 Hz, so a scan that is only catching
/// up completes inside the cap and the step lands on the oldest or newest
/// match of all. Output of more lines per frame than the history holds
/// keeps the scan from ever completing while it lasts; the cap lands the
/// step among the matches found so far while the press is still recent,
/// rather than all at once when the output stops.
export const FIND_WAIT_CAP_MS = 1000;

const animationFrames: FrameScheduler = {
  request: (run) => requestAnimationFrame(() => run()),
  cancel: (id) => cancelAnimationFrame(id),
};

export type GhosttyFindOptions = {
  viewport: FindViewport;
  /// ghostty-web's selection manager. Without one the active match is
  /// counted and scrolled to but not highlighted.
  selection: SelectionManagerLike | null;
  /// Takes the count each time the controller reads the search.
  onCount(count: FindCount): void;
  frames?: FrameScheduler;
  budgetMs?: number;
  /// Milliseconds on a clock that never steps back, read for the cap on a
  /// waiting step; `performance.now` unless given.
  clock?: () => number;
};

/// Find for one ghostty terminal, made when its find bar first opens and
/// disposed with the terminal. The bar drives it: `find` when the query
/// changes, `step` for Enter and the find commands, `close` when the bar
/// closes or the query empties.
export class GhosttyFind {
  /// Find over `term` when it runs on chan's binding of libghostty-vt; null
  /// on any other core, which has no search.
  static attach(term: Terminal, viewport: FindViewport, onCount: (count: FindCount) => void): GhosttyFind | null {
    // Typed as unknown: ghostty-web's terminal type and the binding's class
    // both have private fields, so narrowing one to the other is empty.
    const core: unknown = term.wasmTerm;
    if (!(core instanceof VtTerminal)) return null;
    return new GhosttyFind(core, { viewport, selection: selectionManagerOf(term), onCount });
  }

  private readonly core: VtTerminal;
  private readonly viewport: FindViewport;
  private readonly selection: SelectionManagerLike | null;
  private readonly onCount: (count: FindCount) => void;
  private readonly frames: FrameScheduler;
  private readonly budgetMs: number;
  private readonly clock: () => number;
  private readonly stopObserving: () => void;
  /// The open bar's search; null while the bar is closed.
  private search: VtSearch | null = null;
  private needle = "";
  /// Steps neither the scan nor their cap allows yet, in the order pressed,
  /// behind a new query's selection of its newest match while that has not
  /// landed, or behind selecting the kept match again after a resize.
  private waiting: Waiting[] = [];
  /// The selection when the bar last asked for a match.
  private askedOver: MatchRange | null = null;
  /// The terminal changed since the search was last fed.
  private dirty = false;
  /// The range last written to the selection.
  private written: MatchRange | null = null;
  private framePending = false;
  private frameId = 0;
  /// Tracked cells on the first and last character of the kept match, made
  /// the first time a match is active and freed with the search.
  private keptStart: VtTrackedCell | null = null;
  private keptEnd: VtTrackedCell | null = null;
  /// The match the kept cells are on, as last read; null when none is kept.
  /// It is the core's active match, except after a resize until that match
  /// is selected again.
  private kept: MatchRange | null = null;
  /// Whether the kept match was on the screen when the last resize began.
  private keptOnScreen = false;
  /// The walk that selects the kept match again, once the scan has found
  /// it: the way it steps and how many selects it has made.
  private walk: { direction: Direction; selects: number } | null = null;
  private readonly stopResizing: () => void;

  constructor(core: VtTerminal, options: GhosttyFindOptions) {
    this.core = core;
    this.viewport = options.viewport;
    this.selection = options.selection;
    this.onCount = options.onCount;
    this.frames = options.frames ?? animationFrames;
    this.budgetMs = options.budgetMs ?? FIND_SCAN_BUDGET_MS;
    this.clock = options.clock ?? (() => performance.now());
    this.stopObserving = options.viewport.observeChanges((change) => this.onChange(change));
    this.stopResizing = core.beforeResize(({ rows }) => this.onResizing(rows));
  }

  /// The query changed: scan for it from scratch and select its newest match
  /// on the frame that finds one. An empty query closes the search.
  find(query: string): void {
    if (!query) {
      this.close();
      return;
    }
    if (this.prepare(query)) {
      this.waiting.push({ step: "newest", at: this.clock() });
      this.askedOver = this.selectionRange();
    }
    this.schedule();
  }

  /// Select the next match toward older output (up the buffer) or newer
  /// output (down), both wrapping, scroll to it and highlight it; while the
  /// scan runs, a step that would wrap waits for it, up to its cap (see
  /// above). A query other than the current one is searched for first, so
  /// after the bar reopens the first step lands on the newest match for
  /// older, at once, and on the oldest for newer, once the scan completes
  /// or, past the cap, on the oldest found by then.
  step(query: string, direction: "older" | "newer"): void {
    if (!query) {
      this.close();
      return;
    }
    if (this.prepare(query)) {
      // The terminal is read now, as a frame would, so that a step that
      // does not wrap selects at once.
      this.search!.feed();
    }
    this.waiting.push({ step: direction, at: this.clock() });
    this.askedOver = this.selectionRange();
    const selected = this.applyWaiting();
    // A press that only waits changes nothing yet; the frames show the
    // count as the scan goes.
    if (selected || this.waiting.length === 0) this.show(selected);
    this.schedule();
  }

  /// The bar closed: stop scanning, free the search, and clear the highlight
  /// unless the user has selected something else since.
  close(): void {
    this.cancelFrame();
    this.dropHighlight();
    this.search?.free();
    this.search = null;
    this.keptStart?.free();
    this.keptEnd?.free();
    this.keptStart = this.keptEnd = null;
    this.forget();
    this.needle = "";
    this.waiting = [];
    this.askedOver = null;
    this.dirty = false;
  }

  /// The terminal is going away.
  dispose(): void {
    this.close();
    this.stopObserving();
    this.stopResizing();
  }

  /// Makes the search on first use and sets its needle; true when the
  /// needle changed, which drops the steps still waiting and the kept match.
  private prepare(query: string): boolean {
    this.search ??= this.core.createSearch();
    if (query === this.needle) return false;
    this.search.setNeedle(query);
    this.needle = query;
    this.waiting = [];
    this.forget();
    return true;
  }

  private onChange(change: GhosttyChange): void {
    if (!this.search) return;
    if (change === "resize") this.onResized();
    this.dirty = true;
    this.schedule();
  }

  /// A resize begins and the core still holds the old grid, `rows` high.
  /// With no match kept the reading goes unused (`onResized`).
  private onResizing(rows: number): void {
    const start = this.keptStart?.point() ?? null;
    this.keptOnScreen = start !== null && this.viewport.shows(start.row, rows);
  }

  /// The core has the new grid and has forgotten its selected match, and
  /// ghostty-web repaints next. The kept cells name the match's place in the
  /// new grid: the highlight moves there, a match that was on the screen
  /// stays on it, and selecting it again waits at the head of the steps,
  /// before any pressed earlier, which then apply from it.
  private onResized(): void {
    const range = this.kept ? this.keptRange() : null;
    if (!range) {
      // No match is kept, or its row was pruned: no active match is left to
      // move the highlight to, and the rows under it may hold other text. A
      // press that waits would apply from no match selected and scroll to
      // wherever that took it; a new query's selection of its newest match
      // starts there anyway.
      this.forget();
      this.dropHighlight();
      this.waiting = this.waiting.filter(({ step }) => step === "newest");
      return;
    }
    this.kept = range;
    if (this.selectionRange() === null || this.ownsSelection()) this.highlight(range);
    if (this.keptOnScreen) this.viewport.reveal(range.startRow);
    // A resize during the walk sends it back to the start: the core forgot
    // the match it had walked to.
    this.walk = null;
    const reselect: Waiting = { step: "kept", at: this.clock() };
    if (this.waiting[0]?.step === "kept") this.waiting[0] = reselect;
    else this.waiting.unshift(reselect);
  }

  /// The kept match where its cells are now; null when either is gone.
  private keptRange(): MatchRange | null {
    const start = this.keptStart?.point();
    const end = this.keptEnd?.point();
    return start && end ? { startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col } : null;
  }

  /// Sets the kept cells on `active`, the match the core has selected, or
  /// keeps none when no match is selected.
  private keep(active: MatchRange | null): void {
    if (sameRange(active, this.kept)) return;
    this.kept = null;
    if (!active) return;
    this.keptStart = this.retrack(this.keptStart, active.startRow, active.startCol);
    this.keptEnd = this.retrack(this.keptEnd, active.endRow, active.endCol);
    if (this.keptStart && this.keptEnd) this.kept = active;
  }

  /// `cell` moved to the cell at `row` and `col`, or a new tracked cell
  /// there; null when the core cannot track it.
  private retrack(cell: VtTrackedCell | null, row: number, col: number): VtTrackedCell | null {
    if (cell?.moveTo(row, col)) return cell;
    cell?.free();
    return this.core.trackCell(row, col);
  }

  /// Keeps no match. The cells stay made, for the next one.
  private forget(): void {
    this.kept = null;
    this.walk = null;
  }

  private schedule(): void {
    if (this.framePending || !this.search) return;
    this.framePending = true;
    this.frameId = this.frames.request(() => {
      this.framePending = false;
      this.pump();
    });
  }

  private cancelFrame(): void {
    if (!this.framePending) return;
    this.framePending = false;
    this.frames.cancel(this.frameId);
  }

  /// One frame of work: feed the output that arrived, scan for the budget,
  /// apply the steps the scan now allows, and show what the search holds.
  private pump(): void {
    const search = this.search;
    if (!search) return;
    // Fed before the step: a feed is bounded work that can leave the scan
    // running, and the step spends this frame's budget finishing it.
    if (this.dirty) {
      this.dirty = false;
      search.feed();
    }
    const running = search.step(this.budgetMs) === "running";
    const selected = this.applyWaiting();
    this.show(selected && this.askStands());
    // A walk to the kept match goes on after the scan completes.
    if (running || this.waiting.length > 0) this.schedule();
  }

  /// Applies the waiting steps, oldest press first, up to the first one
  /// neither the scan nor its cap allows yet; true when one selected a
  /// match. Selecting the kept match again is not a selection the user
  /// asked for: it moves neither the highlight nor the viewport.
  private applyWaiting(): boolean {
    const search = this.search!;
    const now = this.clock();
    let selected = false;
    while (this.waiting.length > 0) {
      const { step, at } = this.waiting[0]!;
      if (step === "kept") {
        if (!this.reselect(now - at >= FIND_WAIT_CAP_MS)) break;
        this.waiting.shift();
        continue;
      }
      const state = search.state();
      // Past its cap a step lands among the matches found so far, so it
      // needs one to land on.
      const capped = now - at >= FIND_WAIT_CAP_MS && state.total > 0;
      if (!state.complete && !landsAsComplete(step, state) && !capped) break;
      this.waiting.shift();
      if (step === "newer" ? search.selectPrev() : search.selectNext()) selected = true;
    }
    return selected;
  }

  /// One frame's work toward selecting the kept match again after a resize;
  /// true once that is settled, the match selected or lost, false while it
  /// waits for the scan or walks. The walk starts once the scan has found
  /// the match that starts at the kept first cell, from the end of the list
  /// nearer to it: older steps from no match selected land on the newest
  /// match first, newer ones on the oldest found so far. It compares the
  /// match each select lands on with the kept cell, for the frame's budget
  /// and at least one select.
  private reselect(capped: boolean): boolean {
    const search = this.search!;
    const start = this.keptStart?.point() ?? null;
    if (!start) return this.lose();
    const at = (range: MatchRange | null) => range !== null && range.startRow === start.row && range.startCol === start.col;
    const state = search.state();
    if (at(state.active)) return this.land();
    if (capped) return this.lose();
    if (!this.walk) {
      const index = search.indexOfMatchAt(start.row, start.col);
      if (index === null) return state.complete ? this.lose() : false;
      this.walk = { direction: index + 1 <= state.total - index ? "older" : "newer", selects: 0 };
    }
    const walk = this.walk;
    const deadline = performance.now() + this.budgetMs;
    do {
      const moved = walk.direction === "older" ? search.selectNext() : search.selectPrev();
      walk.selects++;
      const now = search.state();
      if (moved && at(now.active)) return this.land();
      // Once round every match found without meeting it.
      if (!moved || walk.selects > now.total) return this.lose();
    } while (performance.now() < deadline);
    return false;
  }

  /// The walk reached the kept match: the core has it selected again.
  private land(): true {
    this.walk = null;
    return true;
  }

  /// The kept match is lost. The core has no match selected, so the next
  /// `show` takes the highlight off it and counts no index. A walk that gave
  /// up has left the core on another match, so the search drops its results
  /// and scans again from no match selected.
  private lose(): true {
    const walked = this.walk !== null && this.walk.selects > 0;
    this.forget();
    if (walked) {
      this.search!.setNeedle("");
      this.search!.setNeedle(this.needle);
      this.schedule();
    }
    return true;
  }

  /// Whether a step that waited may write its highlight: the user has not
  /// selected anything of their own since the bar asked.
  private askStands(): boolean {
    const now = this.selectionRange();
    return now === null || sameRange(now, this.askedOver) || this.ownsSelection();
  }

  /// Show what the search holds: the count, and the active match as the
  /// selection. With `reveal`, a match the user asked for, the highlight is
  /// written over whatever is selected and scrolled to. Otherwise it follows
  /// its match only when the match moved and the selection is still the
  /// controller's own, and goes when no match is active any more.
  private show(reveal: boolean): void {
    const state = this.search!.state();
    const count = findCount(state);
    if (this.waiting[0]?.step === "kept") {
      // The core has no match selected, or one a walk is passing; the
      // highlight stays on the kept match until it is selected again.
      this.onCount(state.total > 0 ? { ...count, index: null } : count);
      return;
    }
    const active = state.active;
    if (active && reveal) {
      this.highlight(active);
      this.viewport.reveal(active.startRow);
    } else if (!sameRange(active, this.written) && this.ownsSelection()) {
      if (active) this.highlight(active);
      else this.dropHighlight();
    }
    this.keep(active);
    this.onCount(count);
  }

  private highlight(range: MatchRange): void {
    this.written = range;
    const manager = this.selection;
    if (!manager) return;
    // Dropping the selection it replaces marks that selection's rows for
    // repaint. At the bottom of the buffer ghostty-web repaints only rows
    // marked so, and the old highlight would stay painted.
    manager.clearSelection();
    manager.selectionStart = { col: range.startCol, absoluteRow: range.startRow };
    manager.selectionEnd = { col: range.endCol, absoluteRow: range.endRow };
    manager.requestRender();
    manager.selectionChangedEmitter.fire();
  }

  private dropHighlight(): void {
    if (this.selection && this.ownsSelection()) {
      this.selection.clearSelection();
      this.selection.selectionChangedEmitter.fire();
    }
    this.written = null;
  }

  /// Whether the selection is still the range written last.
  private ownsSelection(): boolean {
    return this.written !== null && sameRange(this.selectionRange(), this.written);
  }

  /// The selection as a match range; null when nothing is selected.
  private selectionRange(): MatchRange | null {
    const start = this.selection?.selectionStart;
    const end = this.selection?.selectionEnd;
    if (!start || !end) return null;
    return { startRow: start.absoluteRow, startCol: start.col, endRow: end.absoluteRow, endCol: end.col };
  }
}

/// Whether a step lands now where it would once the scan completes. Until
/// then the core holds the newest `total` matches, index 0 the newest, and
/// wraps among them, so only a step that stays inside them lands so: older
/// from nothing selected onto the newest once one is found, older from any
/// but the oldest found so far, and newer from any but the newest.
function landsAsComplete(step: Waiting["step"], { index, total }: SearchState): boolean {
  if (step === "newer") return index !== null && index > 0;
  return index === null ? total > 0 : index < total - 1;
}

function sameRange(a: MatchRange | null, b: MatchRange | null): boolean {
  if (!a || !b) return a === b;
  return a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol;
}

/// The bar's count of a search: `index` is the core's, 0 the newest, plus
/// one. Nothing found reads `0 of 0`; with no match selected (a screen
/// switch, pruning or a resize took the selected one) there is no index.
function findCount(state: SearchState): FindCount {
  const partial = !state.complete;
  if (state.total === 0) return { index: 0, total: 0, partial };
  return { index: state.index === null ? null : state.index + 1, total: state.total, partial };
}
