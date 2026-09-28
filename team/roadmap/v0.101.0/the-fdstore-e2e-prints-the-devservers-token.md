# The fd-store e2e suite prints the devserver's token into its log

Status: raised for a decision on 2026-09-28 by the report of the order on parked terminals across a prefix move (`dev/v0101-team/reports/report-Services-34.md` in the development tree, "Found beside, not changed", 2), whose run of the suite printed the token four times into its log, caught by the builder's own check and masked by hand ("The e2e", "Token"). Read at `ada0ecc4c`; the suite was not run for this item. Recommendation, the lead's: accept for v0.101.0 as a small order: the suite prints no token, or masks it.

## What was seen

`scripts/e2e/devserver-fdstore.sh` starts and restarts its devserver with `chan devserver restart --service=systemd` four times, each with its standard output left on the suite's (`:450`, `:500`, `:637`, `:642`). That command prints the devserver's bearer token on its standard output as a `CHAN_DEVSERVER_TOKEN=<token>` line once the unit is up (`emit_devserver_token_marker`, `crates/chan/src/lib.rs:5736-5748`, the line at `:5739`, called from `bootstrap_systemd_unit`, `:5405-5428`). So every run of the suite, green or red, prints the token of the devserver it drives four times, and a log that a run leaves behind holds it. A run that fails also keeps its work directory (`fail`, `scripts/e2e/devserver-fdstore.sh:40-44`), whose `CHAN_HOME` (`:103-104`) holds the devserver's `config.json`, from which the suite reads the token (`devserver_token`, `:205-208`).

The replay suite, which drives the same unit the same way, masks the line and a `?t=` in a URL in what it prints (`restart_devserver`, `scripts/e2e/devserver-terminal-replay.sh:372-379`), so the fd-store suite is the one of the two that prints it. The token is a throwaway devserver's under a throwaway `CHAN_HOME`, live while that unit runs.

## Desired contract

A run of the fd-store suite prints no devserver token, and what a failed run keeps is said where the suites are described.

## What to do

A suggestion beyond the record: send each `chan devserver restart` of the suite through the filter the replay suite uses, or give both suites one helper for it; say in `scripts/e2e/README.md` that a failed run's kept work directory holds the devserver's config and its token. Check: a run's log holds no token value after the marker.

## Boundaries

`scripts/e2e/devserver-fdstore.sh`, `scripts/e2e/devserver-terminal-replay.sh` if one helper serves both, and `scripts/e2e/README.md`. Not the command's marker line, which its clients read.

## Acceptance

1. A run of the suite prints the four restarts' marker lines with the token masked.
2. `make shell-check` passes.
3. `scripts/e2e/README.md` says what a failed run's kept work directory holds.
