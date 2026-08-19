# Extensions are undiscoverable and have no authoring guide

Status: REGISTERED for v0.94.0. Implemented in-round on the integration branch.

## Problem

The extension mechanism ships complete (supervised subprocess, stdout handshake, capability-path reverse proxy, sandboxed iframe, two host grants), but its only documentation is the field-level reference section in `docs/config-reference.md`, and the root README links no file under `docs/` at all. A new user cannot discover that extensions exist without reading the config reference or the server source. An extension author has no end-to-end walkthrough, no statement of the packaging and install convention, and no pointer at the two published extensions (`chan-ext-doom`, `chan-ext-mobile-chat`), which independently converged on the same repo layout, declaration template, checksum-verified installer, and `cs`-as-host-API pattern that no chan document records.

## Direction

One guide, `docs/extensions.md`, linked from a new Guides section in the root README together with the previously orphaned config reference. It carries the design (why a separate local process behind a narrow web contract; the declaration, handshake, proxy, and sandbox), the capability vocabulary disambiguation, the host bridge message table with directions, the lifecycle, an authoring walkthrough anchored on the in-tree `echo-extension` fixture, the `chan-ext-*` packaging convention codified from the two published extensions, and the flat boundary statement (no marketplace, installer, remote fetch, lazy start, or `cs` opener). The config reference keeps the field-level contract; the guide links it rather than duplicating it.

## Acceptance

- `docs/extensions.md` exists, follows the writing rules (no em dashes, no hard wrap, present-tense snapshot), and states only code-verified facts: manifest and handshake bounds, URL validation, proxy and sandbox behavior, all eight bridge message types with verified directions, both grants, and the no-respawn lifecycle.
- The root README carries a Guides section linking `docs/extensions.md` and `docs/config-reference.md`.
- The reference extensions are linked and correctly characterized: doom is the worked example for `presentation` and the only extension exercising both grants; mobile-chat delegates every action on chan to `cs`.
- The guide passes the full gate as part of the round (web checks include the docs tree's link hygiene where covered; otherwise the gate's prose surface is the review).
