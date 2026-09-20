# An ended tunnel keeps its connection, and a refused bridge tells the browser nothing

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where an independent review recorded both halves and they were parked. A source reading against `main` at `d3de0180b`; neither half was reproduced, and reaching the first needs a token valid at dial time.

## What was seen

In `drive_tunnel_conn` (`crates/chan-tunnel-server/src/tunnel.rs`) the admission verdict is awaited only until it arrives: once the connection is admitted the loop awaits `conn.accept()` with nothing else to wake it, so when the tunnel itself ends (eviction, revocation, a yamux close) the driver keeps polling the h2 connection until the peer closes the TCP. The known fix is to signal the driver again when the tunnel's own future returns.

In `bridge_ws` (`gateway/crates/devserver-proxy/src/proxy.rs`) the setup select closes the client socket for three cases through `close_unbridged`: cancellation as 1008 "session revoked", expiry as 1008 "session expired", and the setup deadline as 1011 "upstream timed out". The setup future's own failure is not one of them: a substream open that fails, or an upstream that answers the handshake with 403 or 404, propagates with `?` and ends the client socket with no Close frame at all, so the browser sees 1006 and cannot tell a refusal from a network drop. The client socket is also not polled during setup, so a client that leaves is noticed only when setup ends or the idle window elapses. The proxy's API tests assert the "upstream timed out" frame; a search of that test file for the revoked and expired reasons finds no assertion on either.

## Desired contract

A tunnel that has ended releases its connection instead of holding it for the peer's lifetime, and every way a bridge setup can fail closes the client socket with a Close frame whose code and reason name the case.

## Boundaries

`crates/chan-tunnel-server/src/tunnel.rs` (`drive_tunnel_conn`, `handle_tunnel_conn` and the tunnel future it drives), `gateway/crates/devserver-proxy/src/proxy.rs` (`bridge_ws`, `close_unbridged`) and `gateway/crates/devserver-proxy/tests/api.rs`.

## Acceptance

1. A test ends an admitted tunnel while its peer holds the TCP open and shows the driver returning rather than polling on.
2. A test makes the upstream handshake fail and asserts the client receives a Close frame with a code that is distinguishable from a drop; it is red against today's code.
3. Tests drive the cancellation and the expiry arms during setup and assert the 1008 frames reach the client.
4. The existing "upstream timed out" assertion is unchanged.
