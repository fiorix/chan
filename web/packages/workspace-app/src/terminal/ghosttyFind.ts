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
  /// The query changed and its first match is still to be selected.
  private selectFirst = false;
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
    this.prepare(query);
    this.schedule();
  }

  /// Select the next match toward older output (up the buffer) or newer
  /// output (down), both wrapping, scroll to it and highlight it. A query
  /// other than the current one is searched for first, so after the bar
  /// reopens the first step lands on the newest match.
  step(query: string, direction: "older" | "newer"): void {
    if (!query) {
      this.close();
      return;
    }
    const search = this.prepare(query);
    // Right after a query change the core selects among the matches found
    // so far; when it has none yet, the scan selects the first it finds.
    const found = direction === "older" ? search.selectNext() : search.selectPrev();
    if (found) this.selectFirst = false;
    this.show(true);
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
    this.selectFirst = false;
    this.dirty = false;
  }

  /// The terminal is going away.
  dispose(): void {
    this.close();
    this.stopObserving();
  }

  private prepare(query: string): VtSearch {
    this.search ??= this.core.createSearch();
    if (query !== this.needle) {
      this.search.setNeedle(query);
      this.needle = query;
      this.selectFirst = true;
    }
    return this.search;
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
  /// select a new query's first match, and show what the search holds.
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
    let reveal = false;
    if (this.selectFirst && search.state().total > 0) {
      this.selectFirst = false;
      reveal = search.selectNext();
    }
    this.show(reveal);
    if (running) this.schedule();
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
    const range = this.written;
    const start = this.selection?.selectionStart;
    const end = this.selection?.selectionEnd;
    if (!range || !start || !end) return false;
    return (
      start.col === range.startCol &&
      start.absoluteRow === range.startRow &&
      end.col === range.endCol &&
      end.absoluteRow === range.endRow
    );
  }
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
