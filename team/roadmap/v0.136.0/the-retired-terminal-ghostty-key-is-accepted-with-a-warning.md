# The retired terminal.ghostty key is accepted with a warning

Status: accepted for v0.134.0 by the owner on 2026-11-23 with the Ghostty-only plan (`dev/team-ghostty-web-ng-plan.md`, configuration retirement item 6, and its review `dev/team-ghostty-web-ng-plan-review.md`); not started, and not to be built before [the row that retires the key](../done/chan-carries-xterm-js-as-a-second-terminal-backend.md) has shipped and its warning period has passed. It carries to the next version until then. Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0.

## What is there now

Once that row ships, the key `[terminal] ghostty` in `server.toml`, `terminal.ghostty` in a preferences patch and `server.terminal.ghostty` in `chan config` are accepted and ignored: a stored `false` warns, a patch's boolean is ignored, and the CLI's set and get succeed with a warning. A presence-aware compatibility reader keeps that working.

## Desired contract

1. An explicit use of the key is refused at the file, the API and the CLI, as the retired `attachments_dir` is refused today (`config_patch_rejects_retired_attachments_dir_as_unknown`, `retired_attachment_key_is_unknown_to_cli_get_and_set`).
2. The compatibility reader and any DTO kept for the warning period are removed. Deleting a Serde field alone is not enough, since unknown nested fields may be ignored.

## Acceptance

1. Tests at each boundary that a present key is refused with a message naming it, red against the warning-period code.
2. The release that does this says so in its changelog, with the version in which the warning began.

## Decided, 2026-11-27: refused at the API and the CLI, tolerated in the file

Read at `0672d1499` by the session that prepared the v0.136.0 round, by reading and against the v0.133.0 tag:

- The row's model, the retired `attachments_dir`, is refused at the API and the CLI only. In `server.toml` it is tolerated with a warning (`crates/chan-server/src/config.rs`, the load path).
- v0.133.0 and earlier wrote `ghostty = true` into `server.toml` on every save (the field had a serde default and no skip). The warning that began with v0.134.0 fires only for a stored `false`; a stored `true` is silent.
- A `server.toml` that fails to load does not stop the server: it logs one line and falls back to every default (`crates/chan-server/src/lib.rs`, `ServerConfig::load().unwrap_or_else`).

So a refusal at the file would silently reset the server settings of any install whose file was last saved by v0.133.0 or earlier, on a key that install was never warned about. Put to the owner with the recommendation to refuse the key at the API and the CLI and keep the file tolerant, he answered on 2026-11-27: "1. ok take your recommendation".

Contract 1 therefore reads: an explicit use of the key is refused at the API (a preferences patch) and at the CLI (`chan config` set and get), with a message naming it; in `server.toml` the key stays accepted, a stored `false` still warns, and the key is dropped at the next save, as today. Contract 2 narrows with it: the reader that keeps the file tolerant stays, and what serves only the API's and the CLI's acceptance is removed. Acceptance 1 is read at the API and the CLI, with a test that a file holding the key still loads with its other settings kept. It is built in v0.136.0. Browser check 94 tests the compatibility and changes with it.
