# wireguard-agent

A proxy node's peer-sync agent. It keeps one kernel WireGuard interface's peers equal to the gateway's active peers: every few seconds it reads the list identity serves, adds the peers that are missing and removes the ones the gateway no longer lists, through `wg` from wireguard-tools. It touches only the peers it added itself; a peer an operator configured on the same interface is never changed or removed. No listener, no database, no metrics endpoint: the journal is its surface.

## Role in the system

A gateway offers one WireGuard ingress per proxy node: each node that terminates WireGuard does so in a kernel interface of its own, under its own key, and runs one agent for it. A desktop that enrolls a WireGuard key at sign-in gets one row in profile's peer table, holding its public key and its tunnel addresses, and that one peer is valid on every ingress. Every node's agent therefore reads the same list and installs the same peers; the list is the gateway's, not the node's. A row is active while its PAT is live and its user is not blocked, so a revoke, an expiry or a block drops it from the list at once, for every node. The agent is what turns that list into its node's kernel peer list. It reads identity's internal listener, which relays profile's list, because a proxy node reaches only identity's internal listener and devserver-control's proxy-control listener in the account plane. Revocation reaches an interface at its agent's next poll; there is no push. The reconcile rule and its failure posture are in [`design.md`](design.md).

## Build

```bash
cargo build -p wireguard-agent
cargo test -p wireguard-agent
```

The tests need no privilege, no interface and no identity: the reconciler runs against a stand-in `wg` script and the poll against a wiremock identity.

## Install

The release ships the deb `chan-gateway-wireguard-agent`. It installs `/usr/bin/chan-gateway-wireguard-agent`, the system user and group `chan-gateway-wireguard-agent`, `/etc/chan-gateway/wireguard-agent.env` (mode 0640, root and the agent's group) and the unit `chan-gateway-wireguard-agent.service`, and depends on `wireguard-tools`. The unit keeps the managed set in `/var/lib/chan-gateway/wireguard-agent/` (`StateDirectory=`), holds `CAP_NET_ADMIN` as its one capability, and keeps the rest of the gateway units' sandbox. The install neither enables nor starts it: bring the interface up, fill the env file, then `systemctl enable --now chan-gateway-wireguard-agent`. There is no container image or Kubernetes manifest, since the agent changes the host's own kernel interface.

## Bring up the interface first

The agent never creates, configures or deletes the interface: it does not set its private key, listen port, fwmark or addresses, and installs no route or firewall rule. The operator brings it up once on each node, for example:

```sh
umask 077
wg genkey > /etc/wireguard/chan-tunnel.key
ip link add wg0 type wireguard
wg set wg0 listen-port 51820 private-key /etc/wireguard/chan-tunnel.key
ip address add 10.7.0.1/24 dev wg0
ip address add fd00:7::1/64 dev wg0
ip link set wg0 up
```

Each node generates a private key of its own, and every node gives its interface the same tunnel addresses. identity hands desktops what the operator lists for the node, one `id=public_key@endpoint` entry of its `WIREGUARD_INGRESSES`: the node's `DEVSERVER_PROXY_ID`, the interface's public key (`wg show wg0 public-key`) and the `host:port` at which desktops reach its listen port. The addresses are identity's `WIREGUARD_INGRESS_ADDRESSES`, the same value for every node. The pool profile assigns peers' addresses from must fall inside the interface's network and must not hand out the interface's own address: profile never allocates a pool's network address or its first host address, which is why `10.7.0.1` in a `10.7.0.0/24` pool is safe, and any other address is listed in profile's `WIREGUARD_POOL_RESERVED`. A desktop reaches the node's names at the tunnel address, so the node's TLS edge must answer there as it does on the node's public address. The grammar of identity's variables is in [`../identity/README.md`](../identity/README.md#wireguard-enrollment).

## Env vars

| Var                         | Required | Meaning                           |
|-----------------------------|----------|-----------------------------------|
| `IDENTITY_URL`              | yes      | identity's internal listener      |
| `WIREGUARD_AGENT_TOKEN`     | yes      | bearer for identity's peers route |
| `WIREGUARD_AGENT_HOST_ID`   | yes      | this node's ingress id            |
| `WIREGUARD_INTERFACE`       | yes      | the interface to change peers on  |
| `WIREGUARD_AGENT_POLL_SECS` | no       | seconds between polls; default 5  |
| `WIREGUARD_WG_BIN`          | no       | the `wg` executable               |
| `STATE_DIRECTORY`           | yes      | where `peers.json` is kept        |

- `IDENTITY_URL` is, for example, `http://127.0.0.1:7004`. Cleartext is accepted only to a loopback IP literal or with `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay`. An `https://` URL is verified with the trust decision the desktop and the devserver's tunnel share ([chan-tls](../../../crates/chan-tls/design.md)): the host's CA bundle beside the bundled Mozilla roots, so a listener behind a private CA verifies once that CA is in the host's store (`update-ca-certificates` on Debian). The bundle is read once at startup; restart the agent after adding a CA.
- `WIREGUARD_AGENT_TOKEN` is the bearer identity checks on `/internal/v1/wireguard/peers`, equal to identity's `WIREGUARD_AGENT_TOKEN` (`openssl rand -hex 32`). Every node's agent presents the same value: the lists are the same, so one bearer per node would protect nothing more.
- `WIREGUARD_AGENT_HOST_ID` is the node's `DEVSERVER_PROXY_ID`, one lowercase DNS label, which is the id of the node's entry in identity's `WIREGUARD_INGRESSES`. identity answers 404 to an id that is not in that list; [A host id identity does not list](#a-host-id-identity-does-not-list) says what the agent does then.
- `WIREGUARD_INTERFACE` is the kernel interface the agent changes peers on. It is not `all` or `interfaces`, which `wg show` reads as words.
- `WIREGUARD_AGENT_POLL_SECS` is a whole number from 1 to 60.
- `WIREGUARD_WG_BIN` defaults to `wg` from `PATH`.
- `STATE_DIRECTORY` is set by systemd from the unit's `StateDirectory=`.

A missing required value, a poll outside 1 to 60 or a malformed value refuses startup naming the variable.

On a host where the agent's package is installed beside the gateway's services, `packaging/gateway/scripts/configure.sh` writes this file: `IDENTITY_URL=http://127.0.0.1:7004`, the bearer it generates for identity, the node id it is given as the host id, and the interface name it asks for (`wg0` by default). It does not write `WIREGUARD_AGENT_POLL_SECS` or `WIREGUARD_WG_BIN`: a rerun over a file that sets either names it before the WireGuard questions, and the replaced file's backup keeps it. On any other node the file is filled by hand, with the bearer copied from identity's `identity.env`.

## A host id identity does not list

identity answers 404 to a host id that is not an id in its `WIREGUARD_INGRESSES`. The list is the same for every host, so serving it to an unknown one could not wipe or misplace a peer; the 404 flags that the agent's host id and identity's list disagree. An identity with no enrollment configured has no list to disagree with and relays profile's list to any well-formed host id. The agent handles a 404 as it handles every failed poll but a refused bearer: it logs `identity does not serve the peer list; keeping the last one` with `error=identity answered 404 Not Found`, once at warn and then at debug while it repeats, and keeps polling. It does not exit. identity logs its side at warn as well, naming the host id it refused, when the polls start and once every ten minutes while they last. What that leaves on the interface depends on whether identity ever served this process a list:

- an agent that was following a list keeps its last one in force: the peers it added stay, no newly enrolled peer is added and no revoked peer is removed;
- an agent started with such an id never reconciles, so the interface keeps the peers it has, those an earlier run added among them.

A mistyped id, or a node missing from identity's list, therefore never empties the interface. It also keeps revocations from this node: a PAT revoked, expired or blocked meanwhile stays a kernel peer here until the host id is configured on identity or the interface is taken down. So a node taken out of identity's list has its agent stopped and its interface taken down. The agent's warn line in the node's journal (`journalctl -u chan-gateway-wireguard-agent`) is the sign of it there, and identity's warn line, with `host=<id>`, is the sign of it on identity's host.

## What the agent never touches

- A peer it did not add. The only `wg set IFACE peer KEY remove` is for a key in its managed set (`peers.json`), and the only `allowed-ips` change is for such a key. A desired key that is already on the interface without being managed is an operator's peer: the agent logs it once as a conflict and leaves it. Since it is never managed, a revoke does not remove it either; only the operator does.
- Any other interface, and the interface's own settings: `wg` is only ever run as `show IFACE dump`, `set IFACE peer KEY allowed-ips A,B` and `set IFACE peer KEY remove`.
- identity or profile: it only reads the list.

`CAP_NET_ADMIN`, which `wg` needs, is scoped by Linux to the network namespace, not to an interface: an agent holding it could change any interface in its namespace. What confines it to one interface is that it runs `wg` against the one name it is given; run it in a namespace of its own if that is not enough.

## Design rationale

See [`design.md`](design.md) for the reconcile rule, the managed set and why a failure keeps the last list.
