# One WireGuard ingress per proxy node

Status: accepted (2026-11-08). Replaces the v0.125.0 decision of one WireGuard ingress per gateway.

Each devserver-proxy node that offers WireGuard terminates it in its own kernel interface, with its own key and endpoint, and runs its own peer agent. That interface is the node's ingress, and its id is the node's proxy id. Every ingress answers on the same tunnel addresses and holds every enrolled peer, so a desktop enrolls one key once and gets one address set that every ingress accepts. identity configures the list of ingresses and serves it in discovery and in the redeem; profile keeps one peer per public key across the gateway. No ingress forwards another node's traffic.

## Context

v0.125.0 shipped WireGuard enrollment with one ingress per gateway. identity read one host id, endpoint and public key and an operator-written host map (`WIREGUARD_HOST_ID`, `WIREGUARD_ENDPOINT`, `WIREGUARD_PUBLIC_KEY`, `WIREGUARD_HOSTS`), discovery and the redeem described that one peer, profile keyed peers and their addresses by host, and the desktop ran one tunnel per gateway. The host map could name the proxy apex, the tunnel origin's host and `*.{proxy host}`, never one node's wildcard, so every node's tenants went to the one ingress, and more nodes or regions were the operator's concern behind it.

Without WireGuard, tenant traffic crosses no central machine. A tenant origin is `{owner}--{disc}.{proxy}.proxy.{domain}`, so a browser or desktop connects straight to the node that holds the devserver's tunnel, and identity, profile and devserver-control carry no tenant bytes. [ADR 0002](0002-control-plane-owns-proxy-fleet-state.md) rejected a central tenant reverse proxy because it would be the data-plane bottleneck that proxy scaling exists to remove. One ingress per gateway is that central machine again, for every enrolled desktop, as soon as a gateway has a second node:

- the ingress host forwards every other node's traffic, so it carries each byte in and out for all of them;
- every request takes one more round trip, and throughput falls with it: the desktop's in-process TCP stack buffers 256 KiB per direction, so a connection moves at most about that much per round trip;
- the ingress host is a single point of failure for every enrolled desktop, whichever node its devserver is on;
- the forwarding (an SNI router on the ingress host and a backbone between the nodes) is the operator's to build.

## Considered options

- **One ingress per gateway, with forwarding behind it** (the v0.125.0 shape) rejected for the four costs above.
- **A list of ingresses that still reads the v0.125.0 variables as a one-entry list, with `*.{proxy host}` kept as a hub mode** rejected: it keeps a second validation path and the forwarding shape alive. A value in one of the four variables stops identity from starting and names what to set instead, so a deployment that still sets them never comes up with enrollment silently off.
- **One ingress per proxy node (chosen).** WireGuard traffic takes the path tenant traffic already takes.

## Decision

- **Configuration.** identity reads `WIREGUARD_INGRESSES`, one `id=public_key@endpoint` entry per node in the operator's order, with `WIREGUARD_INGRESS_ADDRESSES`, the tunnel addresses every interface answers on, and `WIREGUARD_ALLOWED_IPS`. The id is the node's `DEVSERVER_PROXY_ID`. No host map is configured: identity derives one per ingress, the node's name `{id}.{proxy host}` and every name below it, which are the names it mints for that proxy id. A tenant name is therefore carried only by its own node's tunnel.
- **Wire.** Discovery and the redeem list every ingress with its endpoint, key and host map. The fields of the single-ingress shape stay beside the list, set to its first entry, because the desktop requires them: without `endpoint` and `public_key` its discovery decode fails and it cannot connect at all, and with them a desktop that reads no list enrolls against the first ingress as before.
- **Peers.** profile enrolls a key once, with one address set unique across the gateway; migration 18 drops the peer table's `host` column and its per-host unique constraints. Every agent reads the same active list through identity under one shared `WIREGUARD_AGENT_TOKEN`: the lists are equal, so a bearer per node would hide nothing. With enrollment configured, identity answers 404 to an agent whose host id is not in its list, and the agent keeps the peers it has. The answer guards no peer: the list is the same for every host, so relaying it to an unknown one cannot wipe or misplace a peer, as it could in v0.125.0, where profile answered an unknown host with an empty list and the agent removed every peer it managed. It flags that the agent's host id and identity's list disagree. With no enrollment configured, identity relays profile's list to any well-formed host id.

The gateway side is built. The desktop side, one tunnel per ingress with the row's one key and address set, following discovery's list without a new sign-in, is not.

## Consequences

- Through WireGuard a desktop reaches a node the way it does without it: a node's tunnel carries only that node's names, a node that is down takes only its own names with it, and a node added to the fleet adds ingress capacity.
- Every node holds every peer. An interface's peer list grows with the gateway's enrolled desktops, not with the node's own users, and every agent polls the whole list. Nothing restricts a peer to a node or a user to a set of nodes: a key is accepted by every ingress until its PAT is revoked or expires or its user is blocked, and then it leaves every node, each at its agent's next poll.
- The 404 freezes the agent it answers: an agent whose host id is not in identity's list keeps its peers, and a PAT denied meanwhile stays a kernel peer on that node until its host id is configured or its interface is taken down. A node taken out of the list therefore has its agent stopped and its interface taken down.
- A key has one address set gateway-wide, so one pool sizes the whole gateway and every interface answers on the same tunnel address. That address must stay outside the pool, and nothing checks it: identity holds the address and profile the pool. Migration 18 deletes the earlier enrollment wherever one key or one address was held on two hosts, and those desktops enroll again at their next sign-in.
- Adding a node is identity configuration plus work on the node: an entry in `WIREGUARD_INGRESSES` with an identity restart, and the node's interface and agent. profile does not change, and the new agent installs every enrolled peer at the first list identity serves it.
- A gateway that enrolls peers under v0.125.0, v0.126.0 or v0.127.0 does not upgrade in place. identity does not start until its four single-ingress variables are replaced, and no configuration expresses a hub any more: the proxy apex is in no derived host map. A profile from those releases names the dropped `host` column in every WireGuard statement, so profile is upgraded with the migration. For one release profile still takes a host in the enroll request, checks it as a label and echoes it in the answer without placing the peer by it, which is what an identity one release behind requires, and identity still sends one, which a profile one release behind requires.
- The desktop uses only the first ingress until its side is built. It reads the single-ingress fields, runs one tunnel, and reaches every other node outside the tunnel, on the public path. The order of `WIREGUARD_INGRESSES` therefore chooses the one node desktops reach through WireGuard, and every other node has to stay reachable without it.
