# The model download trusts only bundled roots

Status: implementation built; committed verification, native system-store readings and review pending.

Record: named as a follow-up when the Rust TLS clients moved to the system's store in v0.128.0 ([the system CA row](../done/the-rust-tls-clients-ignore-the-systems-ca-store.md), "Built, 2026-11-11"; `crates/chan-tls/design.md`, "Clients outside it"). It was then drafted as a row for the next release on the owner's word: in the `chan-dev` repository under `releases/v0128/team/reports/row-draft-the-model-download-trusts-only-bundled-roots.md`, and in `team/release/release-v0.128.0.md`, "Rows drafted for the next release". v0.129.0's record lists it as still without a row. On 2026-11-13 the integrator asked where that later group goes, and the owner placed it in v0.131.0: "yes v0.131".

## What is there now

Read at `342dbe791`; the download was not run.

- The semantic search model is fetched by `Embedder::open_once` (`crates/chan-workspace/src/index/embeddings.rs`) through hf-hub 0.4.3's blocking API (`hf_hub::api::sync::ApiBuilder`, features `ureq` and `rustls-tls`). Three callers fetch it: `chan workspace index download-model` (`crates/chan/src/index.rs`), the Settings download (`api_semantic_download`, `crates/chan-server/src/routes/index.rs`) and the preflight's download choice (`crates/chan-server/src/routes/preflight.rs`). The `embeddings` feature that brings it in is the default of the `chan` CLI and of chan-server, and the desktop turns it on, so the CLI, the devserver and the desktop all download this way.
- hf-hub builds its own ureq 2.12.1 agents in `ApiBuilder::build` and takes no client and no TLS configuration. ureq's `tls` feature verifies against `webpki-roots` alone (0.26.11, which re-exports 1.0.7), and its `native-certs` feature is off. So on every platform a CA in the system's store, such as a TLS-inspecting proxy's, is not trusted for the model's hosts. Every client that takes `chan_tls::client_config()` in the same process does trust it: the desktop's gateway clients, the tunnel, `chan metrics --url`.
- By reading of ureq 2.12.1, a refused certificate surfaces as `hf-hub: request error: <url>: Connection Failed: tls connection init failed: <rustls's reason>`, unless a proxy variable is set to a value ureq cannot use: then `hf_fetch_err` reports that variable instead.
- The download honours `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (http and SOCKS) through ureq, and not `NO_PROXY`. `ApiBuilder::new` reads no `HF_ENDPOINT`, so the host is always the Hub's. A model already in the cache (`global_models_dir`, in hf-hub's layout as `model_files_present` reads it) opens without a fetch.

## Desired contract

1. The model download takes its TLS configuration from `chan_tls::client_config()`, as the other Rust clients do. That means the platform verifier on macOS and Windows, and the system bundle beside the bundled floor on Linux and the other Unixes, with `SSL_CERT_FILE` and `SSL_CERT_DIR` read where chan-tls reads them. No option disables verification.
2. A download refused for its certificate names that cause in the CLI's error line and in the Settings and preflight messages.
3. Nothing else of the download changes: the proxy variables it honours and the `ProxyConfig` error for one it cannot use, the hosts it reaches, and the cache layout, so a model downloaded before is found without a fetch.

## Boundaries

- chan-workspace's download client and a new dependency of chan-workspace on chan-tls; `crates/chan-tls/design.md`'s list of callers and of clients outside it.
- hf-hub 0.4.3's blocking API takes no agent and no TLS configuration, so what changes is the client that fetches the model. One option is a client of chan's own: ureq's `AgentBuilder::tls_config` takes the rustls 0.23 configuration chan-tls returns, and the workspace has one rustls, 0.23.40. Another is reqwest writing hf-hub's cache layout. A third is another hf-hub surface that takes a client. The build chooses and says why.
- Not here: the CLI's self-update (`crates/chan/src/update.rs`) and the other clients `crates/chan-tls/design.md` lists outside the shared decision; and an `embed-model` build, which carries the model and downloads nothing.

## Acceptance

1. Tests, red on the code without the change: the download's client, handed a recorded configuration (`chan_tls::testing::recording`) and pointed at the loopback sink (`chan_tls::testing::Sink`), reads back that it started TLS with that configuration. A model already in the cache opens without a fetch.
2. In a desktop guest, the system CA row's recipe (in the `chan-dev` repository under `releases/v0128/team/evidence/Lead128/systemca-reading/`), adapted: a throwaway CA in the system store, and the model's hosts reached through a TLS-inspecting proxy named by `HTTPS_PROXY` whose leaves that CA signs. With the CA in the store, `chan workspace index download-model` and the Settings download both complete. With the CA removed, both fail and name the certificate. At the base, both fail with the CA installed (the red).
3. The same reading on the Windows VM (`dev/vm/windows.sh`) with the CA in the machine's Root store, and on the owner's Mac with the CA in the System keychain.

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, points 7 and 13.1) on 2026-11-14: "as you recommend" on the client, and on the Mac line: "not doing it for this release, we can postpone".

- The client is ureq, as a direct dependency at the version already locked (2.12.1), built with `AgentBuilder::tls_config` over `chan_tls::client_config()`, with `try_proxy_from_env(true)` as hf-hub calls it. chan writes hf-hub's cache layout itself (`blobs/<etag>`, a relative symlink under `snapshots/<commit>/`, a rename where a symlink is refused, as on Windows, then `refs/main`), pinned against a listing of a cache hf-hub itself wrote and against hf-hub's own `Cache::get` as a dev dependency; hf-hub's network API goes.
- The build keeps what hf-hub's sync API does today: the metadata request (`Range: bytes=0-0`, `x-repo-commit`, `x-linked-etag` or `etag`, relative redirects followed by hand), the per-blob lock that makes two downloads at once safe, the temporary file with resume, and the CLI's progress bar. The error text keeps today's transport form, with chan's certificate variant added for contract 2.
- From point 13.3: the TLS-inspecting proxy acceptance 2 needs is new work; v0.128.0's system CA recipe has a throwaway CA and no proxy. For this row it answers for the Hub's host names with a small recorded model, so the reading needs neither the network nor the full download.
- Acceptance 3's Mac line is postponed; the row closes on its guest and Windows VM lines and says in its closing section that the macOS reading was not made. The lock change gets `make nix-hash-check` and a re-pin at the merge; two reviewers read the range.

## Built, 2026-11-15: implementation and regression proof

The model download uses ureq 2.12.1 directly, with separate metadata and payload agents taking `chan_tls::client_config()`. A cache hit initializes neither agent. The client keeps ureq's environment proxy lookup, the Hub metadata headers and range request, the hf-hub cache layout, per-blob locking, resumable partial files and progress reporting. Tests compare the layout with a cache captured from hf-hub itself and read chan's cache through hf-hub's own `Cache::get`; the fallback publishes a regular file when symlinks are unavailable.

Two boundary decisions were needed to preserve the row's contract. The inherited unconditional cache wipe on an opening error could destroy another downloader's lock or resumable bytes, so only model decoding, loading and inference-probe failures wipe the model cache and retry. Filesystem and download errors preserve it. Both metadata and payload redirects refuse HTTPS downgrades; same-host redirects retain the Hub bearer, and redirects to another host strip it. The lead accepted both decisions on 2026-11-15 in `dev/v0131-team/tasks/task-Lead131-Web131-20.md`.

Certificate failures retain the transport cause and add the certificate classification through the CLI and HTTP error envelope. Preflight retains a failed decision's message across readiness polls until another choice or a settled step clears it. Settings already displays the cause. The lead accepted its unchanged checked Enable semantic search control: that records the saved preference, while the adjacent refusal explains why semantic search is inactive; the captured refusal sent no enable request.

Evidence under `dev/v0131-team/`: `evidence/Ops131/J122/` contains the baseline shared-configuration assertion failures and cache control; `evidence/Ops131/J150/` contains 51 passing download tests and the passing Candle I/O mapping test. `evidence/Ops131/J152/first/` and `remaining/` contain 60 distinct Linux mutations, each rejected at its intended assertion with original and restored controls green: 66 native test records per arm, because some mutations select more than one test. The source restoration receipts match the implementation. Parent audits are `evidence/Web131/modelroots-J150-parent-audit.json` and `modelroots-J152-parent-audit.json`.

`evidence/Ops131/J148/` records browser check 252 failing at the intended preflight-message assertion on the base and passing on the implementation, with neighbor check 184 passing. The captured server refusal remains visible after polling and in Settings. This check intercepts HTTP responses; it establishes error rendering and retry behavior, not TLS trust, an actual model download or inference. The raw screenshots and traces, and `evidence/Web131/modelroots-J148-parent-audit.json`, preserve that distinction.

The implementation stage does not close the row. Committed-tip gates and the integration lock reconciliation remain pending. The earlier `make nix-hash-check` exited 2 on the changed lock digest; the lead owns the re-pin after integration. The native Windows symlink-privilege proof and Windows proxy/system-store CLI and Settings reading are queued. The Linux model reading still needs its fixture and runner. The macOS reading was not made and was postponed by the owner.
