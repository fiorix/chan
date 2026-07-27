/// Whether a terminal keydown belongs to the native host instead of chan or
/// the PTY. macOS routes unclaimed Command chords through AppKit; preventing
/// their default in the webview keeps native menu and window actions from
/// receiving them.
export function isHostOwnedChord(
  e: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code"
  >,
  opts: { os: string; claimedByChan: boolean },
): boolean {
  return opts.os === "mac" && e.metaKey && !e.ctrlKey && !opts.claimedByChan;
}
