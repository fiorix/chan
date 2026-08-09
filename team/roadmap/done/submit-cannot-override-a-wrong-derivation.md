# `--submit` cannot override a derivation that is wrong, so a hand-started agent is unreachable

Closed: shipped in [v0.87.0](../release/release-v0.87.0.md).

Status: ACCEPTED 2026-08-09 into the v0.87.0 round on the owner's call, from using the poke path during the round. A contract change, implemented host-side on `v087-submit` rather than in a delivery lane.

## What

`cs terminal write --submit=<agent>` does not mean "encode for this agent". The value is discarded. `Registry::enqueue_write_matching` (`crates/chan-library/src/terminal_sessions.rs:2071-2074`) reads it only as a boolean and substitutes the server's own derivation:

```rust
let resolved = match submit {
    Some(_) => derived.map(ResolvedSubmit::resolve),
    None => None,
};
```

When the target derives no agent, `resolved` is `None`, no chord is queued, `control_socket.rs` sets `submit_refused`, and the caller exits 69. The named agent is used for nothing but the wording of the diagnostic.

This was a deliberate design position, stated in the arg's own help: "the value here only says what you believed the target runs; a mismatch is corrected server-side". The rationale was that the server knows the truth and the client is guessing.

## Why the rationale does not hold

The server does not know the truth. `SubmitAgent::derive` (`crates/chan-shell/src/submit.rs:174`) is a whole-word sniff of the string a session was **spawned** with, plus a `CHAN_AGENT` spawn-env override. It is blind to what is actually running in the PTY now.

So the failure is not hypothetical: spawn a shell session, type `claude` into it, and that session derives nothing for the rest of its life. Every `--submit` against it exits 69 while a perfectly submittable Claude sits at the other end. Nothing can correct the derivation on a live session. `CHAN_AGENT` is spawn-time only, and the one repair the project offers is `cs terminal restart --command` (v0.86.0), which kills the session to fix a label.

The 69 in that case claims a certainty the server never had. It reports "this target cannot be submitted to" when what it knows is "this target's spawn string did not name an agent".

## Contract

- The agent named in `--submit` selects the chord, and the server encodes that agent's chord for every matched session, including one that derives nothing.
- The per-session derivation is still computed and still reported: the ack names every session whose own derivation disagrees with the request, and applies the requested chord anyway.
- A wrong name therefore delivers a wrong chord rather than being silently corrected. That is the accepted cost of making the caller authoritative, and the ack is what keeps it visible.
- Chord templates still resolve in the SERVER's environment (`CHAN_SUBMIT_<AGENT>`, then `submit.toml`, then built-in). Sender authority covers which agent, not how that agent's chord is spelled.
- Omitting `--submit` is unchanged: raw bytes, parked in the compose box.
- `ControlResponse::SubmitRefused` and exit 69 stay on the wire and in the client. A current devserver never sends one; a `cs` talking to an older devserver still must understand it.

## What this gives up, deliberately

One case regresses, and it is narrow: `--tab-group` **combined with `--submit`**, onto a group whose members run different agents. That broadcast used to resolve a per-session-correct chord for each member; it now encodes one chord for all of them, with the ack naming every member that disagreed.

Nothing else changes. A group write without `--submit` resolves no chord at all, exactly as before, so plain broadcast is untouched. A single-agent group, which is what a team provisioned from one config normally is, gets the same bytes it always did. The regression needs a mixed-agent group AND a submitted broadcast AND the sender not caring which member gets which chord.

It is accepted rather than overlooked: such a group is targeted per session instead. The alternative preserves that one case only by keeping derivation authoritative, which is the defect.

## Acceptance

- A session whose spawn command names no agent receives the chord named in `--submit`, proven at the registry and visible in the delivered PTY bytes.
- A session deriving agent A, sent `--submit=B`, receives B's chord and an ack naming A.
- A submitted broadcast onto a mixed-agent group delivers one chord and names every disagreeing member.
- Omitting `--submit` still delivers raw bytes with no chord, on a single target and on a group alike.
- `chan dump-skill` output carries the new contract, since `crates/chan-shell/src/help.rs` is what it renders.
- Every prose surface that stated the old contract is updated in the same commit: the arg help, the manpage body and its examples and side effects, `cs terminal list`'s agent-column description, the generated team `bootstrap.md`, `crates/chan-shell/design.md`, and the two orchestration docs.
- Each inverted test is proven able to go red once, then restored.

## Rough size

Small. The decision is four lines; the cost is that the old contract is documented in nine places and every one of them has to move with it.

## Implemented 2026-08-09 (`695f25ab`)

`enqueue_write_matching` resolves the agent the sender named instead of substituting the session's own derivation. The derivation is still computed and compared, and `SubmitDivergence` now carries `derived` rather than `applied`, since what was applied is no longer in question. `term_write_outcome` stops computing a refusal, and `ControlResponse::SubmitRefused` with its exit 69 stays on the wire and in the client for a `cs` speaking to an older devserver; one client test is renamed to say that is what it guards.

The rough size held for the decision and understated the prose. Nine surfaces moved with it: the arg help, the manpage body and its examples and side-effects section, the `cs terminal list` agent-column description, the generated team `bootstrap.md`, `chan-shell/design.md`, both orchestration docs, and the wire and exit-code comments. `crates/chan-shell/src/help.rs` is what `chan dump-skill` renders, so the skill output carries the new contract by construction rather than by a parallel edit.

Validation: fmt and clippy clean, 285 chan-library plus 1064 chan-server plus 123 chan-shell tests green in an sdme container.

Two mutation probes, because this is two claims and not one. Restoring derived-wins reds the four delivered-bytes tests and leaves the no-submit control green. Restoring the refusal reds only the Ok-and-name test.

**The probe found a hole in the tests rather than in the code, and it is the reason to run probes at all.** Under the first mutation, both `control_socket` ack-wording tests stayed green: they pin the message text, not the decision. A suite of only those would have certified reverted behaviour. Only the delivered-PTY-bytes assertions discriminate sender authority.

Not validated: a live poke through a running devserver. The change is proven at the registry and control-socket layers, not by watching a real agent submit.
