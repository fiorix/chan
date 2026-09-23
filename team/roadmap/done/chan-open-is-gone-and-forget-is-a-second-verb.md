# `chan open` is gone and forgetting a workspace takes a second verb

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): `chan open` is a spelling of `chan serve` and `chan close --forget` a spelling of `chan workspace forget`, with the same arguments, refusals and reach.

## What was seen

`chan open .` is a hard error today (`unrecognized subcommand 'open'`), and a test pins that: `Cli::try_parse_from(["chan", "open", "."]).is_err()` in `crates/chan/src/lib.rs`, beside `flat_workspace_subcommands_are_rejected`, which pins the list of family verbs elevated to the top level at `serve` and `close`. `chan close` takes `--on` and nothing else. Forgetting a workspace is `chan workspace forget PATH`, which runs the same teardown as `chan close` and then drops the registry entry and the metadata directory, keeping close's live-terminal refusal.

Both absences are on purpose. [cli-grammar-noun-families](../done/cli-grammar-noun-families.md), shipped in v0.94.0, removed `chan open` for two reasons: it was polymorphic (`open PATH` served a workspace while `open URL` wrote a desktop registry row), and it collided with `cs open`, the same binary under another name with the same argument shape, which its author kept confusing with it. The same item replaced `close --remove` with the `forget` verb, and ruled "no aliases, no deprecation cycle". The only trace left is in the skill: `chan dump-skill --topic open` still resolves to the `serve` page through a topic alias.

The owner now asks for both spellings back, as aliases. The ask came without a stated reason, and none is invented here; the item records what the aliases must not bring back with them.

## Desired contract

`chan open PATH` is `chan serve PATH`: the same arguments, the same flags, the same behaviour, by construction and not by a second implementation. It is an alias of the path form only. A URL argument is refused exactly as `serve` refuses it today, so the polymorphism that v0.94.0 removed does not come back. The collision with `cs open` does come back, and the help of each says in one line what the other does.

`chan close --forget PATH` is `chan workspace forget PATH`: the same teardown, the same live-terminal refusal, the same `--on TARGET` reach. `forget` stays the verb the documentation teaches; the flag is the short way to say it.

Both spellings are visible in `--help`, so the coverage tests and the skill see them, and the prefix grammar keeps resolving: no existing unambiguous prefix becomes ambiguous.

## Boundaries

`crates/chan/src/lib.rs` (the CLI definition, the two pins named above, `cmd_close`, whose `remove` parameter already carries the distinction), the `serve`, `close` and `forget` help texts and `crates/chan/src/skill.rs` where the spine or an alias list names them, `crates/chan/design.md`, and any guide that teaches the three verbs. No wire change: the control-socket `Close` tag already has its `remove` field. `chan workspace open` is not added; the alias is at the top level only, where the elevated verbs live. It shares `crates/chan/src/lib.rs` and the skill corpus with [dump-skill-prints-more-than-an-agent-can-read](dump-skill-prints-more-than-an-agent-can-read.md), so the two are sequenced in one lane, this one first, because it changes help text the other one measures.

## Acceptance

1. `chan open PATH` and `chan serve PATH` parse to the same value for every flag `serve` takes, asserted over the parsed structs; `chan open <url>` is refused with the message `serve` gives.
2. `chan close --forget PATH` and `chan workspace forget PATH` reach the same code with the same arguments, with and without `--on`, and the live-terminal refusal stops the registry removal on both.
3. The pin that `chan open .` is an error is replaced, in the same commit, by the parse-equality test above, and the commit body says the v0.94.0 ruling is reversed for these two spellings on the owner's word. The rest of the elevation list stays pinned: `add`, `list`, `forget`, `register` and the others still do not parse at the top level.
4. A test walks the top-level commands and asserts every prefix that resolved before still resolves to the same command.
5. The help of `chan open` and of `cs open` each name the other in one line.
