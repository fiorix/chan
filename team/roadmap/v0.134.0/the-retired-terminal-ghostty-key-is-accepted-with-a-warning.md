# The retired terminal.ghostty key is accepted with a warning

Status: accepted for v0.134.0 by the owner on 2026-11-23 with the Ghostty-only plan (`dev/team-ghostty-web-ng-plan.md`, configuration retirement item 6, and its review `dev/team-ghostty-web-ng-plan-review.md`); not started, and not to be built before [the row that retires the key](chan-carries-xterm-js-as-a-second-terminal-backend.md) has shipped and its warning period has passed. It carries to the next version until then.

## What is there now

Once that row ships, the key `[terminal] ghostty` in `server.toml`, `terminal.ghostty` in a preferences patch and `server.terminal.ghostty` in `chan config` are accepted and ignored: a stored `false` warns, a patch's boolean is ignored, and the CLI's set and get succeed with a warning. A presence-aware compatibility reader keeps that working.

## Desired contract

1. An explicit use of the key is refused at the file, the API and the CLI, as the retired `attachments_dir` is refused today (`config_patch_rejects_retired_attachments_dir_as_unknown`, `retired_attachment_key_is_unknown_to_cli_get_and_set`).
2. The compatibility reader and any DTO kept for the warning period are removed. Deleting a Serde field alone is not enough, since unknown nested fields may be ignored.

## Acceptance

1. Tests at each boundary that a present key is refused with a message naming it, red against the warning-period code.
2. The release that does this says so in its changelog, with the version in which the warning began.
