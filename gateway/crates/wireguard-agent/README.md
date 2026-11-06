# wireguard-agent

The proxy host's peer-sync agent. It keeps one kernel WireGuard interface's peers equal to the gateway's peer table for this host: every few seconds it reads the list identity serves, adds the peers that are missing and removes the ones the gateway no longer lists, through `wg` from wireguard-tools. It touches only the peers it added itself; a peer an operator configured on the same interface is never changed or removed. No listener, no database, no metrics endpoint: the journal is its surface.

## Role in the system

A desktop that enrolls a WireGuard key at sign-in gets a row in profile's peer table, keyed by the proxy host it reaches through (`host`) and holding its public key and tunnel addresses. The row is active while its PAT is live and its user is not blocked, so a revoke, an expiry or a block drops it from the list at once. A proxy host terminates the tunnel in the kernel; this agent is what turns the table into that kernel's peer list. It reads identity's internal listener, which relays profile's list, because a proxy node reaches only identity's internal listener and devserver-control's proxy-control listener in the account plane. Revocation reaches the interface at the agent's next poll; there is no push. The reconcile rule and its failure posture are in [`design.md`](design.md).

## Build

```bash
cargo build -p wireguard-agent
cargo test -p wireguard-agent
```

The tests need no privilege, no interface and no identity: the reconciler runs against a stand-in `wg` script and the poll against a wiremock identity.

## Install

The release ships the deb `chan-gateway-wireguard-agent`. It installs `/usr/bin/chan-gateway-wireguard-agent`, the system user and group `chan-gateway-wireguard-agent`, `/etc/chan-gateway/wireguard-agent.env` (mode 0640, root and the agent's group) and the unit `chan-gateway-wireguard-agent.service`, and depends on `wireguard-tools`. The unit keeps the managed set in `/var/lib/chan-gateway/wireguard-agent/` (`StateDirectory=`), holds `CAP_NET_ADMIN` as its one capability, and keeps the rest of the gateway units' sandbox. The install neither enables nor starts it: bring the interface up, fill the env file, then `systemctl enable --now chan-gateway-wireguard-agent`. There is no container image or Kubernetes manifest, since the agent changes the host's own kernel interface.

## Bring up the interface first

The agent never creates, configures or deletes the interface: it does not set its private key, listen port, fwmark or addresses, and installs no route or firewall rule. The operator brings it up once, for example:

```sh
umask 077
wg genkey > /etc/wireguard/chan-tunnel.key
ip link add wg0 type wireguard
wg set wg0 listen-port 51820 private-key /etc/wireguard/chan-tunnel.key
ip address add 10.7.0.1/24 dev wg0
ip address add fd00:7::1/64 dev wg0
ip link set wg0 up
```

The interface's public key (`wg pubkey < /etc/wireguard/chan-tunnel.key`), its endpoint and its addresses are what identity's enrollment settings (`WIREGUARD_PUBLIC_KEY`, `WIREGUARD_ENDPOINT`, `WIREGUARD_HOSTS`) hand to desktops; the pool profile assigns tunnel addresses from must fall inside the interface's network.

## Env vars

| Var | Required | Meaning |
|---|---|---|
| `IDENTITY_URL` | yes | identity's internal listener, e.g. `http://127.0.0.1:7004`; cleartext only to a loopback IP literal or with `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay` |
| `WIREGUARD_AGENT_TOKEN` | yes | the bearer identity checks on `/internal/v1/wireguard/peers`; equal to identity's `WIREGUARD_AGENT_TOKEN`, `openssl rand -hex 32` |
| `WIREGUARD_AGENT_HOST_ID` | yes | this host's `host` in the peer table, one lowercase DNS label (the grammar of `DEVSERVER_PROXY_ID`) |
| `WIREGUARD_INTERFACE` | yes | the kernel interface the agent changes peers on; not `all` or `interfaces`, which `wg show` reads as words |
| `WIREGUARD_AGENT_POLL_SECS` | no | seconds between polls, 1 to 60, default 5 |
| `WIREGUARD_WG_BIN` | no | the `wg` executable, default `wg` from `PATH` |
| `STATE_DIRECTORY` | yes | where `peers.json` is kept; systemd sets it from the unit's `StateDirectory=` |

A missing required value, a poll outside 1 to 60 or a malformed value refuses startup naming the variable.

## What the agent never touches

- A peer it did not add. The only `wg set IFACE peer KEY remove` is for a key in its managed set (`peers.json`), and the only `allowed-ips` change is for such a key. A desired key that is already on the interface without being managed is an operator's peer: the agent logs it once as a conflict and leaves it. Since it is never managed, a revoke does not remove it either; only the operator does.
- Any other interface, and the interface's own settings: `wg` is only ever run as `show IFACE dump`, `set IFACE peer KEY allowed-ips A,B` and `set IFACE peer KEY remove`.
- identity or profile: it only reads the list.

`CAP_NET_ADMIN`, which `wg` needs, is scoped by Linux to the network namespace, not to an interface: an agent holding it could change any interface in its namespace. What confines it to one interface is that it runs `wg` against the one name it is given; run it in a namespace of its own if that is not enough.

## Design rationale

See [`design.md`](design.md) for the reconcile rule, the managed set and why a failure keeps the last list.
