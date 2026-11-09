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
/// oldest found so far rather than the oldest of all. So a step never wraps
/// while the scan runs. One that does not wrap applies at once. One that
/// would wrap, or newer with nothing selected, waits while the frames scan
/// on and applies on the first frame it can without wrapping: once the scan
/// has found the next older match, or once it completes. Steps pressed
/// while one waits queue behind it and apply in the order pressed, each
/// from where the one before landed, so a run of presses ends where it
/// would on a finished scan. A new query or closing the bar drops them. A
/// step that waited writes its highlight over the selection there was when
/// it was pressed; a selection the user makes while it waits stays theirs,
/// and the step moves only the count.
///
/// Output keeps arriving while the bar is open. The viewport controller
/// reports every change to the terminal, each write (output and the lines
/// chan prints itself) and each resize; the search is fed once per
/// animation frame however many came, and the count and the highlight
/// follow it. Across output the core keeps the active match on its text,
/// so the highlight moves only when pruned history has moved the match's
/// rows. A resize is different: the core forgets the active match and scans
/// again from scratch, so the highlight, whose rows the reflow gave other
/// text, goes before ghostty-web repaints, and the count has no index until
/// a step selects again, starting over: older lands on the newest match and
/// newer on the oldest.
///
/// The highlight is ghostty-web's own selection, written through its
/// SelectionManager's anchors. ghostty-web's public `select()` counts its
/// viewport offset as an absolute row, so it is never called. A selection the
/// user makes while the bar is open is theirs: the controller moves and
/// clears only the selection it wrote last.

import type { Terminal } from "ghostty-web";
import { selectionManagerOf, type SelectionManagerLike } from "./ghosttySelection";
import type { GhosttyChange, GhosttyViewportController } from "./ghosttyViewport";
import { type MatchRange, type SearchState, type VtSearch, VtTerminal } from "./ghosttyVt";

/// The find bar's match count. `index` counts from the newest match (1 is
/// the one closest to the prompt) and is null when it is not knowable;
/// `partial` marks a `total` that is a floor rather than the whole buffer's.
export type FindCount = { index: number | null; total: number; partial: boolean };

/// What find needs of the terminal's viewport controller: word of every
/// change to the terminal, and the one call that scrolls to a match.
export type FindViewport = Pick<GhosttyViewportController, "observeChanges" | "reveal">;

/// A step's way through the matches: toward older output, up the buffer,
/// or toward newer output, down it.
type Direction = "older" | "newer";

/// Runs a callback once on a coming animation frame; `cancel` drops one that
/// has not run.
export type FrameScheduler = { request(run: () => void): number; cancel(id: number): void };

/// Scanning per animation frame. The core's work comes in units and the
/// budget is checked after each, so a frame can run a few milliseconds over.
export const FIND_SCAN_BUDGET_MS = 4;

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
  private readonly stopObserving: () => void;
  /// The open bar's search; null while the bar is closed.
  private search: VtSearch | null = null;
  private needle = "";
  /// Steps the scan does not allow yet, in the order pressed. A new query's
  /// selection of its newest match is the first of them, an older step from
  /// nothing selected.
  private waiting: Direction[] = [];
  /// The selection when the bar last asked for a match.
  private askedOver: MatchRange | null = null;
  /// The terminal changed since the search was last fed.
  private dirty = false;
  /// The range last written to the selection.
  private written: MatchRange | null = null;
  private framePending = false;
  private frameId = 0;

  constructor(core: VtTerminal, options: GhosttyFindOptions) {
    this.core = core;
    this.viewport = options.viewport;
    this.selection = options.selection;
    this.onCount = options.onCount;
    this.frames = options.frames ?? animationFrames;
    this.budgetMs = options.budgetMs ?? FIND_SCAN_BUDGET_MS;
    this.stopObserving = options.viewport.observeChanges((change) => this.onChange(change));
  }

  /// The query changed: scan for it from scratch and select its newest match
  /// on the frame that finds one. An empty query closes the search.
  find(query: string): void {
    if (!query) {
      this.close();
      return;
    }
    if (this.prepare(query)) {
      this.waiting.push("older");
      this.askedOver = this.selectionRange();
    }
    this.schedule();
  }

  /// Select the next match toward older output (up the buffer) or newer
  /// output (down), both wrapping, scroll to it and highlight it; while the
  /// scan runs, a step that would wrap waits for it (see above). A query
  /// other than the current one is searched for first, so after the bar
  /// reopens the first step lands on the newest match for older, at once,
  /// and on the oldest for newer, once the scan completes.
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
    this.waiting.push(direction);
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
    this.needle = "";
    this.waiting = [];
    this.askedOver = null;
    this.dirty = false;
  }

  /// The terminal is going away.
  dispose(): void {
    this.close();
    this.stopObserving();
  }

  /// Makes the search on first use and sets its needle; true when the
  /// needle changed, which drops the steps still waiting.
  private prepare(query: string): boolean {
    this.search ??= this.core.createSearch();
    if (query === this.needle) return false;
    this.search.setNeedle(query);
    this.needle = query;
    this.waiting = [];
    return true;
  }

  private onChange(change: GhosttyChange): void {
    if (!this.search) return;
    // The core drops its selected match on any resize, so no active match
    // is left to move the highlight to, and the rows under it hold other
    // text once the grid reflows.
    if (change === "resize") this.dropHighlight();
    this.dirty = true;
    this.schedule();
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
    if (running) this.schedule();
  }

  /// Applies the waiting steps, oldest press first, up to the first one the
  /// scan does not allow yet; true when one selected a match.
  private applyWaiting(): boolean {
    const search = this.search!;
    let selected = false;
    while (this.waiting.length > 0) {
      const state = search.state();
      if (!state.complete && !landsAsComplete(this.waiting[0]!, state)) break;
      const direction = this.waiting.shift()!;
      if (direction === "older" ? search.selectNext() : search.selectPrev()) selected = true;
    }
    return selected;
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
    const active = state.active;
    if (active && reveal) {
      this.highlight(active);
      this.viewport.reveal(active.startRow);
    } else if (!sameRange(active, this.written) && this.ownsSelection()) {
      if (active) this.highlight(active);
      else this.dropHighlight();
    }
    this.onCount(findCount(state));
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
function landsAsComplete(direction: Direction, { index, total }: SearchState): boolean {
  if (direction === "older") return index === null ? total > 0 : index < total - 1;
  return index !== null && index > 0;
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
