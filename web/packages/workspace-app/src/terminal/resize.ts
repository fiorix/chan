export type FitLike = {
  fit(): void;
  /// The grid the host would hold. Nothing while the host cannot be measured,
  /// or NaN from a detached or `display: none` host, which has no computed
  /// size.
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

/// Fit `term` to its host and say whether the host was measured. A detached
/// host, one in a `display: none` subtree, or one whose cell metrics are not
/// known yet has no grid: the fitter declines it and the terminal keeps the
/// grid it had. A `visibility: hidden` host, as an inactive tab's is, keeps its
/// box and is measured. A throw is absorbed the same way while layout settles.
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

/// Whether a user event in a shown terminal takes the PTY's size back from
/// another client of the same session: a trusted event while the PTY holds a
/// grid other than the renderer's. A scripted event is not the user working in
/// this view, so it never moves the PTY.
export function shouldReclaimPtySize(
  event: { isTrusted: boolean },
  local: SizedTerminal,
  pty: SizedTerminal | null,
): boolean {
  return event.isTrusted && pty !== null && (pty.cols !== local.cols || pty.rows !== local.rows);
}

/// What a pending fit waits on: the next animation frame. Injectable so a
/// test drives it without a browser.
export type FitFrameHost = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
};

/// The leading-edge fit, pending at most once at a time. A hidden page gets
/// no animation frame, so every fit asked for while its window is off-screen
/// waits for the frame in which the window comes back. The fit reads the
/// host's size when it runs, so asking again while one is pending adds
/// nothing: the pending fit already fits the host as it is then.
export function createFitFrameScheduler(
  runFit: () => void,
  host: FitFrameHost = {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  },
): {
  request(): void;
  cancel(): void;
} {
  let frame: number | null = null;
  return {
    request() {
      if (frame !== null) return;
      // A host that runs the callback before returning (a test's
      // synchronous frame) has nothing pending once it returns; keeping its
      // handle would refuse every later request.
      let ran = false;
      const handle = host.requestFrame(() => {
        ran = true;
        frame = null;
        runFit();
      });
      if (!ran) frame = handle;
    },
    cancel() {
      if (frame === null) return;
      host.cancelFrame(frame);
      frame = null;
    },
  };
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
