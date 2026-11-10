# wireguard-agent design

The agent makes one kernel WireGuard interface's peers follow the gateway's active peers, and does so without ever touching a peer it did not add. This document holds the rule, the state that makes the second half possible, and how it fails. Install, env and prerequisites are in [`README.md`](README.md).

## Where it sits

It runs on a proxy node beside devserver-proxy, one agent per interface, and a gateway has one such interface, its WireGuard ingress, on each node that offers one. The desired set comes from identity's internal listener, `GET /internal/v1/wireguard/peers?host={WIREGUARD_AGENT_HOST_ID}` behind `WIREGUARD_AGENT_TOKEN`; identity relays profile's active rows (a live PAT, an unexpired one, an unblocked user) with profile's `ETag`, the quoted hex SHA-256 of the body. The agent sends that value back byte for byte in `If-None-Match`, and a 304 means the list has not changed. It reads nothing else and writes nowhere in the gateway.

The rows are the gateway's, not the node's. A key is enrolled once, with one address set that every ingress accepts, so every agent is served the same peers and all of them present the same bearer. The host id selects no rows. It is the node's `DEVSERVER_PROXY_ID`, the id of the node's entry in identity's `WIREGUARD_INGRESSES`, and it does two things: identity serves the list only to an id in that list, and the body echoes the id asked with, which the agent checks against its own before it accepts the body.

## The loop

Every `WIREGUARD_AGENT_POLL_SECS` (default 5) the agent polls, then reconciles against the last list it holds:

- **200** replaces the desired set `{public_key -> allowed_ips}`. A body for another host, a malformed key or CIDR, or a key listed twice is refused as a whole and counts as a failure.
- **304** keeps it.
- **401** ends the process with status 1, naming the variable; the unit restarts it.
- **404** is what identity answers a host id that is not a configured ingress, and every id while it has no enrollment configured. The agent has no case for it: it is one of the answers below.
- **Anything else** (a refused connection, a timeout, a 404, a 5xx, a redirect, which is never followed) keeps the last list. It logs at warn when the failure starts and at debug while it repeats, and once at info when identity answers again.

Nothing is reconciled until the first list arrives: an unknown desired set must not read as an empty one, which would remove every managed peer on a restart while identity is down.

## The reconcile rule

Each pass reads the interface's peer keys with `wg show IFACE dump` (the first line, the interface's own keys and port, is skipped and never kept or logged) and compares the desired set, the managed set and that list:

- a managed key no longer desired is removed with `wg set IFACE peer KEY remove` and forgotten; if the interface already lacks it, it is only forgotten;
- a desired key on neither the interface nor the managed set is recorded as managed, then added with `wg set IFACE peer KEY allowed-ips A,B`;
- a managed key whose desired allowed IPs differ from the recorded ones is set to the desired list, then recorded;
- a managed key the operator removed is added back while it is desired;
- a desired key already on the interface but not managed is an operator's peer: logged once at warn as a conflict while it lasts, never changed.

The last rule has a consequence for revocation: a desired key the operator added by hand is never managed, so when the gateway stops listing it (a revoke, an expiry, a block) the agent leaves it on the interface, and only the operator removes it. Adding an enrolled desktop's key by hand takes that peer out of the gateway's revocation on that interface.

Allowed IPs are compared as recorded, canonical and sorted, not against what the interface reports, so an operator's hand edit of a managed peer's allowed IPs stands until the gateway's list changes, and an unchanged list costs one `wg show` per pass and no write.

## The managed set

`peers.json` under `STATE_DIRECTORY` holds the keys the agent added and the allowed IPs it gave them, with the interface name and a format version. It is written atomically (a sibling file, `fsync`, rename, a directory `fsync`) after every change and read once at start.

The write order is what keeps the guarantee across a failed `wg` call or a crash: a key is recorded before it is added and forgotten only after it is removed. The worst a crash can leave is a managed key the interface lacks, which the next pass adds back or forgets; it can never leave a peer the agent added outside the set, where it would look like an operator's and never be removed after a revoke.

The record is on disk before the set in memory changes: each change is written as a new copy of the set, which replaces the one in memory only once the file holds it. A failed write therefore leaves the two equal, the `wg set` that would follow it does not run, and the next pass makes the change again; the agent never acts on a record the file lacks, so a restart in between finds every peer it added.

An absent file manages nothing, so a first run adopts no existing peer. A file that does not parse, holds an invalid key or CIDR, carries an unknown version, or names another interface refuses startup: reading it as empty would strand the agent's peers on the interface, and anything else would adopt peers it never added.

## Privileges

`wg` needs `CAP_NET_ADMIN` to read and change peers, and the agent gives it to the `wg` it runs as an ambient capability. Linux scopes that capability to the network namespace, not to an interface: the confinement to one interface is the agent's own, since every `wg` it runs names `WIREGUARD_INTERFACE` and nothing else, never the interface's private key, listen port or fwmark. Every other capability stays off. An operator who wants the kernel to enforce the boundary runs the agent in a network namespace holding only that interface.

## Failure posture

- identity unreachable or failing: the last list stays in force, revocations included or not; a revoked peer is removed at the first poll after identity answers again.
- A host id identity does not list (a mistyped `WIREGUARD_AGENT_HOST_ID`, a node missing from identity's `WIREGUARD_INGRESSES`, enrollment not configured): identity answers 404 on every poll and the agent keeps polling. A running agent keeps its last list in force, and one started that way never reconciles, so the interface keeps the peers it has in both cases. That is the safe half of the trade: an id identity does not know says nothing about which peers are desired, so nothing is removed on its account. The other half is that no revoke reaches the interface: a PAT revoked, expired or blocked meanwhile stays a kernel peer until identity serves the agent again or the interface is taken down, and a running agent adds it back when it is removed by hand, because its last list still names it. A node taken out of identity's list therefore has its agent stopped and its interface taken down, and identity keeps enrollment configured for as long as any agent runs. On the node, the agent's warn line is the signal.
- `wg` failing (the interface missing, `wg` absent): the pass stops at the failing call, logs at warn once and at debug while it repeats, and the next poll retries; the managed set is already consistent.
- SIGTERM or Ctrl-C: the pass in flight ends after its current `wg` call and its state write, and the process exits 0.

Log lines name the interface, the key (a public key) and the action; the bearer never appears in a log line, and `wg`'s stdout, which carries the interface's private key, is never logged.

## Invariants

- The only `wg` argvs are `show IFACE dump`, `set IFACE peer KEY allowed-ips A,B` and `set IFACE peer KEY remove`, with the one configured interface.
- A key is removed or changed only if the managed set holds it.
- A key is in `peers.json` whenever the agent may have added it to the interface, and the set in memory never holds a change the file lacks.
- No reconcile runs before identity has served a list.
