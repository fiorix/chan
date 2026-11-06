# The WireGuard endpoint rule's probes miss a late cutover and churn on a rotating name

Status: raised at the v0.124.0 close. Parts 1 and 2 are the third review's findings on the endpoint resolution change (`f14bee3e7..957e5ba97`), which the owner shipped as they are in v0.124.0 and carried here; part 3 is the open question the crate's design records. Not started.

## What is there now

The endpoint rule of v0.124.0 (`crates/chan-wireguard/design.md`, Endpoint resolution; `Driver::resolved` and `Driver::adopt` in `crates/chan-wireguard/src/tunnel.rs`): every handshake initiation asks for a lookup; an answer moves the endpoint only when no endpoint is known or the latest handshake is older than 135 s (`STALE_HANDSHAKE`); while a younger session lives, an answer that differs from the previous answer gets one handshake initiation (a probe, `Adoption::Probe`) and the endpoint moves only when the peer answers from the new address, through roaming; an answer equal to the previous answer, or to the endpoint in use, sends nothing.

1. **A changed answer is probed once.** `resolved()` sets `last_answer` to every answer it adopts or probes, whether or not the peer answered there, and `adopt()` reads a later lookup with the same answer as unchanged. When a record moves before its new host is up, or the probe's one datagram is lost, nothing probes the new address again, and the client follows the cutover only once the session goes stale past 135 s. In the reviewer's probe that took 80 s, against 15 s when the record is first seen at the cutover.
2. **A probe is a fresh handshake.** `initiate()` formats the probe with `format_handshake_initiation(.., true)`, so it becomes the core's current handshake. With answers alternating between two addresses that are not the endpoint, every lookup probes, and the client re-handshakes with the live peer every 5 s. Data keeps flowing; the cost is the churn.
3. **A rotating name is followed anywhere once the session is stale.** A lookup takes the first address `getaddrinfo` returns. A name with several addresses whose order rotates gives each lookup a different answer, which the rule reads as a moved record: while a session lives each costs a probe (part 2), and once the latest handshake is older than 135 s the endpoint follows whichever address the lookup answered, which may be one the peer does not answer on. A name with one address is unaffected.

## Desired contract

Proposed by the third review for parts 1 and 2; part 3 needs a decision.

1. The rule compares an answer with the last answer that was adopted or that the peer answered from, not with the last one probed, so a still-different answer is probed again. It is re-probed once per new handshake attempt (a rekey, the 15 s dead-peer rule, the attempts after an expiry), not on every 5 s retry.
2. A probe is a copy of the bytes of the initiation in flight, sent to the probed address, so it does not replace the core's current handshake; a fresh initiation is formatted only when no handshake is in progress.
3. For a name with several addresses, a decision between: keep the address in use while it is among the answers; try the answered addresses in turn on a stale session and move to the one the peer answers from; or leave the rule as it is and document that an endpoint name should resolve to one address.

## Acceptance

1. Resolution tests over the resolver seam: a record moved before its new host is up is followed within one handshake attempt of the host coming up, not at 135 s; a lost probe datagram is followed by the next attempt's probe; answers alternating between two dead addresses cause no re-handshake with the live peer; and, for the option part 3 takes, a rotating answer set on a stale session ends on an address the peer answers from.
2. Each red under a mutation that restores the v0.124.0 behaviour, with the existing 28 resolution tests green.
3. The kernel suite's `dns` arm, and an arm that moves the record before the second peer port answers, green against the kernel peer.

## Built

Three implementation commits: `a0184cb1b` (the endpoint rule and full resolver answer sets), `40bcf942a` (empty network datagrams cannot move the peer endpoint), and `test(wireguard): prove late endpoint cutover before stale recovery` (the kernel suite's `dns-late` arm and its staged proof).

The driver copies the current initiation for at most one live probe per genuine attempt, defers late answers, keeps a live endpoint present in the answer set, and tries unvisited members across stale retries. A lost live probe remains eligible when the old path becomes stale, a record can move away and back while the session lives, and a refused bind does not prevent trying another address. Authenticated roaming and the `start_on` previous-answer rule remain intact. Empty UDP payloads are dropped before the protocol core's internal queue-drain sentinel.

Verification: 105 chan-wireguard tests, three chan-server WireGuard tests and 14 desktop WireGuard tests pass. Six endpoint-rule mutations and removal of the empty-datagram guard produce their named regression failures with controls green, and the no-op controls pass. The Rust scoped gates pass. Constructed fixtures execute the committed DNS helper and shell verdict logic: both DNS modes accept the positive control and reject missing or wrong bodies; the late-cutover mode rejects a new path that stays dark, missing probe/rekey/confirmation/next-attempt controls, and stale-only recovery. Shell, workflow, e2e syntax, formatting and Nix hash checks pass.

Open: the ordinary DNS and late-cutover arms require live kernel-peer execution in a guest, including a dark-forward negative control. Constructed fixtures establish the harness decisions, not those runtime results.
