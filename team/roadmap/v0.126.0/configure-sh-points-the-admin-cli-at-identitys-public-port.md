# configure.sh points the admin CLI at identity's public port

Status: raised on 2026-11-08 while writing the chan.app gateway tutorial; accepted by the owner for v0.126.0; built on `fix/configure-admin-identity-url` as `3be3ea821`, merged into the integration branch, awaiting the release.

## What is there now

`packaging/gateway/scripts/configure.sh:330-338` writes `/etc/chan-gateway/admin.env` with the profile and workspace admin URLs and the three admin tokens, but no `CHAN_ADMIN_IDENTITY_URL`. `chan-gateway-admin` then falls back to `http://127.0.0.1:7000` (`gateway/crates/admin/src/main.rs:51` and `:725`), identity's public listener. Every `/admin/v1/...` route is on identity's internal router (`gateway/crates/identity/src/http.rs`, `routers`), which configure.sh binds at `127.0.0.1:7004` (`configure.sh:252`), and the public router answers `/internal` paths with not-found. An operator who loads admin.env gets not-found from every identity command: `user create`, `flag grant`, tokens, sessions and fleet.

The docs know the gap: `gateway/README.md:162` exports the variable by hand, and `gateway/crates/admin/README.md:40` says a packaged deployment points it at `7004`. The manual's Host a gateway page (`web/packages/marketing/src/pages/manual/gateway.html`) works around it with an `export` after loading the file.

## Desired contract

1. configure.sh writes `CHAN_ADMIN_IDENTITY_URL=http://127.0.0.1:7004` into admin.env, beside the other admin URLs.
2. Loading admin.env alone is enough for every `chan-gateway-admin` command on a host configure.sh set up.

## Boundaries

- configure.sh's admin.env block, the gateway README's admin section and the manual page's workaround line; the admin CLI's built-in default stays unless the reading below shows a layout where it serves.

## Acceptance

1. In an sdme gateway guest set up by configure.sh: `set -a; . /etc/chan-gateway/admin.env; set +a; chan-gateway-admin user list` answers at the fix and not at the base.
2. The manual page's `export CHAN_ADMIN_IDENTITY_URL` line removed, and `gateway/README.md:162` no longer needed for a packaged host.
3. `make shell-check` green; the packaging isolation test green.
