import { VtCells, type VtTerminal } from '../vt/ghosttyVt';
import type { TerminalCore, TerminalCoreSearch, TerminalCoreTrackedCell } from './interfaces';

/** A retained core facade cannot access a terminal after its lifetime ends. */
export class TerminalCoreDisposedError extends Error {
  constructor() {
    super('Terminal core has been disposed');
    this.name = 'TerminalCoreDisposedError';
  }
}

/** The widget owns revocation; consumers receive only the frozen core facade. */
export function createTerminalCore(terminal: VtTerminal): { core: TerminalCore; dispose(): void } {
  let current: VtTerminal | undefined = terminal;
  const releases = new Set<() => void>();
  const cells = new VtCells();
  const rowSource = {};
  const live = (): VtTerminal => {
    if (!current) throw new TerminalCoreDisposedError();
    return current;
  };
  const own = (release: () => void): (() => void) => {
    const stop = () => {
      if (!releases.delete(stop)) return;
      release();
    };
    releases.add(stop);
    return stop;
  };
  const read = (row: number, into: VtCells, history: boolean): boolean => {
    const raw = live();
    if (!(history ? raw.readHistoryRow(row, cells) : raw.readRow(row, cells))) return false;
    // VtCells.fill receives its cache owner. Keep that raw-core identity out
    // of caller-owned views, including overrides of their fill method.
    const target = into.fill(rowSource, history, row, 0, cells.length);
    for (let x = 0; x < cells.length; x++) Object.assign(target[x], cells.at(x));
    return true;
  };
  const core: TerminalCore = Object.freeze({
    get cols() { return live().cols; },
    beforeResize(listener: Parameters<TerminalCore['beforeResize']>[0]) {
      return own(live().beforeResize(from => listener({ ...from })));
    },
    createSearch(): TerminalCoreSearch {
      let search: ReturnType<VtTerminal['createSearch']> | undefined = live().createSearch();
      const free = own(() => { search!.free(); search = undefined; });
      return Object.freeze({
        setNeedle: (needle: string) => { search?.setNeedle(needle); },
        restart: () => { search?.restart(); },
        step: (budgetMs: number, now?: () => number) => search?.step(budgetMs, now) ?? 'complete',
        feed: () => { search?.feed(); },
        selectNext: () => search?.selectNext() ?? false,
        selectPrev: () => search?.selectPrev() ?? false,
        caughtUp: () => search?.caughtUp() ?? true,
        state: () => search?.state() ?? { total: 0, index: null, active: null, complete: true },
        matchesBetween: (first: number, last: number, cap: number) => search?.matchesBetween(first, last, cap) ?? [],
        indexOfMatchAt: (row: number, col: number) => search?.indexOfMatchAt(row, col) ?? null,
        get completingUnitMs() { return search?.completingUnitMs ?? null; },
        free,
      });
    },
    trackCell(row: number, col: number): TerminalCoreTrackedCell | null {
      let cell = live().trackCell(row, col);
      if (!cell) return null;
      const free = own(() => { cell!.free(); cell = null; });
      return Object.freeze({
        point: () => cell?.point() ?? null,
        moveTo: (row: number, col: number) => cell?.moveTo(row, col) ?? false,
        free,
      });
    },
    getScrollbackLength: () => live().getScrollbackLength(),
    getDimensions: () => live().getDimensions(),
    plainText: (range?: Parameters<VtTerminal['plainText']>[0]) => live().plainText(range),
    readRow: (row: number, into: VtCells) => read(row, into, false),
    readHistoryRow: (row: number, into: VtCells) => read(row, into, true),
    isRowWrapped: (row: number) => live().isRowWrapped(row),
    isScrollbackRowWrapped: (row: number) => live().isScrollbackRowWrapped(row),
    encodePaste: (text: string) => live().encodePaste(text),
  });
  return {
    core,
    dispose() {
      current = undefined;
      for (const release of releases) release();
      cells.drop();
    },
  };
}
