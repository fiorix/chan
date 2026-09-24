# Three MCP error texts follow an unpinned Display

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the Lead follow-ups ledger (2026-09-23 02:50Z, review of the Rust-lows folds, risk 4) and the release report's Rust-lows follow-up. A source reading against `main` at `6237c2677`.

## What was seen

`mcp.rs` forwards `LlmError::WriteConflict`, `WriteTooLarge` and `ListingTooLarge` through their own `Display` (`crates/chan-llm/src/mcp.rs:736`, from `7da3706f5`), whose text lives in the `#[error]` attributes (`crates/chan-llm/src/error.rs:23`, `:26`, `:29`). The output is identical to the strings `mcp.rs` used to spell out, but no test pins it, so an edit to an `#[error]` attribute changes what the model sees without touching `mcp.rs`.

## What to do

Pin the three forwarded strings in a chan-llm test at the MCP boundary.
