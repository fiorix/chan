export type FitLike = {
  fit(): void;
  /// The grid the host would hold. Nothing, or NaN from a host with no
  /// computed size, while the host cannot be measured.
  proposeDimensions(): { cols: number; rows: number } | null | undefined;
};

export type SizedTerminal = {
  cols: number;
  rows: number;
};

/// Propose Ghostty's grid for a measured host without reserving layout space
/// for its canvas-painted overlay scrollbar. Zero cell or host metrics mean
/// layout has not settled enough to resize safely.
export function proposeGhosttyDimensions(
  box: { width: number; height: number },
  padding: { top: number; right: number; bottom: number; left: number },
  cell: { width: number; height: number },
): { cols: number; rows: number } | null {
  if (
    cell.width === 0 ||
    cell.height === 0 ||
    box.width === 0 ||
    box.height === 0
  ) {
    return null;
  }
  const width = box.width - padding.left - padding.right;
  const height = box.height - padding.top - padding.bottom;
  return {
    cols: Math.max(2, Math.floor(width / cell.width)),
    rows: Math.max(1, Math.floor(height / cell.height)),
  };
}

/// Fit `term` to its host and say whether the host was measured. A detached or
/// hidden host, or one whose cell metrics are not known yet, has no grid: the
/// fitter declines it and the terminal keeps the grid it had. A throw is
/// absorbed the same way while layout settles.
export function runTerminalFit(
  fit: FitLike | null,
  term: SizedTerminal | null,
  onStatusDetail: (detail: string) => void,
): boolean {
  try {
    fit?.fit();
    if (term) onStatusDetail(`${term.cols}x${term.rows}`);
    const grid = fit?.proposeDimensions();
    return Boolean(grid && Number.isFinite(grid.cols) && Number.isFinite(grid.rows));
  } catch {
    return false;
  }
}

export function createTrailingFitScheduler(runFit: () => void, delayMs = 120): {
  schedule(): void;
  clear(): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runFit();
      }, delayMs);
    },
    clear() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
