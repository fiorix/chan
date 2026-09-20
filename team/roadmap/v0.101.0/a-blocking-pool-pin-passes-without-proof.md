# The blocking-pool pin passes for a handler that does its work on the runtime thread

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where a reviewer read the helper and the eight handlers it pins and recorded the gap. A source reading against `main` at `d3de0180b`; the helper was not executed against a deliberately wrong handler.

## What was seen

`assert_uses_blocking_pool` (`crates/chan-server/src/state.rs`) spawns one blocking task that holds the only blocking thread, polls the handler once with `now_or_never`, releases the thread and then awaits the handler. Its assertion is that the first poll did not complete. That is a proof that the handler awaited something pending while the pool was occupied, which is weaker than its name: a handler that does its synchronous filesystem work inline and then awaits any pool task passes, and so does one that awaits something pending once before doing its work inline. The handlers it pins today do neither, which is why this is a gap in the check rather than a defect, but the check is what later route tests will lean on.

The review named the narrowing: re-poll while the pool is still held and assert the handler is still pending, and give write routes an optional probe so they can assert the file on disk is unchanged after the first poll. Both are unverified suggestions, not measurements.

## Desired contract

The helper proves what its name says: that the handler's synchronous work did not run on the runtime thread, so a handler that moves its work back inline fails the test that claims to forbid it.

## Boundaries

`crates/chan-server/src/state.rs` (`assert_uses_blocking_pool`) and the route tests that call it, in `crates/chan-server/src/routes/`.

## Acceptance

1. A deliberately wrong handler, one that does its I/O inline and then awaits a pool task, passes today's helper and fails the narrowed one, with both results recorded.
2. Every existing caller still passes unchanged, so the narrowing is a strengthening and not a rewrite of what is pinned.
3. At least one write route asserts, through the helper, that its target file is untouched after the first poll.
