# A scripted reports disable without --yes exits 0 having changed nothing

Status: raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 5033 of the development ledger `dev/rust-review-lows.md`); not accepted. A source reading against `main` at `f063ddd45`.

## What was seen

`cmd_reports_set` (`crates/chan/src/lib.rs:6915`) reads the disable confirmation from stdin without checking that stdin is a terminal (`:6931-6944`). Under a script, a pipe or `</dev/null` it reads EOF, prints "Aborted." to stderr and returns `Ok(())` (`:6946-6948`), so `chan workspace reports disable --path X` exits 0 while reports stay enabled. `chan upgrade` handles the same situation correctly: on non-TTY stdin it bails with "use -y to confirm upgrade in non-interactive mode", and it also bails on a declined prompt (`crates/chan/src/update.rs:881-882`, `:891`).

## What to do

Refuse non-interactive stdin without `--yes` with an error that names `--yes`, and return an error rather than `Ok(())` when the prompt is declined, mirroring `update.rs`. Red first: a binary test that runs the disable with null stdin and asserts a nonzero exit and that the persisted reports flag is still on.

## Boundaries

Only the disable confirmation changes; the enable path, `--yes` and the flag's persistence stay as they are. `crates/chan/src/lib.rs` is the subject of the-chan-cli-crate-is-one-13k-line-file.md, so coordinate with that split if it is in flight.
