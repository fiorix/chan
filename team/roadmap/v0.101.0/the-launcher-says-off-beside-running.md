# The launcher says Off beside a running status

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's residuals, recorded by the v0.100.0 item `a-timed-out-mount-closes-a-tenant-it-did-not-open` as a vocabulary question for the whole surface. A source reading against `main` at `6237c2677`.

## What was seen

The launcher labels a row from `ws.on` after the lock and degraded checks: a row that is not desired on reads "Off" (`web/packages/launcher/src/components/Library.svelte:278-286`), even when its status pill reads running, which is what a tenant someone else mounted looks like after a timed-out attempt of this devserver's own.

## What to do

Decide with the owner what the row's word means (desired state or observed state) and name the other one differently, then apply it to every launcher surface that shows both.
