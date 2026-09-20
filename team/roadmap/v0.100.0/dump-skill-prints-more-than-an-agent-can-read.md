# `chan dump-skill` prints more than an agent can read in one tool call

Status: accepted for v0.100.0 by the owner on 2026-09-20, sequenced at the end of the Rust lane's queue: it moves to v0.101.0 if that queue runs late, instead of holding the release. Raised the same day on the owner's instruction, during the round: the skill document is too large for a tool call in some agents, `chan dump-skill` should become more of a full index, and a new `cs dump-skill` should split the content further. The sizes below were measured with the installed `chan 0.99.0 (build git-85a3fb1e4364)`; the code was read at `main` `d7b91cbbe`, whose `crates/` tree is the released one. Which agents hit the limit, and at what size, was not measured.

## What was seen

`chan dump-skill` prints the whole skill by default: 135,019 bytes, 3,465 lines, 20,364 words, 33 `##` sections, every section the live `--help` of a real command. Its own help gives the install line `chan dump-skill > ~/.claude/skills/chan/SKILL.md`, so the document an agent loads when the skill triggers is that whole text, and an agent that reads it through a tool gets a truncated result or a refusal instead.

The pieces to do better already exist and are not the default. `--list` prints a topic index of 32 slugs with a one-line purpose and aliases in 3,084 bytes, and `--topic <slug>` prints one manual page. The pages are uneven: `serve` is 13,635 bytes, `devserver` 9,165, `cs-terminal-team` 9,055, `cs-terminal-write` 7,880, and the rest are under 6K. Nothing splits a page, so the largest unit an agent can ask for is still most of 14K.

`cs` is the same binary under another name, and `cs dump-skill` is an unrecognized subcommand. An agent inside a chan terminal, where `cs` is the surface it was taught, has to know to call `chan` for its own manual; `crates/chan-shell/src/cli.rs` sends it there by name.

`crates/chan/src/skill.rs` holds the spine of sections, the renderer, the index and the topic lookup, with tests that pin coverage (every visible command is in the spine or in a named exception list), unique slugs and aliases, resolving cross-references and the rendered frontmatter. No test pins a size.

## Desired contract

The default output of `chan dump-skill` is the full index: the frontmatter, the short lead that says what chan is, and every topic with its slug, its one-line purpose and the exact command that prints it. It is complete, in that every documented command is reachable from it, and it carries no manual page body. That is the text an install writes into `SKILL.md`.

`cs dump-skill` exists, speaks the same topics, and splits further: a page over the size budget answers with its own index of parts, and each part fits the budget. An agent never needs `chan` to read the manual of `cs`.

No single invocation prints more than the budget. The number is the owner's to name. This item proposes 8 KiB: today's index meets it, and three topic pages (`serve`, `devserver`, `cs-terminal-team`) do not. Whether the whole document stays reachable behind an explicit flag, for a human or a file, is part of the same ruling. Owner ruling, 2026-09-20: 8 KiB, and the whole document stays reachable behind an explicit flag.

## Boundaries

`crates/chan/src/skill.rs` (the spine, the renderer, the index, the split and their tests), the `dump-skill` verb in `crates/chan/src/lib.rs` and its help with the install example, `crates/chan-shell/src/cli.rs` and `help.rs` (the new `cs` verb and the pointer that names `chan dump-skill`), `crates/chan/design.md`, and any document that tells a reader to install the skill. The help text the skill is rendered from is not rewritten to make it smaller: the split is in how it is served. Pre-release posture applies, so the default changes outright and nothing keeps printing the old shape under the old spelling by accident.

## Acceptance

1. A test renders the default output and every unit `chan dump-skill` and `cs dump-skill` can print, and fails when one exceeds the budget, naming the unit and its size.
2. The default output lists every topic the spine holds, and every command it names prints a page: asserted by running the listed commands through the parser, not by reading the text.
3. A page over the budget prints its index of parts, and the parts concatenate to the page's full text with nothing lost or repeated.
4. `cs dump-skill` and `chan dump-skill` print the same bytes for the same topic.
5. The install example writes the index, and the installed text tells the agent how to fetch a topic.
6. The coverage, slug, alias and cross-reference tests that exist today still pass, unchanged in what they assert.
