# The submit agents name no muse

Status: raised by the owner on 2026-10-03 and accepted with the request, for v0.102.0. Read against the tree at `d888ec0cc`; nothing was run, and the muse client was not probed.

## Owner ruling

The owner's words, 2026-10-03: "add support for cs terminal write --submit muse, which is the same as gemini submit chord; just to have the name 'muse' there and you can test with the muse client on this machine".

## What was seen

`cs terminal write --submit=<agent>` takes one of six names, the variants of `SubmitAgent` (`crates/chan-shell/src/submit.rs:41`): agy, claude, codex, gemini, kimi, opencode. `muse` is not one, so clap refuses it, a spawn command that runs the muse client derives no agent (`SubmitAgent::derive`, `submit.rs:186`), and `CHAN_AGENT=muse` is an unrecognized value that falls through to the command sniff. A session running muse is therefore a shell member: no chord of its own, no identity poke from `cs terminal team`, and a sender has to know to name `gemini` to reach it.

Gemini's encoding is two things, and both matter for an agent that is "the same as gemini". Its template is the body followed by a bare CR (`"{}\r"`, `submit.rs:226-236`). And its body and chord are kept as two separately idle-gated queue entries, because Gemini 0.51 turns a closely following Return into Shift+Return (`submit.rs:64-70`; the split and its depth accounting in `crates/chan-library/src/terminal_sessions.rs:3591-3660`, the template again at `:6418`).

## Desired contract

`muse` is a submit agent with its own name everywhere the other six appear, and it encodes exactly as gemini does: the same template, and the same split into a body entry and a chord entry. `cs terminal write --submit=muse` is accepted; a spawn command with `muse` as a whole word derives it; `CHAN_AGENT=muse` forces it; `cs terminal list` reports it; a team member that runs it gets its identity poke and its chord line in the generated bootstrap; the per-agent chord override accepts a `[muse]` section.

Recommended shape: a variant of its own that shares gemini's template and queue path, not an alias that resolves to `Gemini`. An alias would make `cs terminal list` and the bootstrap roster report `gemini` for a muse session, and the enum already keeps a variant per client where the bytes agree today ("agy, kimi, and opencode each keep their own measured template even where the current bytes agree", `submit.rs:224-225`).

## What to do

Add the name at every site that lists the agents, and pin each:

- `crates/chan-shell/src/submit.rs`: the variant with its doc line, `from_agent_name`, `name`, `derive` (the `CHAN_AGENT` match and the word sniff), `default_template`, and the tests beside them.
- `crates/chan-library/src/terminal_sessions.rs`: wherever `SubmitAgent::Gemini` selects the split body and chord entries, muse selects the same path.
- `crates/chan-server/src/submit_config.rs` (the override file's sections, `:39`, `:56`), `src/routes/team_config.rs` (the bootstrap's chord description, `:166-174`), `src/routes/terminal.rs:194`.
- `crates/chan-shell/src/cli.rs:930` and `src/help.rs` (the name lists at `:873`, `:1167`, `:1208`, `:1213`), `crates/chan-shell/design.md:148-158`.
- The SPA mirror: `agentForMember` in `web/packages/workspace-app/src/state/teamDialog.svelte.ts:53-58` with `teamDialogAgent.test.ts`, and the comment at `src/api/client.ts:1535`.
- The agent lists in `.agents/orchestration/README.md` and `.agents/orchestration/teams.md`.

Then probe the live client, as every other default was: send a single-line, a multi-line and a paste-sized body to a running muse session with `--submit=muse` and confirm each arrives as one submitted message. If muse does not behave as gemini does, say so in the report with the bytes that do work; the owner's premise is that it does.

## Boundaries

The six existing agents' names, templates and queue behavior are unchanged, and so is the rule that `--submit` encodes whatever agent the sender names. No new chord: if the live probe disagrees with the premise, that is a finding for the owner, not a seventh template built on the spot.

## Acceptance

- `cs terminal write --submit=muse` is accepted, and its bytes and queue entries equal gemini's for the same body, pinned in chan-shell and chan-library.
- `SubmitAgent::derive("muse", None)`, a wrapper such as `my-muse.sh`, and `CHAN_AGENT=muse` over another command all yield muse; `musette` does not. The SPA mirror agrees, pinned in vitest.
- A team config with a muse member generates a bootstrap that names its chord.
- The live probe's result against the muse client on the owner's machine is in the report. At provisioning no `muse` executable was on the provisioning shell's PATH or its login shell's, so the builder locates the client first and asks the owner through the lead if it cannot.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, a reading of its diff, an independent review and its own gate. This record was written that day from that reading.

`muse` is a submit agent with a variant of its own (`SubmitAgent::Muse`, `crates/chan-shell/src/submit.rs`), in its alphabetical place between kimi and opencode in the enum and in the command sniff, so `muse --profile opencode` derives muse and `kimi muse` derives kimi. It encodes as gemini does: the same template and the same split into a body entry and a chord entry. The name is at every site that lists the agents: the CLI's value list and help, the per-agent override file (`crates/chan-server/src/submit_config.rs`), the bootstrap's chord description, the team's identity poke (pinned as two writes, the body then a bare CR), `docs/config-reference.md`, the orchestration documents, and the workspace app's mirror (`agentForCommand`, the `SubmitAgent` union and the team dialog's hint). Live probe on 2026-10-03 with Muse Code 1.4.2 on the owner's machine, through the running v0.101.0 devserver with `--submit=gemini`, since that server does not know the name: a one-line, a three-line and a 41-line body each arrived as one submitted message. Not established: a model reply (every request ended in the client's billing error), whether muse needs the split, and the name `muse` end to end on a devserver built from this branch, which rests on the pins.
