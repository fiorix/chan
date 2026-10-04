import type { Terminal } from "@xterm/xterm";

// A TUI that enables xterm mouse tracking
// (1000/1002/1003 + SGR 1006) makes xterm.js forward drag gestures to the PTY
// instead of building a selection, so there is nothing for the copy chord's
// `term.getSelection()` to read. The terminal convention is to hold Shift to
// bypass mouse reporting and force a native selection. xterm.js uses Shift
// on Linux/Windows but uses Option on macOS when
// `macOptionClickForcesSelection` is enabled. This wrapper honors Shift on
// every platform, including the desktop's macOS WebView.
//
// xterm.js exposes no public hook for the force-selection modifier, so this
// reaches the internal SelectionService. The decision itself is the pure
// `forceSelectionForShift` below (unit-tested); the wiring is feature-detected
// and degrades to xterm's default if the internal shape ever changes.

/** Force a native selection (bypass mouse-reporting) whenever Shift is held,
 *  matching xterm's own non-mac semantics. Pure so the bypass policy is
 *  testable without a live terminal. */
export function forceSelectionForShift(
  e: Pick<MouseEvent, "shiftKey">,
): boolean {
  return e.shiftKey;
}

type ForceSelectionFn = (e: MouseEvent) => boolean;
type SelectionServiceLike = { shouldForceSelection?: ForceSelectionFn };
type CoreLike = { _selectionService?: SelectionServiceLike };

/** Make Shift+drag force a selection on every platform (not just Linux/Windows)
 *  so copy works while a TUI holds mouse tracking. Wraps the internal
 *  `shouldForceSelection`, OR-ing in Shift while preserving the platform default
 *  (e.g. macOS Option when `macOptionClickForcesSelection` is set). No-op if the
 *  internal shape is absent. */
export function installShiftSelectionBypass(term: Terminal): void {
  const core = (term as unknown as { _core?: CoreLike })._core;
  const selection = core?._selectionService;
  if (!selection || typeof selection.shouldForceSelection !== "function") return;
  const original = selection.shouldForceSelection.bind(selection);
  selection.shouldForceSelection = (e: MouseEvent): boolean =>
    forceSelectionForShift(e) || original(e);
}
