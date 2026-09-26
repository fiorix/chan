# Terminal env overrides for TERM, HOME, NO_COLOR and CI are silently dropped

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 3751 of the development ledger `dev/rust-review-lows.md`). A source reading against `main` at `f063ddd45`.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, which settles which keys chan owns: only its identity and control keys, `CHAN_*`, and validation refuses those with an error. The caller's env is applied after the fixed defaults, so every other explicit value wins, and the locale handling stays as it is. The work rides the terminal restore lane of [a-restart-replays-only-the-manifest-tail](a-restart-replays-only-the-manifest-tail.md) and [a-crash-restart-restores-a-stale-manifest](a-crash-restart-restores-a-stale-manifest.md), because all three edit `terminal_sessions.rs`.

## What was seen

`Session::spawn` applies the per-session `opts.env` (`crates/chan-library/src/terminal_sessions.rs:3494-3496`) before the fixed spawn environment, although the comment at `:3491` says an explicit entry "still wins on last write". The code then unconditionally sets HOME (`:3497-3501`) and TERM, COLORTERM, CLICOLOR, CLICOLOR_FORCE and FORCE_COLOR (`:3542-3546`), plus the CHAN_* keys, and removes NO_COLOR, CI and CODEX_CI (`:3607-3610`). `cs terminal new --env KEY=VALUE` and `cs terminal restart --env` accept those keys; the help says "Override a spawn environment entry" (`crates/chan-shell/src/cli.rs:950-952`). `validate_terminal_env` (`crates/chan-server/src/routes/terminal.rs:689-701`) does not refuse them either, so the request succeeds while the child never sees the value.

## What to do

Decide which keys chan owns (the CHAN_* identity and control keys) and refuse those at validation, then apply the caller's env after the fixed defaults so an explicit TERM, HOME, NO_COLOR, CI or FORCE_COLOR wins. Red first: spawn with `NO_COLOR=1` and `TERM=dumb` in `opts.env`. Today neither value reaches the child's environment.

## Boundaries

`crates/chan-library/` belongs to the v0.101.0 terminal replay lane, so land this after that lane or inside it. The restart env merge (review line 3655, carried) is a separate finding. Leave the LANG/LC_* locale logic alone, since it already honours the caller's env.
