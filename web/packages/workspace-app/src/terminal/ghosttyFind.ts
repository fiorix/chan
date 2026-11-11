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
/// chan prints itself) and each resize; the search catches up once per
/// animation frame however many came, and the count and the highlight
/// follow it. Across output the core keeps the active match on its text,
/// so the highlight moves only when pruned history has moved the match's
/// rows.
///
/// Catching up is a feed: one wasm call that takes in every row moved into
/// the history since the last one and, while the scan is complete, checks
/// every match the search holds against the history's pages. At the
/// largest scrollback with a needle that matches often either part can
/// outlast a frame, and no budget can split the call. So each frame
/// predicts its feed from what this search has measured, never under what
/// it assumes before measuring (`catchUp`), and, past the frame's budget,
/// restarts the search instead: the same needle
/// on a fresh scan, budgeted as any scan is, the count partial until it
/// ends. The core then has no match selected, as after a resize, and the
/// active match is kept the same way.
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

/// The work one find frame plans for: a feed of the output that arrived,
/// then a scan step that leaves room for the unit completing the scan.
/// 4 ms under the 16 of a 60 Hz frame, for the error of the cost estimates
/// and the frame's other work (the count, the highlight).
export const FIND_FRAME_BUDGET_MS = 12;

/// The costs a find frame predicts before it feeds, as this terminal's own
/// feeds and scans measure them, and what they start from before any has,
/// which is also the least they are taken at (`learned`). A feed reads every
/// cell of the rows moved into the history since the last one (`read`, per
/// cell). While the scan is complete it also checks each match the search
/// holds against the terminal's pages (`check`, per match held per cell of
/// history), and the unit that completes a scan does the same check over the
/// results it has just made (`complete`), a third to two thirds dearer as
/// measured. The starting values sit above what `seq` output measured on a
/// desktop (a Ryzen 9 8945HS): reads of 1.6 to 2.8 ns a cell, checks of 1.1
/// to 2.3 times 10^-11 ms. With them, at the default scrollback and up to
/// 200 columns no feed predicts over the budget (the whole history, 10,922
/// lines, reads in about 9 ms), and at the largest scrollback a burst that
/// fills the history at 200 columns predicts over it from its first frame.
export const FIND_COST_PRIORS = { read: 4e-6, check: 2e-11, complete: 3e-11 } as const;

/// A feed is learned from only when it took in at least this many rows, and
/// a check, a feed's or a completing unit's, only when the matches times
/// the history's cells reach this many, a check of about 2 ms at the
/// assumed cost: below them the clock's grain and the call's other work
/// (the unit reads its page, the feed the screen) decide its time. At the
/// default scrollback no check reaches it, and the assumed costs stand.
const FIND_LEARN_ROWS = 64;
const FIND_LEARN_CHECK = 1e11;

/// The least a scan step runs for when it leaves room for a completion: with
/// less, a scan whose completion nearly fills the frame would advance a
/// unit a frame and take seconds.
const FIND_STEP_FLOOR_MS = 1;

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
  /// waiting step and to time a frame's work; `performance.now` unless
  /// given.
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
  /// A tracked cell on the first row of the screen as of the last feed or
  /// restart: the rows above it now moved into the history since, and are
  /// what the next feed takes in. Made with the search, freed with it.
  private backlogCell: VtTrackedCell | null = null;
  /// The terminal was resized since the last feed.
  private resized = false;
  /// The costs of `FIND_COST_PRIORS` as this search has measured them; they
  /// depend on how often the needle matches.
  private readMs: number = FIND_COST_PRIORS.read;
  private checkMs: number = FIND_COST_PRIORS.check;
  private completeMs: number = FIND_COST_PRIORS.complete;
  /// The matches the search holds, as last read, or, while a rescan runs,
  /// as many as it held before when that is more: the unit that completes
  /// the rescan checks about as many.
  private held = 0;

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
    // The terminal is read now, as a frame would, so that a step that does
    // not wrap selects at once; a fresh search costs only its first unit.
    if (this.prepare(query)) this.search!.feed();
    else this.catchUp();
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
    this.backlogCell?.free();
    this.keptStart = this.keptEnd = this.backlogCell = null;
    this.forget();
    this.needle = "";
    this.waiting = [];
    this.askedOver = null;
    this.dirty = false;
    this.resized = false;
    this.readMs = FIND_COST_PRIORS.read;
    this.checkMs = FIND_COST_PRIORS.check;
    this.completeMs = FIND_COST_PRIORS.complete;
    this.held = 0;
  }

  /// The terminal is going away.
  dispose(): void {
    this.close();
    this.stopObserving();
    this.stopResizing();
  }

  /// Makes the search on first use and sets its needle; true when the
  /// needle changed, which drops the steps still waiting, the kept match
  /// and the feed cost model, which depends on how often the needle matches.
  private prepare(query: string): boolean {
    this.search ??= this.core.createSearch();
    if (query === this.needle) return false;
    this.search.setNeedle(query);
    this.needle = query;
    this.waiting = [];
    this.forget();
    this.readMs = FIND_COST_PRIORS.read;
    this.checkMs = FIND_COST_PRIORS.check;
    this.completeMs = FIND_COST_PRIORS.complete;
    this.held = 0;
    this.markBacklog();
    return true;
  }

  private onChange(change: GhosttyChange): void {
    if (!this.search) return;
    if (change === "resize") {
      this.onResized();
      this.resized = true;
    }
    this.dirty = true;
    this.schedule();
  }

  /// Brings the search up to date with the terminal before anything reads
  /// it: a feed when one is predicted to fit the frame, otherwise a restart.
  /// The core takes in every row moved into the history since the last feed
  /// in one call, which no budget can split, and while the scan is complete
  /// the feed also checks every match the search holds again. A restart
  /// costs little, and the fresh scan catches up in budgeted units from the
  /// newest output up, so the count shows a partial total meanwhile.
  ///
  /// The predictions are `FIND_COST_PRIORS`' costs, as measured and never
  /// under the assumed ones. A complete scan's feed
  /// reads the rows' cells and checks the matches held; it restarts only
  /// when that is over the budget and dearer than the check the rescan's
  /// completing unit will make, since the restart moves that check to a
  /// later frame rather than saving it, and saves only what the feed costs
  /// beyond it (the reading, and the dropping of matches the output
  /// pruned, which the read cost carries). A running scan's feed only
  /// reads, but this frame's step may complete the scan, so it restarts
  /// when the reading and that completion would not fit and the reading is
  /// at least a scan step's budget: output that heavy keeps the scan from
  /// completing until it eases, while a lighter write, or one that moves no
  /// row into the history, would lose the scan's progress to save next to
  /// nothing, so it is fed and the step goes on. Two cases always feed:
  /// after a resize, where the core scans again from scratch by itself, and
  /// a backlog that spans the whole history, where the core starts its
  /// history search over by itself; neither costs more than a restart.
  private catchUp(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const search = this.search!;
    const resized = this.resized;
    this.resized = false;
    const rows = this.backlogRows();
    const cells = rows * this.core.cols;
    const check = this.checkCost();
    const complete = search.caughtUp();
    if (!resized && Number.isFinite(rows)) {
      const read = cells * this.readMs;
      const completion = this.completionCost();
      const restart = complete
        ? check + read > FIND_FRAME_BUDGET_MS && completion < check + read
        : read >= FIND_SCAN_BUDGET_MS && read + completion > FIND_FRAME_BUDGET_MS;
      if (restart) {
        this.restart();
        return;
      }
    }
    const checked = this.checked();
    const started = this.clock();
    search.feed();
    const took = this.clock() - started;
    this.markBacklog();
    // A feed under the clock's grain reads 0 and says nothing of its cost.
    // Only a complete scan's feed is learned from: it also drops the matches
    // whose rows the output pruned, one at a time from a list that is
    // shifted down for each, which grows faster than the backlog. A running
    // scan's feed skips that, and learning from it would underestimate the
    // feed that follows once the scan completes.
    if (resized || !Number.isFinite(rows) || took <= 0 || !complete) return;
    if (rows >= FIND_LEARN_ROWS) this.readMs = learned(this.readMs, Math.max(0, took - check) / cells, FIND_COST_PRIORS.read);
    else if (checked >= FIND_LEARN_CHECK) this.checkMs = learned(this.checkMs, took / checked, FIND_COST_PRIORS.check);
  }

  /// The matches held times the history's cells: what a check walks.
  private checked(): number {
    return this.held * this.core.getScrollbackLength() * this.core.cols;
  }

  /// What a complete scan's feed costs to check the matches held now, as
  /// measured or assumed.
  private checkCost(): number {
    return this.checked() * this.checkMs;
  }

  /// What the unit completing a scan of as many matches costs now.
  private completionCost(): number {
    return this.checked() * this.completeMs;
  }

  /// Gives the search's results up for a fresh scan of the same needle.
  /// The core selects nothing after it, so the active match is kept as a
  /// resize keeps it (`onRestarted`).
  private restart(): void {
    this.search!.restart();
    this.markBacklog();
    this.onRestarted();
  }

  /// Puts the backlog cell on the first row of the screen.
  private markBacklog(): void {
    this.backlogCell = this.retrack(this.backlogCell, this.core.getScrollbackLength(), 0);
  }

  /// The rows moved into the history since the backlog cell was put;
  /// infinite once its row was pruned, when they are the whole history, and
  /// none when the cell could not be made.
  private backlogRows(): number {
    if (!this.backlogCell) return 0;
    const point = this.backlogCell.point();
    if (!point) return Infinity;
    return Math.max(0, this.core.getScrollbackLength() - point.row);
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

  /// The search restarted and the core has no match selected, as after a
  /// resize, so the kept match is selected again the same way, once the
  /// rescan finds it, with the steps pressed earlier behind it. Nothing
  /// reflowed: the highlight moves only when pruned history moved the
  /// match's rows. With no match kept, or its row pruned, the steps go as
  /// they go on a resize. A reselect that already waits keeps its time, so
  /// output that restarts the search frame after frame cannot hold the
  /// steps behind it past its cap, at which the match is lost as on a
  /// resize.
  private onRestarted(): void {
    const range = this.kept ? this.keptRange() : null;
    if (!range) {
      this.forget();
      this.dropHighlight();
      this.waiting = this.waiting.filter(({ step }) => step === "newest");
      return;
    }
    this.follow(range);
    this.walk = null;
    if (this.waiting[0]?.step !== "kept") this.waiting.unshift({ step: "kept", at: this.clock() });
  }

  /// The kept match is at `range` now: the highlight follows it while the
  /// selection is still the controller's own.
  private follow(range: MatchRange): void {
    if (sameRange(range, this.kept)) return;
    this.kept = range;
    if (this.ownsSelection()) this.highlight(range);
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

  /// One frame of work: catch up with the output that arrived, scan for
  /// what is left of the frame, apply the steps the scan now allows, and
  /// show what the search holds.
  private pump(): void {
    const search = this.search;
    if (!search) return;
    const started = this.clock();
    // Caught up before the step: a feed can leave the scan running, and the
    // step spends this frame's budget finishing it. The step's budget leaves
    // room for the unit that completes the scan, which checks the matches it
    // holds, down to FIND_STEP_FLOOR_MS; a completion over the whole frame
    // cannot be given room, so then the step runs its full budget. It always
    // runs at least one unit.
    this.catchUp();
    const scanning = !search.caughtUp();
    const completion = this.completionCost();
    const left = FIND_FRAME_BUDGET_MS - (this.clock() - started) - completion;
    const budget = completion >= FIND_FRAME_BUDGET_MS ? this.budgetMs : Math.min(this.budgetMs, Math.max(FIND_STEP_FLOOR_MS, left));
    const running = search.step(budget, this.clock) === "running";
    if (scanning && !running && search.completingUnitMs) {
      const state = search.state();
      this.held = state.total;
      const checked = this.checked();
      if (checked >= FIND_LEARN_CHECK) this.completeMs = learned(this.completeMs, search.completingUnitMs / checked, FIND_COST_PRIORS.complete);
    }
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
    const deadline = this.clock() + this.budgetMs;
    do {
      const moved = walk.direction === "older" ? search.selectNext() : search.selectPrev();
      walk.selects++;
      const now = search.state();
      if (moved && at(now.active)) return this.land();
      // Once round every match found without meeting it.
      if (!moved || walk.selects > now.total) return this.lose();
    } while (this.clock() < deadline);
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
      this.search!.restart();
      this.markBacklog();
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
    this.held = state.complete ? state.total : Math.max(state.total, this.held);
    const count = findCount(state);
    if (this.waiting[0]?.step === "kept") {
      // The core has no match selected, or one a walk is passing; the
      // highlight stays on the kept match until it is selected again, and
      // follows its cells when pruned history moves its rows.
      const range = this.keptRange();
      if (range) this.follow(range);
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

/// A cost estimate moved halfway to a new measure, the measure taken at
/// most at one and a half times the estimate, and never under `floor`, the
/// cost assumed before any measure. A stream whose cost rises is followed
/// within a few frames, while one feed that ran long raises the estimate by
/// a quarter at most: a feed runs long when the scheduler or a collection
/// stretched it, and when the rows the output pruned were dense with
/// matches, which the core drops one at a time; the next feed seldom prunes
/// as many. Without that bound one such feed could raise the estimate past
/// the budget for good, since a restart measures no feed to bring it down
/// again. The floor keeps measures from lowering a prediction under the
/// costs the first decisions are made on: a read measured cheap on small
/// feeds, or on a history not yet full, says nothing of a burst into a full
/// one, whose pruned matches cost more than its rows, and a feed is timed as
/// a whole, so a check predicted too high would make its read measure too
/// low.
function learned(estimate: number, measured: number, floor: number): number {
  return Math.max(floor, (estimate + Math.min(measured, 1.5 * estimate)) / 2);
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
