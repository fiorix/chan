# The chan tree does not speak the cs prefix grammar

Status: REGISTERED for v0.95.0 and implemented on main in the same round; the item closes into `done/` at GA.

## Problem

`cs` resolves every action from an unambiguous first-letters prefix, iproute2 style (`cs o`, `cs te l`), refusing ambiguous ones over guessing; the mechanism is `infer_subcommands` at every level of its clap tree, and the contract is documented in `cs --help` itself. The `chan` tree set it nowhere except the `shell` subtree that IS the cs surface, so one binary spoke two parsing conventions: the same fingers that type `cs te l` all day were refused `chan w ls`, `chan de status`, and `chan du`. clap does not propagate the setting to child commands, which is how the gap persisted per-level while looking closed at the root.

## Direction

- Every subcommand-bearing node of the chan tree sets `infer_subcommands = true`: the root, the noun families (`workspace`, `devserver`, `config`), the workspace sub-families (`index`, `reports`, `metadata`, `contacts`), and `contacts import`; `shell` already carried it.
- No canonical spelling changes and no aliases are introduced, so the v0.94.0 no-backcompat ruling is untouched: inference abbreviates the one canonical spelling at parse time, while help, docs, completions, unit writers, and wire contracts keep full names.
- Ambiguity is refused rather than guessed, matching cs: `s` (serve/shell), `c` (close/config/completions), `d` (devserver/dump-skill), with the auto-generated `help` counting as a sibling in every set.
- `chan --help` documents the grammar the way `cs --help` does, so dump-skill carries it to agents without a separate page.

## Acceptance

- `subcommand_prefixes_resolve_iproute2_style` pins resolution at the top level, inside the noun families, and three levels deep (`chan w i r PATH`); `ambiguous_subcommand_prefixes_are_rejected` pins per-level refusals with trailing args shaped for one candidate, so a silent guess toward that candidate parses cleanly and fails the `is_err` assertion.
- The pinned elevation list (`flat_workspace_subcommands_are_rejected`) stays green: no flat workspace or devserver verb becomes reachable through inference, because none of those words is a prefix of any top-level command.
- The help checkers (`help_examples_name_real_commands`, width and summary rules) stay green over the new `chan --help` paragraph.
- The full gate (`make pre-push`) is green in the build container before push.
