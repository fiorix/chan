// Terminal scrollback sizing helpers.
//
// xterm.js measures `scrollback` in lines, not bytes. The Settings UI
// exposes a per-terminal MB budget; the spawn site needs lines. Both
// the conversion and the slider clamps live here so a future change
// to the constants (or to xterm.js's per-cell footprint) lands in one
// place, and the unit tests cover the conversion without needing a
// running PTY.

/// Settings slider bounds. Kept in lockstep with the Rust constants in
/// `crates/chan-server/src/config.rs` (`TERMINAL_SCROLLBACK_MB_MIN` /
/// `TERMINAL_SCROLLBACK_MB_MAX`).
export const SCROLLBACK_MB_MIN = 10;
export const SCROLLBACK_MB_MAX = 50;

/// Default budget for first-launch users (and for `default_term` clear
/// fallbacks coming back from the server). Translates to ~11k lines at
/// the baseline 80-col width.
export const SCROLLBACK_MB_DEFAULT = 10;

/// Baseline column width used for the MB -> lines conversion. xterm.js
/// allocates scrollback per visible row regardless of how wide the
/// terminal happens to be at a given moment; budgeting against 80 cols
/// matches the conservative case (wider terminals consume more bytes
/// per line, so the effective MB cap is closer to the configured
/// budget for power users running wide windows).
export const SCROLLBACK_BASELINE_COLS = 80;

/// Empirical xterm.js per-cell footprint on modern V8. Each cell is
/// ~12 bytes: 1-2 character bytes + colour / attr packing + width
/// flags. Tracked here so the conversion has a single source of truth
/// the tests can pin.
export const SCROLLBACK_BYTES_PER_CELL = 12;

/// Round-trip a raw MB value from `Preferences.terminal.scrollback_mb`
/// into the Settings slider's accepted range. `undefined` / NaN /
/// non-finite values fall through to the default (so an older server
/// that doesn't ship the field doesn't strand the terminal with 0
/// scrollback); literal 0 also snaps to the default to match the
/// server-side `sanitize_terminal_config`.
export function clampScrollbackMb(raw: number | null | undefined): number {
  if (raw === null || raw === undefined) return SCROLLBACK_MB_DEFAULT;
  if (!Number.isFinite(raw)) return SCROLLBACK_MB_DEFAULT;
  const rounded = Math.round(raw);
  if (rounded <= 0) return SCROLLBACK_MB_DEFAULT;
  if (rounded < SCROLLBACK_MB_MIN) return SCROLLBACK_MB_MIN;
  if (rounded > SCROLLBACK_MB_MAX) return SCROLLBACK_MB_MAX;
  return rounded;
}

/// MB budget -> xterm.js scrollback line cap. Caller passes the
/// already-clamped MB value (use `clampScrollbackMb` upstream) and an
/// optional column override; the result is the number of scrollback
/// lines xterm.js should keep. Floored to an integer because xterm
/// rejects fractional caps.
export function scrollbackLinesFromMb(
  mb: number,
  cols: number = SCROLLBACK_BASELINE_COLS,
): number {
  const bytes = mb * 1024 * 1024;
  const perLine = Math.max(1, Math.floor(cols)) * SCROLLBACK_BYTES_PER_CELL;
  return Math.max(1, Math.floor(bytes / perLine));
}
