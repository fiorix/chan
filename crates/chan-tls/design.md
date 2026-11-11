# chan-tls design

chan-tls holds the TLS trust decision of chan's Rust clients that reach a gateway. It is one function, `client_config()`, which returns a rustls client config with no ALPN around one certificate verifier the process shares. The desktop's HTTP clients, its WebSocket feeds and `cs tunnel` sockets, its updater, the devserver's tunnel dial, the CLI's `chan metrics --url` and the gateway's WireGuard agent all take their config from it, so a gateway one of them trusts is trusted by all of them and a gateway one of them refuses is refused by all of them. Each caller sets the ALPN its transport speaks on its own copy and changes nothing else about verification.

## Where it sits

The crate depends on rustls (the ring provider, `std` and `tls12`) and tracing, and, by target, on rustls-platform-verifier (macOS and Windows) or on rustls-native-certs and webpki-roots (Linux and the other Unixes). It has no HTTP, WebSocket, proxy, timeout or tunnel dependency, so the WireGuard agent takes the trust decision without the tunnel's h2 and yamux stack, and reqwest 0.12, reqwest 0.13 and tokio-tungstenite each take the same rustls type. It is a member of the root workspace, and the gateway workspace takes it by path, as it takes the tunnel crates.

The callers and what each keeps of its own:

- chan-desktop's `wireguard::client_builder`, the builder of every reqwest 0.12 client of the desktop (sign-in, revoke, discovery, the roster, the devserver polls and probes, native transfers): ALPN `http/1.1`, with the process's WireGuard proxy decision, each client's timeouts and redirect policy unchanged.
- chan-desktop's window feeds (`window_watcher_wiring::ws_connect`), dialed directly or through the WireGuard proxy's CONNECT: a tokio-tungstenite `Connector::Rustls` with no ALPN, the route unchanged.
- chan-desktop's `cs tunnel` sockets to a gateway-attached devserver, through chan-revtunnel's `ClientConfig::connector`: the same connector. A directly attached devserver is dialed at `ws://` and runs no TLS.
- chan-desktop's updater, through `tauri-plugin-updater`'s `configure_client` and reqwest 0.13's `tls_backend_preconfigured` (`tls::updater_client`): ALPN `http/1.1`, for the check and the download, with the plugin's own timeout, proxy and headers.
- chan-tunnel-client's `build_tls_config`: ALPN `h2`, built once per `run` and reused across reconnects.
- wireguard-agent's `IdentityClient`: ALPN `http/1.1`, with its 5-second total and 2-second connect timeouts and no redirects.
- The CLI's `chan metrics --url` client (`crates/chan/src/http_client.rs`, `explicit_url`): ALPN `http/1.1`, keeping the user's proxy settings and refusing redirects, since the URL can name any server, a remote devserver behind a gateway included.

reqwest uses a preconfigured config as it is, ALPN included, so a reqwest caller sets the ALPN of the HTTP versions its build enables; neither reqwest here is built with HTTP/2, so those callers offer `http/1.1` alone, which is what reqwest's own config would offer. tokio-tungstenite's own connector offers no ALPN, and the WebSocket callers keep that.

## The decision per platform

On macOS and Windows the operating system verifies. The verifier is rustls-platform-verifier's: each server certificate is evaluated with the requested name by Security.framework on macOS and by the CryptoAPI chain engine and its SSL policy on Windows, so a CA installed in the keychain or the certificate store verifies, a root the system distrusts is distrusted, and revocation follows the system's policy. A public CA verifies as the system says it does. No bundled roots are added on these platforms: rustls-platform-verifier trusts an extra anchor whatever the system says of it, so a bundled floor would re-trust a root the system distrusts. `SSL_CERT_FILE` and `SSL_CERT_DIR` are not read there.

On Linux and the other Unixes WebPKI verifies, rustls's `WebPkiServerVerifier`, against one root store: the certificates rustls-native-certs reads from the system bundle (the distribution's bundle and certificate directories, or `SSL_CERT_FILE` and `SSL_CERT_DIR` when either is set, which then replace them), beside the Mozilla roots webpki-roots carries. Those bundled roots are the floor: a public CA verifies on a machine whose bundle is empty or missing, a container without ca-certificates for one. The floor has a cost, that a root removed from the system bundle is still trusted when webpki-roots carries it, and WebPKI here checks no revocation. The bundle is read once per process, when the verifier is first built, so a CA installed later is trusted from the next start.

## Failure and logging

`client_config()` fails only when the verifier cannot be built: the platform verifier refusing to start on macOS or Windows, or WebPKI refusing its root store elsewhere, which the floor keeps from being empty. A failure is not cached, so the next call tries again, and each caller surfaces it where it builds its client: a desktop client fails to build with the message, the tunnel's `run` returns it as a configuration error, and the agent refuses to start. A system bundle that reads with errors is not a failure, since the bundled roots still verify a public CA: one warning names how many errors there were and the first, and another counts the certificates that are not usable trust anchors. When the verifier is built, once per process, the number of anchors the system store gave is logged at info beside the bundled count, and a store that gave none, absent or empty, warns, since a private CA cannot verify then. A refused certificate reaches each caller's own error as `invalid peer certificate: UnknownIssuer` for a CA in neither store: the tunnel's dial failure, the desktop's discovery, roster and window-feed errors, and the agent's warn line.

The crate uses ring for every config it builds and installs ring as the process's default provider the first time, so a rustls config built from the default elsewhere in the process (tokio-tungstenite's own connector, the updater plugin's) negotiates with the same provider. The configs offer TLS 1.3 and TLS 1.2.

## What it never offers

There is no option to turn verification off, to accept a certificate by hand or to pin one, and no caller sets a verifier of its own. rustls calls the step that installs a custom verifier `dangerous`; the verifier installed there is the platform's or WebPKI's, and it verifies every chain it is shown. A CA in neither store fails with the certificate error.

## Clients outside it

- The CLI's self-update (`crates/chan/src/update.rs`) builds its reqwest client over reqwest's bundled roots, which the `chan` crate selects with `rustls-tls`: it reaches chan.app and GitHub, behind public CAs. The CLI's local devserver client speaks cleartext to loopback and runs no TLS.
- chan-server's extension proxy reaches loopback extension servers over reqwest's bundled roots.
- chan-workspace's model download (hf-hub over ureq, with its own webpki-roots), which the desktop links through the `embeddings` feature, keeps the bundled roots alone, so a CA installed in the system store (a TLS-inspecting proxy's, say) does not verify there. Routing it through this crate is a follow-up.
- The gateway's services (gateway-common, identity, devserver-proxy, admin) keep reqwest's bundled roots. Identity's OAuth exchange runs on oauth2 4.4, which owns a reqwest 0.11 client on rustls 0.21, a different rustls whose config this crate cannot build.
- The webviews use the operating system's own TLS stack and take no Rust config.

## Testing

The unit tests build the config on the host and check that it shares one verifier, carries no ALPN, and refuses a leaf under a throwaway CA in neither store. On Linux they also verify letsencrypt.org's real chain, captured on 2026-04-08, at its capture time through the bundled roots alone with an empty system store, check that the floor still refuses the wrong name and an expired leaf, verify the throwaway leaf by name and by address with its CA injected as the system store, and count an unusable store certificate without trusting it; an integration test builds the config with `SSL_CERT_FILE` naming an empty file. The throwaway CA's key and its leaf's were discarded when they were made.

The `test-support` feature is for the tests of the callers: `testing::recording` gives a copy of a config whose session store records the server name of every handshake started with it, and `testing::Sink` is a loopback listener that reads each ClientHello and records the ALPN it offers. A caller's test hands its client a recorded config, dials the sink, and reads back that the client started TLS with that config and offered its ALPN.

From a Linux host the macOS and Windows arms are type-checked and linted for those targets only; native verification on those systems is read on them.
