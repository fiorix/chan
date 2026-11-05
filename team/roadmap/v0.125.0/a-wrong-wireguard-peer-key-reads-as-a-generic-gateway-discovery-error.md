# A wrong WireGuard peer key reads as a generic gateway discovery error

Status: raised at the v0.124.0 close from the Windows desktop WireGuard run, by the owner's word that its three findings become v0.125.0 rows; not started.

## What was seen

In the Windows 11 guest, a chan-desktop gateway row whose wg-quick file names the wrong peer public key: the tunnel sends handshake initiations the peer drops (the peer logs `Invalid MAC`), and the Gateways screen reports a gateway discovery failure after 5 s, the same text an unreachable or misconfigured gateway gives. Nothing on the screen points at the key. Read in the code at `58f090a66`: `discover_gateway` (`desktop/src-tauri/src/devserver.rs`) runs its GET through the loopback proxy on a reqwest client with a 5 s timeout (`HTTP_TIMEOUT_SECS`), and the proxy's CONNECT waits on a tunnel that never completes a handshake, so the request times out as "checking chan-gateway discovery: ..." while the tunnel's own state reads "connecting".

## Desired contract

1. When a gateway request fails through a WireGuard tunnel that has never completed a handshake, the gateway's error says so: no handshake with the peer at the endpoint after the time waited, and that the peer's public key in the file and the peer's own list of keys are the first things to check.
2. A tunnel that had a session and lost it says that instead (no handshake since a given age), distinct from a key that never worked.
3. No key value appears in the message or the log.

## Acceptance

1. Unit: the desktop's error for a discovery failure over a tunnel with no handshake, over one with a stale handshake, and over a live one (unchanged).
2. `scripts/e2e/desktop-wireguard-windows.sh` and `scripts/e2e/desktop-wireguard.sh`: the wrong-key arm reads the new text on the Gateways state.
