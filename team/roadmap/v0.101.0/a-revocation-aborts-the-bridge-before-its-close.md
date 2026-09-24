# A revocation aborts the bridge before its Close can go out

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.101.0 on 2026-09-23. From the admitted-tunnel lane's report (what the item got wrong, items 1 and 2) and the independent review of `v0101/admitted-tunnel` (finding L1 and its third question), which recorded the gap while building [an-admitted-tunnel-outlives-its-connection](an-admitted-tunnel-outlives-its-connection.md). The mechanism was reproduced once by a test the lane wrote and then removed: driven through a real `SessionStore::revoke`, it failed with `expected a Close frame, got Some(Err(Protocol(ResetWithoutClosingHandshake)))`. The code claims below are a source reading against `main` at `ee060262e`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended, which settles the open shape question for the cooperative shape: cancel the token, let the bridge send its bounded 1008 Close, and abort only at a drain deadline, with a test through a real `SessionStore::revoke`. The two arms stay.

## What was seen

`bridge_ws` (`gateway/crates/devserver-proxy/src/proxy.rs`) has two arms that answer a revoked session with a Close frame, 1008 `session revoked`: one in the setup select, one in the pump. Neither can fire on a real revocation. `SessionRecord::revoke_authority` (`gateway/crates/devserver-proxy/src/session_store.rs`) cancels the session's token and then calls `ActiveOperations::revoke`, which aborts every operation task whose abort handle was attached, and the bridge is spawned through `ActiveOperation::spawn`, which attaches it. The abort lands before the bridge is polled again, so the socket is dropped mid-handshake and the browser sees a reset with no Close (1006, `wasClean=false`), the same thing it sees on a network drop. On the tests' current-thread runtime the abort wins deterministically; on the production multi-thread runtime it is a race the abort wins unless the bridge happens to be polled on another worker between the cancel and the abort.

The same abort sits behind expiry. `SessionStore::prune_expired` calls `revoke_authority` on every record past its expiry, and the proxy's control loop runs it on a one-second tick, so whether the bridge's own `sleep_until(expires_at)` arm sends 1008 `session expired` or the prune aborts the socket first is a race between two clocks. The existing expiry test is green because its harness runs no pruner.

The proxy's tests pin both 1008 frames by cancelling the token without the abort, which is the shape the arms were written for and one production takes only when the bridge wins the race.

## Desired contract

A browser whose session is revoked or expires while it holds a WebSocket through the proxy receives the 1008 Close with its reason before the socket goes away, or the two arms and the two design sentences that describe them stop promising it.

## What to do

Make revocation cooperative for bridges: cancel the token, let the bridge send its bounded Close, and abort only at a drain deadline, so the abort stays the backstop for a bridge that does not finish. That lives in `session_store.rs`, beside `revoke_authority` and `prune_expired`, which is why the admitted-tunnel item stopped short of it. The alternative is to remove the two arms and say in `gateway/crates/devserver-proxy/design.md` that a revoked or expired session is reset without a Close. Either way, a test that drives a real `SessionStore::revoke` during setup and asserts what the client receives is the acceptance; the lane's removed test is the shape to reuse.
