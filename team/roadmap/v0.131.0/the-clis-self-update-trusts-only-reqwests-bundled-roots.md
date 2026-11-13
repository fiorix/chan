# The CLI's self-update trusts only reqwest's bundled roots

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

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
- Relation to [the model download trusts only bundled roots](the-model-download-trusts-only-bundled-roots.md): both read the same `chan_tls::client_config()`, and chan-tls needs no change for either, but no single change serves both.
  - Here, the change is one reqwest 0.12 builder in a crate that already holds the shared config.
  - There, hf-hub 0.4.3 builds its own ureq agents inside chan-workspace and takes no configuration, so that client must be replaced first.
  - The two can land in one build, and this row does not wait for that one.
- Not here: the desktop's updater, which already takes chan-tls's config; the integrity model of the update (no signature beyond the metadata's SHA-256 over TLS).

## Acceptance

1. A test, red on the code without the change: the self-update's client, handed a recorded config (`chan_tls::testing::recording`), dials the loopback sink (`chan_tls::testing::Sink`). It reads back that it started TLS with that config and offered `http/1.1`, as `crates/chan/src/http_client.rs`'s test does for the metrics client.
2. In an sdme guest, with a throwaway CA in the system store and a TLS-inspecting proxy named by `HTTPS_PROXY` whose leaves that CA signs, `chan upgrade --check` from an install.sh install answers. With the CA removed, it fails naming the certificate. At the base, it fails with the CA installed (the red).
3. The same reading on the Windows VM (`dev/vm/windows.sh`), from the Windows CLI zip, with the CA in the machine's Root store. Then on the owner's Mac, from install.sh, with the CA in the System keychain.
