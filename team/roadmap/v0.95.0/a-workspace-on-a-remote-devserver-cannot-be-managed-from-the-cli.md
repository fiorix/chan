# A workspace on a remote devserver cannot be managed from the CLI

Status: REGISTERED for v0.95.0. Carried from the v0.94.0 CLI grammar item's deferred scope, unblocked by the owner ruling recorded below.

## Problem

v0.94.0 gave the devserver noun client-side verbs, so a registered remote devserver can be listed, dialed, and dropped from the CLI (`chan devserver register|ls|connect|disconnect|forget`), and the workspace family owns the local lifecycle (`chan workspace serve|close|forget`). The two do not compose: a workspace ON a registered remote devserver can only be managed through the launcher UI in a browser (owner mutation over the gateway rides the proxy's signed assertion), while the CLI's workspace verbs act only on the local host. The v0.94.0 item deferred these remote arms on one design question, not on effort: `serve` already uses `--devserver=<port|url>` to select a live local devserver, and reusing that flag for a remote registered target would make one flag dispatch on value shape, the exact pattern the noun-family rework abolished.

## Ruling (2026-08-19, owner)

The remote arm is a new flag, `--on TARGET`, on all three workspace lifecycle verbs: `chan workspace serve WS --on TARGET`, `chan workspace close WS --on TARGET`, `chan workspace forget WS --on TARGET`. `--devserver=<port|url>` keeps its existing meaning (local live-devserver selection) untouched. `TARGET` uses the devserver client-side verbs' grammar: a registered URL or launcher label, resolved desktop-side with refuse-over-guess on ambiguity. One flag names one object kind with one value grammar.

## Direction

- The three verbs gain the `--on TARGET` arm; without the flag their behavior is byte-identical to v0.94.0.
- Resolution and transport follow the devserver client-side verbs' model: the desktop registry is not CLI-discoverable, so the arms ride the well-known desktop handoff socket, and `TARGET` resolution refuses over guessing.
- The elevated top-level `chan serve`/`chan close` delegates carry the flag only if the flattened args structs keep the spellings from drifting, per the pinned elevation contract.
- `forget WS --on TARGET` keeps `forget`'s live-terminal refusal semantics on the remote side rather than silently bypassing them.
- Wire contracts stay additive, matching the four handoff `Request` variants the client-side verbs added.

## Acceptance

- The three arms round-trip against a registered remote devserver end to end: serve mounts, close tears down, forget refuses while live and drops the registration path when not, each verified against real processes rather than mocks.
- `--on` and `--devserver` are pinned as distinct by tests: `--on` with a port-shaped value and `--devserver` with a label-shaped value are both refusals, not guesses.
- Ambiguous `TARGET` resolution is a refusal naming the candidates.
- Documentation, dump-skill coverage, and the launcher demo data speak the new arms in the same change.
- `make pre-push` green on the branch in a build container.
