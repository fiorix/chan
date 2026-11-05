# The Add Gateway form enrolls a WireGuard key with the gateway at sign-in

Status: accepted for v0.125.0 at the v0.124.0 close, by the owner's decision of 2026-11-05; two open questions below; not started.

Asked by the owner on 2026-11-05 while v0.124.0 was integrated ("on chan-desktop, i will want the possibility to create a key pair for each gateway; so it'll be on the Computers window, on the actual Gateways surface, then in the Add Gateway form; in there we should be able to generate a pubkey so that once we auth with oauth, we can provide this public key to the gw.{domain} site and so that they can somehow use that to configure wireguard on the proxy servers"). Decided the same day: identity stays public, the proxy hosts terminate kernel WireGuard with a peer-sync agent, the key rides the desktop authorize flow. It supersedes a row that would only show the desktop's public key in the launcher.

## What is there now

chan-desktop reaches a gateway through WireGuard only from a wg-quick file the operator writes by hand and names in the Gateways form's WireGuard file field, one optional file per gateway row and one tunnel per enabled row that has one (`desktop/src-tauri/src/wireguard.rs`, `crates/chan-wireguard/src/config.rs`; shipped in v0.124.0 as [chan-reaches-a-gateway-behind-wireguard-only-through-a-vpn-client-on-the-host](../done/chan-reaches-a-gateway-behind-wireguard-only-through-a-vpn-client-on-the-host.md)). The operator generates the client's key pair with `wg genkey` and `wg pubkey`, fills in the server's public key, endpoint and AllowedIPs, assigns the client a tunnel address, and adds a `[Peer]` stanza for the client's public key to the server's kernel WireGuard configuration. The desktop never shows its own public key (the devserver logs its own at tunnel start, `crates/chan-server/src/devserver.rs`), and the gateway knows nothing about WireGuard: the peer is whatever the operator runs in front of the gateway hosts.

The desktop already signs in to a gateway without copying secrets: the `/desktop/authorize` flow is an RFC 8252 loopback client with PKCE that ends in a PAT redeemed at `/desktop/authorize/redeem` (`gateway/crates/identity/design.md`, the desktop authorize section). Sign-in runs in the system browser, which reaches identity over the host's own network, not through the desktop's tunnel.

## Desired contract

1. The Add Gateway form (Computers window, Gateways surface) offers to generate a WireGuard key pair for that gateway. The desktop generates an X25519 key pair with chan-wireguard's key type, keeps the private key in an owner-only file under the desktop's own state for that gateway row, and shows the public key with a copy action. The private key never leaves that file and never reaches a page, a log or the gateway.
2. Sign-in carries the public key: the desktop's `/desktop/authorize` request includes it, the consent page on `gw.{domain}` shows it as the key this desktop will use, and Allow mints the PAT and enrolls the peer together. The redemption response returns the peer's parameters: the gateway's WireGuard public key, the endpoint, the client's assigned tunnel addresses and the AllowedIPs. A request without a key behaves exactly as today.
3. The desktop writes a complete wg-quick file from the generated private key and the returned parameters (owner-only, the subset `config::read_file` reads) and names it in the gateway row, so the existing fabric uses it unchanged.
4. Identity stays publicly reachable without WireGuard, so sign-in and enrollment never need the tunnel; the proxy plane (`proxy.{domain}` and the tenant origins) is what an operator may put behind WireGuard.
5. The gateway records each peer in the profile service (the owning user, the PAT it was minted with, the public key, the assigned addresses, timestamps). Addresses come from an operator-configured pool, one IPv4 /32 (and an IPv6 /128 when the pool has one) per peer, never reused while assigned.
6. Each proxy host runs kernel WireGuard and a small gateway agent that keeps the interface's peer list equal to the profile service's peer table for that host: it adds enrolled peers and removes revoked ones, through netlink or `wg set`, and never touches peers it did not add. The gateway workspace does not depend on chan-wireguard.
7. Revoking the PAT (by the user, the operator or expiry) removes the peer from every proxy host. A new key is a new enrollment: generate again and sign in again; the old peer goes with its PAT.

## Open questions

Raised by the round's lead at the v0.124.0 close; the owner has not decided either.

1. **Should the gateway's discovery document say whether it takes WireGuard?** The desktop reads `/.well-known/chan-gateway` (served by identity) before it signs in, and the document carries the identity, authorize, entry and proxy origins, nothing about WireGuard (`GatewayDiscovery` in `desktop/src-tauri/src/devserver.rs`). A `wireguard` entry there would let the Add Gateway form offer key generation only for a gateway that enrolls peers, instead of offering it everywhere and failing at sign-in on a gateway that does not. What the entry holds (a flag, or the gateway's public key and endpoint) and whether an older desktop must ignore it are part of the question.
2. **Should enrollment return the gateway's host names with their tunnel addresses?** There is no DNS inside the tunnel. The desktop's proxy resolves every request's host on the host's own resolver and carries it through a tunnel only when an answer falls inside that tunnel's AllowedIPs, so today a gateway origin goes through the tunnel only when the client's ordinary resolver already answers a tunnel address for it (split-horizon DNS, a hosts entry). A per-gateway map of host names (`proxy.{domain}`, the tenant origins' suffix) to tunnel addresses, returned at enrollment and kept in the gateway row, would let the proxy route those names without the client's resolver, which is a routing decision the proxy does not make today.

## Boundaries

- The single chan binary gains no gateway or kernel dependencies; key generation reuses chan-wireguard.
- Desktop only in the first cut. A devserver enrollment (`chan devserver run --tunnel-wireguard` takes a hand-written file) is a later item.
- No WireGuard inside identity's own serving path, no userspace WireGuard server in devserver-proxy, no change to the tunnel protocol.
- The agent is a new gateway component with its own packaging, privileges (`CAP_NET_ADMIN` on the WireGuard interface only) and service-to-service bearer, following `.agents/gateway.md`.

## Acceptance

- Unit: key generation, the owner-only file, the authorize request with and without a key, consent rendering of the key, redemption returning the parameters, address allocation and release, PAT revocation removing the peer.
- Integration in a guest: an identity and profile pair with Postgres, one proxy host with kernel WireGuard and the agent; a desktop enrolls from the Add Gateway form, the agent installs the peer, a desktop window reaches a tenant origin through the tunnel, and after a PAT revoke the agent removes the peer and the same request fails.
- The existing suites stay green, `scripts/e2e/desktop-wireguard.sh` and `scripts/e2e/desktop-wireguard-windows.sh` included, with a hand-written file still working.
