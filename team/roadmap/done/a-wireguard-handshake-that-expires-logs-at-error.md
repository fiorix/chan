# A WireGuard handshake that expires logs at ERROR

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the kernel, Linux desktop and Windows desktop suites' expiry arms read green in the release's guests.

## What was seen

A tunnel whose peer never answers (a wrong key, a peer that is down) logs `CONNECTION_EXPIRED(REKEY_ATTEMPT_TIME)` at ERROR when its handshake attempts expire, and a session that ends logs `CONNECTION_EXPIRED(REJECT_AFTER_TIME * 3)` the same way. Both lines come from the protocol core kept from boringtun (`crates/chan-wireguard/src/noise/timers.rs`), with no tunnel, endpoint or gateway named. An expiry is an expected state of a tunnel the driver recovers from (`ConnectionExpired` is the one core error the driver acts on), and the desktop's default filter (`warn,chan_desktop=info`) and the devserver's (warn) both show it as an error.

## Desired contract

1. The core reports an expiry to the driver and logs it at debug.
2. The driver logs a tunnel's loss of its session, or a handshake that has not completed, at warn, once per change, naming the endpoint and the age of the last handshake, and its recovery at warn, as the endpoint lookup's failure and recovery already are.
3. ERROR stays for failures chan cannot recover from (a socket that fails, a proxy task that panics).

## Acceptance

1. A tracing test over a tunnel whose peer is silent: no ERROR line, one warn line naming the endpoint, and one warn line when the peer comes back.
2. The kernel suite's wrong-key arms and the desktop suites' wrong-key arms read no ERROR line in the client's log.

## Built

Three implementation commits: `13dcb72df` (the core's debug levels and the driver's retained handshake state and session notices), `f1b78b610` (the kernel suites' expiry controls at the production warn filter), and `test(desktop): assert wrong-key tunnel expiry on both platforms` (the desktop suites' expiry controls and the Linux `--wrong-key` mode).

Verification: 92 chan-wireguard tests, three chan-server WireGuard tests and 14 desktop WireGuard tests pass; six committed mutations make the corresponding session-notice tests fail. The four suites' committed assertion code rejects constructed logs with ERROR-level events or no session warning, and accepts the warning control with no ERROR. The desktop controls also reject missing tunnel starts and insufficient initiations; the Linux arm rejects a peer whose latest status has a handshake. The scoped Rust gate and the per-commit shell, workflow, Bash syntax, e2e syntax, formatting and Nix lock-digest checks pass.

Open: the live kernel suite and its reverted-error control, the Linux desktop plain and wrong-key runs, the Windows kernel suite, and the Windows desktop suite require guest execution. Constructed logs do not establish those runtime results.
