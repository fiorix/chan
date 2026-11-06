# A wrong WireGuard peer key reads as a generic gateway discovery error

Status: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the Linux and Windows wrong-key arms read green in the release's guests.

## What was seen

In the Windows 11 guest, a chan-desktop gateway row whose wg-quick file names the wrong peer public key: the tunnel sends handshake initiations the peer drops (the peer logs `Invalid MAC`), and the Gateways screen reports a gateway discovery failure after 5 s, the same text an unreachable or misconfigured gateway gives. Nothing on the screen points at the key. Read in the code at `58f090a66`: `discover_gateway` (`desktop/src-tauri/src/devserver.rs`) runs its GET through the loopback proxy on a reqwest client with a 5 s timeout (`HTTP_TIMEOUT_SECS`), and the proxy's CONNECT waits on a tunnel that never completes a handshake, so the request times out as "checking chan-gateway discovery: ..." while the tunnel's own state reads "connecting".

## Desired contract

1. When a gateway request fails through a WireGuard tunnel that has never completed a handshake, the gateway's error says so: no handshake with the peer at the endpoint after the time waited, and that the peer's public key in the file and the peer's own list of keys are the first things to check.
2. A tunnel that had a session and lost it says that instead (no handshake since a given age), distinct from a key that never worked.
3. No key value appears in the message or the log.

## Acceptance

1. Unit: the desktop's error for a discovery failure over a tunnel with no handshake, over one with a stale handshake, and over a live one (unchanged).
2. `scripts/e2e/desktop-wireguard-windows.sh` and `scripts/e2e/desktop-wireguard.sh`: the wrong-key arm reads the new text on the Gateways state.

## Built

The WireGuard tunnel status distinguishes a peer that never handshook, a live session and a session that was lost. On a discovery transport failure, the desktop reads that status and puts the matching reason on the gateway row, in the notice and in the start-up log. A pending first endpoint lookup remains `connecting`; a failed lookup keeps its own retry text. The message names the configured endpoint and file, without printing key values.

The Linux and Windows wrong-key arms read the gateway list's `last_error` and the start-up log, check that both name the missing handshake and file, and reject known key values in the desktop log. The Linux live-adopt tenant arm checks the discovery 404 in both the connect body and the gateway row. The Windows wrong-key arm selects the peer navigation's 504 document by URL, so another window's document cannot satisfy or hide it.

Commits `9122693fb`, `695aaf4fa` and `ec821ad72` on `fix/desktop-wireguard-no-handshake-error`, merged into the integration branch as `799e7e5c3`. The Linux `--wrong-key` run in the release's guest read the start-up line and the row's `last_error` naming the never-handshaken peer, the endpoint and the file, with no key value in the log; the Windows wrong-key arm read the same reason with the 502 within 3 s at the integration tip's installer.
