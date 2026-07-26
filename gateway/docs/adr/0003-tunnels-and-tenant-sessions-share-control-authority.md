# Tunnels and tenant sessions share control authority

Status: accepted (2026-07-26).

Control protocol v2 carries tunnel rows and redacted tenant browser-session rows in one proxy snapshot and one contiguous delta generation. A generation gap retracts both classes of authority and requires a full resync. Tenant-session rows use a random admin UUID that is independent of the opaque cookie id.

## Decision

Each proxy snapshots tunnel rows with `SnapshotChunk` and tenant-session rows with `BrowserSessionSnapshotChunk` between one `SnapshotStart` and `SnapshotEnd`. `TunnelUp`, `TunnelDown`, `BrowserSessionUp`, and `BrowserSessionDown` advance the same connection-local generation.

The controller publishes rows only from fleet-ready or retained disconnected authority. Disconnected tunnel and tenant-session rows share the bounded authority grace. Session revocation cannot report complete while any connected command is unconfirmed, controller authority is warming, or a retained disconnected proxy authority remains unreachable.

Identity signs `max_connected_devservers` into every admission lease. Tunnel snapshots, deltas, pending claims, and active rows retain that value. Admission and reconciliation use the minimum signed value represented for an owner, bounded again by `MAX_DEVSERVERS_PER_USER`.

## Security and bounds

The tenant-session wire row contains only admin session UUID, subject user UUID, owner user UUID, devserver id, creation time, and expiry. Cookie ids, tower session ids, entry replay ids, audiences, admission leases, assertions, peer addresses, and transport internals are excluded.

Each frame is bounded before decoding into authority state. Tunnel and tenant-session snapshots have explicit per-proxy row and byte limits, aggregate state has separate fleet limits, and session events consume the existing inbound frame-rate budget.

Operator, identity, and profile controller credentials remain distinct. Identity can invoke every session revocation variant. Profile retains exact and subject revocation only. Authorization checks the decoded legacy revocation variant in addition to the route.

## Consequences

Inventory, readiness, resync, and revocation use one authority model. No service performs query-time fan-out to proxy-local admin endpoints. Proxy nodes keep no database, profile, OAuth, policy-write, signing, or operator credential.

The protocol and package versions remain lockstep. There is no mixed-version bridge or compatibility mode.
