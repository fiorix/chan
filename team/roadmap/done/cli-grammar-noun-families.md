# The CLI grammar moves to noun families with a pinned elevation list

Status: SHIPPED in [v0.94.0](../../release/release-v0.94.0.md). Landed by merging `feat/cli-grammar` (83f4cf27, own gate green in its container before push); the full gate and the round's validation ran on the merged tree, and the deferred remote workspace arms remain follow-up scope pending an owner ruling.

## Problem

The CLI's verb layer contradicted itself and its own system. `chan open` was polymorphic in object kind: `open PATH` served a workspace while `open URL` wrote a desktop registry row without serving or dialing anything, and its help had to say the URL form "does something else entirely". The verb collided with `cs open` (same binary, argv[0] dispatch, same argument shape), a faithful macOS-style open that keeps its name; the author kept confusing the two, and the docker README had to state "there is no `chan serve`" to head off the verb users reach for naturally. The one-line help translated `open` as "Serve a workspace", `chan ps` speaks `served`/`free`, the internals never left serve vocabulary (`cmd_serve`, `UnserveMode`), and the registry-drop rode two spellings (`chan close --remove`, `chan workspace rm`) with diverging refusal behavior. `chan devserver` modeled its verbs as mutually exclusive flags (`--start`, `--stop`, ...), and the devserver's client side had no CLI at all: a registration written by `chan open URL` could only be removed in the launcher UI, and a connection could only be dialed or dropped there.

## Direction

Noun families are the structural layer; a verb names one object kind with one selector grammar and never dispatches on argument shape to pick its object.

- `chan workspace` gains the lifecycle: `serve` (all former open PATH-form flags), `close` (teardown only), `forget` (teardown-if-live then drop the registry entry and metadata; replaces `close --remove` and `workspace rm`, keeping close's live-terminal refusal, which `workspace rm` used to bypass).
- Top level: `serve` and `close` are the only elevated family verbs, thin delegates over one flattened args struct per verb so the spellings cannot drift; the elevation list is pinned by `flat_workspace_subcommands_are_rejected`. `ps` stays top-level as the chan-wide overview. `open` is gone; a URL argument to `serve` is refused with a pointer at `chan devserver register`.
- `chan devserver` holds two faces under one noun, separated by argument shape: server-side verbs `run`/`start`/`stop`/`restart`/`status`/`join`/`rotate-token` (the former flag-verbs; no target, the process is a per-CHAN_HOME singleton) and client-side verbs `register URL`/`ls`/`connect TARGET`/`disconnect TARGET`/`forget TARGET [--force]` (desktop-registry operations; TARGET is a registered URL or launcher label, resolved desktop-side with refuse-over-guess on ambiguity).
- New capability, not just renames: `ls`/`connect`/`disconnect`/`forget` ride four additive handoff `Request` variants over the well-known desktop socket (the desktop's loopback HTTP port and launcher bearer are not discoverable by the CLI, so the handoff is the only honest transport). `connect` is fire-and-return like `Upgrade`; `forget` refuses a connected row and names `disconnect` or `--force`; `register` now dedupes by endpoint identity (scheme, host, port) with update-in-place, so a re-register cannot grow twin rows.
- Wire contracts are untouched: the control-socket `Close` tag and its `remove` field, the `open_workspace`/`close_workspace`/`open_devserver` handoff tags, and the internal serve/unserve identifiers keep their names. Unit writers (systemd ExecStart, launchd ProgramArguments) emit `devserver run`; the persisted-unit parsers still accept the old form, pinned by deliberately old-form test fixtures.
- No backwards compatibility by ruling: no aliases, no deprecation cycle. Old dump-skill topic slugs keep answering through `Section.aliases` (`--topic open` resolves to the serve page).

Deferred, explicitly out of this item's scope: remote workspace arms (`chan workspace serve|close|forget WS --devserver TARGET`). The blocker is a design call, not effort: serve's existing `--devserver=<port|url>` flag selects a live local devserver, and the remote-target flag would share its name with a different value grammar and object. Needs an owner ruling before implementation.

## Acceptance

- The full workspace test suite is green in the per-worktree build container, including the renamed `serve_close.rs` integration tests, the devserver resilience suite under verb grammar, handoff wire round-trips for the four new request and response variants, and the skill coverage test over the new spine (`serve` slug with `open` alias, `forget` and `register` sections).
- The elevation list is a tested invariant: `chan add`/`list`/`forget`/`register`/`connect`/`disconnect`/`start`/`stop` do not parse at top level; `chan open .` and every `--start`-style devserver flag-verb are hard errors.
- Behavioral refusals verified against the built binary: `chan serve URL` points at `chan devserver register`; bare `chan devserver` prints the verb list; top-level help lists serve/close/ps first, then the families.
- Every documentation, packaging, and web surface speaks the new grammar: docs/manual, design docs, .agents standards, docker (CMD and README, including the rewritten "there is no chan serve" trap sentence), kube args, distro units and PKGBUILDs, release smokes, marketing pages, and launcher demo data (whose connect script was also corrected to `devserver join`). Verified by a six-way sweep plus an adversarial two-pass review (residual grep and prose read), with user-visible flag-grammar strings in errors and status output fixed.
- `make pre-push` (the CI gate) passes on the branch in the build container.

## Evidence

- chan lib tests 204 passed / 0 failed after the restructure; full-workspace `cargo test` green in the `chan-cli` container (Ubuntu rootfs, btrfs).
- Operational skew note for the release notes: a systemd/launchd unit installed by a pre-rename chan invokes `chan devserver` with no verb; after upgrading the binary in place, `chan devserver start` (or `restart`) rewrites the unit. Until then a supervisor-driven crash-restart of the old unit fails to parse. Accepted under the no-backcompat ruling.
