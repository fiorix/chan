// Terminal scrollback sizing: the Settings slider's per-terminal MB
// budget and its clamps. The spawn site passes the clamped budget to the
// widget in bytes, which bounds its core's history.

/// Settings slider bounds. Kept in lockstep with the Rust constants in
/// `crates/chan-library/src/config.rs` (`TERMINAL_SCROLLBACK_MB_MIN` /
/// `TERMINAL_SCROLLBACK_MB_MAX`).
export const SCROLLBACK_MB_MIN = 10;
export const SCROLLBACK_MB_MAX = 50;

/// Default budget for first-launch users (and for `default_term` clear
/// fallbacks coming back from the server).
export const SCROLLBACK_MB_DEFAULT = 10;

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
