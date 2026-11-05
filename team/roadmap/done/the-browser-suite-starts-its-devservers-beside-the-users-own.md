# The browser suite starts its devservers beside the user's own

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: the owner's rule of 2026-11-05: nothing a test or an agent runs may touch his live devserver on the build host ("they must never interferece with my real devserver here"). It followed the finding that checks 125 and 60 start a `chan devserver` of their own, and two whole-suite runs had already run them on the host with only the `CHAN_*` variables unset and a private `XDG_RUNTIME_DIR`. Afterwards the owner's devserver read the same process since 2026-11-03, no restarts, no warning in the two runs' windows and no test names under its chan home, which is not proof. Built with the stale check repairs on `fix/stale-browser-checks`, merged into `v0124/int` as `0226903d7`, with the scenario guides' run lines in `96d71d989`.

## What was there

Every `chan devserver run` binds its discovery endpoint under `$XDG_RUNTIME_DIR/chan-devserver`, `CHAN_NO_DEVSERVER_HANDOFF` or not, and under `<tmp>/chan-devserver-<uid>` with `XDG_RUNTIME_DIR` unset. The checks that start their own devserver pass their environment through, so a run from a login shell put a throwaway devserver beside the user's own, where the user's `chan serve` (`chan open`) and `chan close` discover it; with the user's devserver down, a bare `chan serve` would register its workspace with the suite's as the only candidate. Nothing in the runner refused such a run, and the scenario guides' run lines had no runtime directory of their own.

## Desired contract

1. `scripts/e2e/browser-smoke/run.mjs` exits 2, the unrunnable status, before it installs, builds or starts anything, when `XDG_RUNTIME_DIR` is unset or empty, names no directory, or resolves after `realpath` to `/run/user/<uid>` for the running uid, and says why and how to run instead: a private 0700 directory (`XDG_RUNTIME_DIR="$(mktemp -d)"`) or an isolated guest.
2. `--deps-only`, which `make browser-smoke-lib-test` and the pre-push gate use, starts no chan process and is not refused.
3. The runner's README (its Run example, environment list and exit statuses), the gate skill's run line and the scenario guides' run lines say so.
4. `CHAN_NO_DEVSERVER_HANDOFF` stays a client-side switch; the runner's guard covers the tests.

## Boundaries

`scripts/e2e/browser-smoke/run.mjs`, its `README.md`, `.agents/skills/gate/SKILL.md`, and four guides under `scripts/e2e/scenarios/`. No product code. The isolated guest rig the round used for every browser run (`dev/hn-tmux-rig/`) is outside the repository.

## Acceptance

With npm, cargo, Chrome and chan replaced by stubs that record their argv, in an isolated guest: the runner refuses with status 2 and starts nothing for `XDG_RUNTIME_DIR` unset, empty, `/run/user/0` and a symlink to it; with a private directory the same stubs record the Chrome probe, the builds and `chan serve`. No chan process is left either way. `make browser-smoke-lib-test` is green with `XDG_RUNTIME_DIR` unset.

## Built

`fcd946cef`, test(browser-smoke): refuse a run in the user's own runtime directory, and `96d71d989`, docs(e2e): give the scenario run lines a private runtime dir. Verification as acceptance, recorded in the commit.

Open: the guard reads `XDG_RUNTIME_DIR` alone; the rest of the caller's environment, its `CHAN_*` variables, display and session bus among them, still passes through to the checks' processes, where the server runs under a sandboxed `CHAN_HOME`. The desktop e2e suite's own isolation is the v0.125.0 row [`two-wireguard-e2e-suites-reach-past-their-isolation`](../v0.125.0/two-wireguard-e2e-suites-reach-past-their-isolation.md).
