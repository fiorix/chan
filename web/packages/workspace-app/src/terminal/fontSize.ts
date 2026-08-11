// Terminal renderer font-size bounds.
//
// The Settings number input clamps to these on commit, and the server
// clamps every write to the same range, so both sides import one
// constant pair instead of keeping two numbers in lockstep by hand.

/// Inclusive bounds the Settings UI exposes for the terminal font-size
/// input. Mirrored from the Rust constants in
/// `crates/chan-library/src/config.rs` (`TERMINAL_FONT_SIZE_MIN` /
/// `TERMINAL_FONT_SIZE_MAX`).
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
