# The gateway setup defaults name the maintainer's deployment

Status: shipped in [v0.126.0](../../release/release-v0.126.0.md).

Record before the release: raised on 2026-11-08 while writing the chan.app gateway tutorial; accepted by the owner for v0.126.0; built on `fix/gateway-setup-defaults` as `1c093349e`, merged into the integration branch, awaiting the release.

## What is there now

1. configure.sh's origin prompts default to `https://gw.chan.app` and `https://proxy.chan.app` (`packaging/gateway/scripts/configure.sh:57-60`), the maintainer's own deployment. An operator who accepts the defaults configures a gateway for a domain they do not own.
2. The docs disagree on where devservers dial in. The tunnel ingress prompt defaults to the proxy namespace origin (`configure.sh:61-62`), as do the template `packaging/gateway/packaging/domain.env`, `gateway/docs/dev-setup.md:96` and `gateway/crates/devserver-proxy/README.md:39`. The chan.app gateway page (`web/packages/marketing/src/pages/gateway.html`) lists the node apex, `p1.proxy.example.com`, as the "Proxy node and outbound tunnel ingress", and the manual's Host a gateway page answers the prompt with it. The two shapes need different DNS records and edge routes, and the prompt does not say which one an answer implies. Whatever is chosen becomes discovery's `tunnel_url` and the proxy's apex host.
3. `packaging/sdme/chan-devserver-provision.sh:29-30` documents `--tunnel-url` as defaulting to "chan's built-in https://proxy.chan.app/v1/tunnel". chan has no built-in tunnel URL (`crates/chan/src/cli.rs:1590`, `devserver_tunnel_url_has_no_domain_default`), so a unit the provisioner writes without one (`chan-devserver-provision.sh:232-250`) runs `chan devserver run` with a token and no URL, which stops with "tunnel mode requires --tunnel-url or CHAN_TUNNEL_URL" (`crates/chan/src/devserver/foreground.rs:91`). The same comment names `gw.chan.app` for the token and `proxy.chan.app` for the published host.

## Desired contract

1. configure.sh offers no default that names a real deployment: each origin prompt requires an answer, or shows an `example.com` placeholder it refuses unchanged.
2. One documented answer for the tunnel ingress, used the same way by configure.sh's default, the domain.env template, the dev setup guide, the devserver-proxy README, the chan.app gateway page and the manual's Host a gateway page; the prompt says which DNS name and edge route the answer needs.
3. The sdme provisioner refuses to write a unit without a tunnel URL, and its comment claims no built-in default.

## Boundaries

- configure.sh's prompts, the domain.env template, the docs named above and the provisioner script; no change to how the services parse their configuration.
- Namespace origin or node apex for the tunnel ingress is an owner decision and this item's design step.

## Acceptance

1. In an sdme guest, configure.sh with every origin prompt left empty refuses at the first one; with `example.com` answers it writes the domain.env the docs describe.
2. `rg --text 'chan\.app' packaging/gateway packaging/sdme gateway/docs` finds the maintainer's domain only where a file names that deployment as such.
3. The provisioner run non-interactively without a tunnel URL exits non-zero naming `--tunnel-url`.
4. `make shell-check` and the marketing package's `npm run check` green.
