# A WireGuard handshake that expires logs at ERROR

Status: raised at the v0.124.0 close from the Windows desktop WireGuard run, by the owner's word that its three findings become v0.125.0 rows; not started.

## What was seen

A tunnel whose peer never answers (a wrong key, a peer that is down) logs `CONNECTION_EXPIRED(REKEY_ATTEMPT_TIME)` at ERROR when its handshake attempts expire, and a session that ends logs `CONNECTION_EXPIRED(REJECT_AFTER_TIME * 3)` the same way. Both lines come from the protocol core kept from boringtun (`crates/chan-wireguard/src/noise/timers.rs`), with no tunnel, endpoint or gateway named. An expiry is an expected state of a tunnel the driver recovers from (`ConnectionExpired` is the one core error the driver acts on), and the desktop's default filter (`warn,chan_desktop=info`) and the devserver's (warn) both show it as an error.

## Desired contract

1. The core reports an expiry to the driver and logs it at debug.
2. The driver logs a tunnel's loss of its session, or a handshake that has not completed, at warn, once per change, naming the endpoint and the age of the last handshake, and its recovery at warn, as the endpoint lookup's failure and recovery already are.
3. ERROR stays for failures chan cannot recover from (a socket that fails, a proxy task that panics).

## Acceptance

1. A tracing test over a tunnel whose peer is silent: no ERROR line, one warn line naming the endpoint, and one warn line when the peer comes back.
2. The kernel suite's wrong-key arms and the desktop suites' wrong-key arms read no ERROR line in the client's log.
