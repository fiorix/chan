# Captured hf-hub cache

These eight files are unchanged observations of hf-hub 0.4.3's synchronous `ApiRepo::get` writing a Linux cache through ureq 2.12.1. A loopback HTTP server serves three small transfer payloads through relative redirects, with a distinct transport ETag and linked content ETag for the weights. The payloads are not an inference-valid transformer model.

`fixture.json` identifies the model, commit, payload bytes, sizes and ETags. `requests.jsonl` records the twelve observed requests and their response headers: each file's metadata request uses `bytes=0-0`, its payload request uses `bytes=0-`, and each follows one relative redirect. Host addresses and dates are absent from the observations. Authorization presence is recorded without a credential value; every captured request has it absent.

`layout.jsonl` and `layout.tsv` record the same fifteen entries, sorted by relative path, after hf-hub writes the cache. Regular-file hashes cover content; symlink hashes cover the relative target text, not the dereferenced payload. The three empty lock files remain in `blobs/`. `refs-main.bin` contains exactly forty commit bytes without a newline. After the server stopped, a second invocation called both `Cache::get` and `ApiRepo::get` for every file, returned identical paths and payloads, and left the cache unchanged. Both invocations exited successfully.

The capture's standalone Rust `src/main.rs` has SHA256 `bbbef3d2467b0d820f3b2aba42447b36b918d4b9e74f3b5df8f326b5c177b231`, its Python `capture.py` has SHA256 `359b9eef4a5d20bb95cf0732607deb62968664370b2a820a1b71baeab4077260`, its resolved dependency lock has SHA256 `9bd613256354a40ebc05e99c9c24012edffafffb4e86aa42976e885d8770c1c8`, and the executed binary has SHA256 `0550d1e4457f57328da45ab0c686b01bc29d74c131b6de5e20ad9a6abe1c5d39`. The capture uses hf-hub's published `api/sync.rs` writer and `Cache` reader; it supplies no expected cache listing.

The regeneration harness is in the chan-dev archive at `releases/v0131-team/evidence/Web131/modelroots-capture-r2/`. It contains `src/main.rs`, `capture.py`, `Cargo.toml`, `Cargo.lock` and its run instructions.

The copied file hashes are:

- `layout.jsonl`: `a730e1ca52c8456964ea28c4a6396972478bd96ac225126be374db9dded6ecba`.
- `layout.tsv`: `a0cca80b368299619d78fa96bbfced66477fc281bb733c8639e342dd367bc0bf`.
- `fixture.json`: `22453edce976299fccc66bf40c1dbc60dd34736232e11ef367130a51e6ee1ae0`.
- `refs-main.bin`: `deb87fabd17715bb31ad4cf4ffb9494eeb15f8d33d85b031a301c64ab3417eaa`.
- `requests.jsonl`: `9432c6e7e18c62346f03132cc8e3ef8d2114e3acc77494ea1b765e1c0fe37ca2`.
- `payloads/config.json`: `2f8be3bcfba53ccc1387a414a701a631b75c7d34a43df0be3ce2f5bfb4c556fd`.
- `payloads/tokenizer.json`: `e4c5e2a41b2a136d0ee312fbb56f3a1c38608f21b72503435b8877d034ba8f9d`.
- `payloads/model.safetensors`: `411a485216e432ece6b9af94fa32154cf79a2a56d4f81266baa50063f45092bd`.

`cache_layout_tests.rs` consumes these files directly. `download_matches_the_cache_and_requests_captured_from_hf_hub` replays the recorded responses, compares chan's complete cache inventory and requests with the capture, and uses the actual hf-hub `Cache::get` reader. `captured_hf_hub_cache_is_read_without_initializing_a_transport` reconstructs the observed cache and verifies its files open without constructing HTTP agents or changing any entry. Both tests are Unix-only because this capture contains symlinks; the separate symlink-refusal tests cover the rename fallback, and native Windows behavior requires its own reading.
