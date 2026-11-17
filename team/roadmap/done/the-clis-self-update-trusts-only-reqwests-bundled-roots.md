# The CLI's self-update trusts only reqwest's bundled roots

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): every client the CLI's self-update builds, for the probe, the metadata, the archive and each redirect, verifies with `chan_tls::client_config()`, the platform verifier on macOS and Windows and the system store beside the bundled roots on Linux and the other Unixes, and refuses any hop that is not https, so `chan upgrade` works through a TLS-inspecting proxy whose CA is in the system store and names the certificate when it is refused (`v0131/updroots` at `4ce2a60ee`, merged as `7809a7966`). Read by loopback TLS, downgrade, redirect and ALPN tests with seven mutations, and in a guest through an inspecting proxy: refused at the base, trusted at the tip, and refused for its certificate with the CA removed. Not read in this release: the Windows VM reading, moved to v0.132.0 with the model download's under the owner's release-first ruling of 2026-11-16, and the macOS reading, which he postponed on 2026-11-14.

Record before the release: accepted for v0.131.0 by the owner on 2026-11-13; merged on 2026-11-16, its Windows reading carried to v0.132.0 and its macOS reading postponed.

Record: when the Rust TLS clients moved to the system's store in v0.128.0, this client was named as left on bundled roots ([the system CA row](../done/the-rust-tls-clients-ignore-the-systems-ca-store.md), "Built, 2026-11-11"; `crates/chan-tls/design.md`, "Clients outside it"). It was raised as a candidate while the v0.131.0 model-download row was being drafted on 2026-11-13 (`dev/v0130/status.md`). The integrator asked whether to add the drafters' candidates as small fixes, and the owner answered: "perhaps the cli's self-update can move to v0.131, no rush with this".

## What is there now

Read at `f6c175793`; nothing was run.

- The self-update is the standalone CLI's: install.sh, install.ps1, the Windows CLI zip, and the unstamped `.deb` and `.rpm` downloads. `decide_upgrade_route` (`crates/chan/src/desktop.rs`) sends the desktop personality and the NSIS install's `chan.exe` to the desktop's updater instead, and that updater already takes chan-tls's config. Distro-packaged builds refuse to self-update.
- One builder, `http_client` (`crates/chan/src/update.rs`), makes every client: `reqwest::Client::builder()` with timeouts and a user agent, and no TLS config of its own. It is built twice:
  - The probe that `chan serve` starts (`run_probe`, `crates/chan/src/serve.rs`, a 3 s connect and 5 s total limit) reads `https://chan.app/dl/cli/latest.json`.
  - `chan upgrade` (`run_upgrade_inner`, a 10 s connect and 15 min total limit) reads `latest.json` or `v<version>.json`, then streams the archive from the `https` URL the metadata names: GitHub Releases or another origin, with reqwest's default redirect policy.
- There is no separate checksum or signature fetch: the archive's SHA-256 comes from the metadata, read over the same client.
- The `chan` crate selects reqwest 0.12's `rustls-tls` (`crates/chan/Cargo.toml`, whose comment says the self-update trusts reqwest's bundled roots). That feature verifies against the bundled WebPKI roots alone. So on every platform, a CA in the system's store (a TLS-inspecting proxy's, say) is not trusted by the probe or by `chan upgrade`. In the same crate, `chan metrics --url` does trust it: `http_client::explicit_url` takes `chan_tls::client_config()`, sets ALPN `http/1.1` and hands the result to reqwest with `use_preconfigured_tls`.
- The client keeps the user's proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`). A source guard (`crates/chan/tests/http_client_guard.rs`) allows raw reqwest clients only in `http_client.rs` and `update.rs`.
- A failed probe is logged at debug and swallowed. By reading, a refused `chan upgrade` ends in anyhow's error chain, which carries reqwest's source down to rustls's reason.

## Desired contract

1. Every client the self-update builds, for the probe, the metadata, the archive and each redirect the archive takes, verifies with `chan_tls::client_config()`. That is the decision the desktop's updater and `chan metrics --url` already take: the platform verifier on macOS and Windows, and the system bundle beside the bundled floor on Linux and the other Unixes. No option disables verification.
2. Nothing else changes: the hosts and the https-only rule (`ensure_update_url`), the SHA-256 check, the proxy settings, the timeouts and the redirect policy. A public CA keeps verifying on a Linux machine with an empty store.
3. A `chan upgrade` refused for its certificate names that cause, and a refused probe stays silent as it is today.

## Boundaries

- `http_client` in `update.rs`, built like `http_client::explicit_url_builder`. The `chan` crate already depends on chan-tls, so no new dependency is needed. Its `rustls-tls` selection on reqwest may go once no client of the crate needs bundled roots. Also update the "Clients outside it" list in `crates/chan-tls/design.md`, and the self-upgrade section of `crates/chan/design.md`.
- Relation to [the model download trusts only bundled roots](../v0.132.0/the-model-download-trusts-only-bundled-roots.md): both read the same `chan_tls::client_config()`, and chan-tls needs no change for either, but no single change serves both.
  - Here, the change is one reqwest 0.12 builder in a crate that already holds the shared config.
  - There, hf-hub 0.4.3 builds its own ureq agents inside chan-workspace and takes no configuration, so that client must be replaced first.
  - The two can land in one build, and this row does not wait for that one.
- Not here: the desktop's updater, which already takes chan-tls's config; the integrity model of the update (no signature beyond the metadata's SHA-256 over TLS).

## Acceptance

1. A test, red on the code without the change: the self-update's client, handed a recorded config (`chan_tls::testing::recording`), dials the loopback sink (`chan_tls::testing::Sink`). It reads back that it started TLS with that config and offered `http/1.1`, as `crates/chan/src/http_client.rs`'s test does for the metrics client.
2. In an sdme guest, with a throwaway CA in the system store and a TLS-inspecting proxy named by `HTTPS_PROXY` whose leaves that CA signs, `chan upgrade --check` from an install.sh install answers. With the CA removed, it fails naming the certificate. At the base, it fails with the CA installed (the red).
3. The same reading on the Windows VM (`dev/vm/windows.sh`), from the Windows CLI zip, with the CA in the machine's Root store. Then on the owner's Mac, from install.sh, with the CA in the System keychain.

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, points 11 and 13.1) on 2026-11-14: "as you recommend" on the folds, and on the Mac line: "not doing it for this release, we can postpone".

- Folded in from v0.130.0's follow-ups, with a security side: an https to http redirect is followed today for the metadata and the archive (`update.rs`; reqwest 0.12 refuses it only under `https_only`). The metadata is unsigned, so a plain-http hop of its fetch would let a network attacker rewrite the version, the URL and the hash. The builder this row rewrites sets `https_only`, keeping the loopback test base. This amends contract 2's "the redirect policy" unchanged: every hop of every self-update client is https.
- From point 13.3: the TLS-inspecting proxy acceptance 2 needs is new work; v0.128.0's system CA recipe has a throwaway CA and no proxy.
- Acceptance 3's Mac line is postponed; the row closes on its guest and Windows VM lines and says in its closing section that the macOS reading was not made.

## Merged, 2026-11-16

The range `9d7b56c45..4ce2a60ee` (two commits: the update clients built over `chan_tls::client_config()` with HTTP/1.1 ALPN, `https_only` on every production hop with the debug fixtures' redirects confined to their loopback origin, the proxy settings and redirect bounds kept, and the background probe's client construction silent; then the trust diagnostics and the TLS fixtures' generation documented) was accepted by two Fable reviewers and a confirm read (`dev/v0131-team/reviews/review-updroots-1a.md`, `-1b.md`, `-2.md`) and merged into `v0131/int`.

Acceptance 1 is met by the loopback TLS, downgrade, redirect and ALPN tests, with seven guard mutations red. Acceptance 2 is met in a guest (job J188): at the base `chan upgrade --check` trusted only the bundled roots, at the tip it trusted the throwaway CA from the system store through the inspecting proxy, and with the CA removed it was refused for its certificate; the store was restored after. Acceptance 3 was not read in this release: its Windows reading (job J187b, with the model download's) needed about eighteen hours of the Windows test VM and moved to v0.132.0 under the owner's release-first ruling of 2026-11-16, and its macOS reading was postponed by the owner on 2026-11-14. Both stay owed to this row's contract in a later release.
