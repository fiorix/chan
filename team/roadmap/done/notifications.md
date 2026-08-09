# Terminal notifications

Status: ABANDONED 2026-08-09. Did not ship. Registered for v0.87.0 and deferred from v0.85.0 and v0.86.0 before that; never implemented on the release ancestry.

## Original contract

- `cs notify` sends a text notification from a local machine or devserver session to eligible Chan browser and desktop surfaces.

The implementation this item once described was never on any release branch. It existed only on an abandoned candidate chain and was deliberately excluded from the v0.85.0 recovery, so each re-registration started from the contract above rather than from working code.

## Why it was abandoned

Chan is not the right place to build this. Getting a notification out of a devserver session, through the gateway, and onto whatever surface the user is actually looking at is a delivery problem, and delivery is the whole cost: the transport is the easy part.

A design pass took the item as far as a full delivery model before the scope became clear. Reaching a user who is not currently attached needs durable per-library storage of notice bodies with its own retention and eviction policy, a per-surface cursor so a reconnecting device is caught up exactly once, and restart-safe sequencing so a devserver bounce cannot rewind those cursors. Reaching them across machines needs the owner-only authorization split carried onto a new feed. Reaching the operating system needs two separate escalation paths that must not double-deliver, plus coalescing rules so a chatty agent cannot storm the notification centre, plus a native notification dependency whose Linux D-Bus path and macOS bundle requirements each need their own verification.

That is a notification service. Mature ones already exist, they solve delivery far better than this would, and an agent in a chan terminal can call one directly. Building a worse one inside chan buys nothing that matters.

The launcher's existing notice ring (`web/packages/launcher/src/state/notices.svelte.ts`) stays as it is. It narrates gateway and devserver events raised by chan-desktop itself, which is a different and much smaller job than delivering arbitrary text to a user who may be somewhere else entirely.
