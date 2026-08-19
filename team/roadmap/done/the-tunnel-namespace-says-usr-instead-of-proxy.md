# The tunnel namespace says usr instead of proxy

Status: SHIPPED in [v0.94.0](../../release/release-v0.94.0.md). 71 files renamed across docs, comments, fixtures, and the shipped deployment values; the gate caught three mixed-case fixtures the lowercase sweep missed and rustfmt reflows from the longer name, and the case-insensitive residual grep is clean. The live cutover (chan-prod-setup nginx, DNS, certificates) is the operator's own rollout together with this release.

## Problem

The gateway's public data-plane hostnames ride the `usr.{domain}` namespace: the tunnel ingress apex (`usr.{domain}/v1/tunnel`), the per-node apex (`{proxy}.usr.{domain}`, e.g. `uk.usr.chan.app`), and the tenant wildcard (`{owner}--{disc}.{proxy}.usr.{domain}`). The label `usr` describes nothing about what these hosts do; they are the proxy plane, and the operator wants them named that way: `uk.proxy.chan.app`. The scheme is configuration-driven in code (`devserver-proxy` takes `apex_host`, `wildcard_suffix`, and `proxy_base_url`; identity mints tenant origins from controller-reported nodes; the CLI takes `--tunnel-url` with no compiled-in endpoint), so `usr` lives in documentation, doc comments, test fixtures, and the shipped deployment configuration rather than in runtime logic.

## Direction

Rename the namespace to `proxy.{domain}` everywhere the repository speaks it: the design documents and crate doc comments (root `design.md` and README, `gateway/README.md`, `.agents/principles.md` and `.agents/gateway.md`, the tunnel crates, `chan-server`, `chan-library`, the workspace-app design doc and web-shared comments), the test fixtures that spell example hosts (`devserver-proxy` config tests, identity `desktop_entry.rs`, desktop `devserver.rs`, the CLI unit-writer tests, the web `usr.example` fixtures, `gateway-zone.sh`), and the shipped deployment values (`packaging/gateway/packaging/domain.env`, `packaging/kube/devserver-proxy.yaml`). No compatibility alias and no migration path: the maintainer deployment is the only known deployment, and its `chan-prod-setup` side (nginx, DNS, certificates) is handled separately by the operator and rolled out together with v0.94.0. Historical text (CHANGELOG entries, closed roadmap items, release reports) keeps the names it shipped with.

## Acceptance

- A whole-tree grep for `usr.` as a hostname component finds no live documentation, comment, fixture, or configuration reference; only history (`CHANGELOG.md`, `team/release/`, `team/roadmap/done/`) still speaks `usr.{domain}`.
- The gateway workspace and the full gate are green with the renamed fixtures.
- `packaging/gateway/packaging/domain.env` carries `https://proxy.chan.app` origins and `https://p1.proxy.chan.app` as the proxy base URL, and the kube probe host reads `proxy.localtest.me`.
