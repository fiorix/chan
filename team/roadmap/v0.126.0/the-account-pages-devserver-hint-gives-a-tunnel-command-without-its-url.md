# The account page's devserver hint gives a tunnel command without its URL

Status: raised on 2026-11-08 while writing the chan.app gateway tutorial; accepted by the owner for v0.126.0; not started.

## What is there now

The gateway account SPA tells a user how to publish a devserver with `chan devserver run --tunnel-token=<token>`: on the empty Devservers tab (`web/packages/profile/src/views/Devservers.svelte:259` and `:272`) and on an offline row (`:287`). The Tokens tab says tokens authenticate `chan devserver run --tunnel-token` (`web/packages/profile/src/views/Tokens.svelte:159`). As written the command fails: tunnel mode requires `--tunnel-url` or `CHAN_TUNNEL_URL` (`crates/chan/src/devserver/foreground.rs:91`), and chan has no default URL (`crates/chan/src/cli.rs:1590`). It also puts the token on the command line, where `ps` shows it, while the flag's own help says to prefer `CHAN_TUNNEL_TOKEN` (`crates/chan/src/cli.rs:419-420`).

## Desired contract

1. Every hint shows a command that works as pasted: the token in `CHAN_TUNNEL_TOKEN`, and `--tunnel-url` set to this gateway's tunnel endpoint, read from what identity already publishes (discovery's `tunnel_url`) rather than a constant.
2. The hints name `chan devserver start` for a service and `chan devserver run` for the foreground, as `chan devserver --help` does.

## Boundaries

- The profile SPA's Devservers and Tokens views, and the read of the tunnel URL they need; no change to the CLI's flags.

## Acceptance

1. A test of each hint: the command carries `--tunnel-url` with the deployment's URL and no `--tunnel-token=`.
2. The command copied from the page of a local gateway (the sdme guests) connects a devserver.
3. The profile package's checks and `make web-check` green.
