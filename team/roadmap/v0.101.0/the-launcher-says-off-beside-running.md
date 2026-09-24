# The launcher says Off beside a running status

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's residuals, recorded by the v0.100.0 item `a-timed-out-mount-closes-a-tenant-it-did-not-open` as a vocabulary question for the whole surface. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended, which settles the vocabulary: the row's word is the desired state (`On` or `Off`), the status pill is the observed state, and a row whose two disagree says both (`Off, running`), on every launcher surface that shows both.

## What was seen

The launcher labels a row from `ws.on` after the lock and degraded checks: a row that is not desired on reads "Off" (`web/packages/launcher/src/components/Library.svelte:278-286`), even when its status pill reads running, which is what a tenant someone else mounted looks like after a timed-out attempt of this devserver's own.

## What to do

Decide with the owner what the row's word means (desired state or observed state) and name the other one differently, then apply it to every launcher surface that shows both.
