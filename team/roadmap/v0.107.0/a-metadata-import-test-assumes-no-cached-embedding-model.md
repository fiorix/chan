# A metadata import test assumes no cached embedding model

Status: raised on 2026-10-15 from the pre-push gate run on the owner's workstation for the day's landing; written down with its cause proven by a control run, not designed, not accepted for build; owner the runtime seat.

## What was seen

`metadata_import_without_rescan_converges_graph_and_search_on_the_next_open` in `crates/chan-workspace/src/metadata_archive.rs` (from `ef7e82f68`, 2026-09-13) fails on a host whose user has run semantic search: three runs of three on 2026-10-15, on the assertion that the embedding shards on disk after the reopen equal the imported shard alone (`assert_eq!(shards(&paths.index), imported_shards)`), with two shards on the left, one of them the embedding of `added.md`, against the one imported shard of `keep.md` on the right. The test's own comment says why it expects one: "no model is loaded in tests", so the file the archive never described is read and indexed but not embedded. That holds in CI and in the gate guests, which have no model cache, and not on a workstation: `embeddings::global_models_dir()` is `dirs::cache_dir()/chan/models`, the host holds `~/.cache/chan/models/models--BAAI--bge-small-en-v1.5` from the owner's own use, the reopened workspace finds the model, embeds `added.md` and writes a second shard. The control: the same test with `XDG_CACHE_HOME` pointed at an empty directory passes, and with the host's cache it fails again. Nothing in the tree changed between the two runs. The gate's other 43 test binaries were green in the same run (`cargo test --all-targets --no-fail-fast`).

Not established: whether other tests in the workspace read the host's cache the same way (a search of the callers of `global_models_dir` was not made for this item); whether a test that wants the model, if any, would also need the seam.

## Desired contract

A test that expects no model finds none whatever the host holds: the suite's reading of the model cache is the test's to set, never the user's cache. `make pre-push` on a workstation that has used semantic search runs the step green.

## What to do

Read every caller of `embeddings::global_models_dir` in the crate and its tests, then give the tests a seam: an override of the models directory that the library honours (a field on the open options or a test-only setter under the crate's own env or state discipline), so this test points it at an empty temporary directory and any test that wants a model seeds one there. Setting `XDG_CACHE_HOME` from the test is process-global and races the other tests of the binary, so it is not the repair unless the crate already serializes environment mutation. Pin the repair by running the test with a seeded fake cache directory holding the model's directory name and reading it green, red first with the override absent.

## Boundaries

`crates/chan-workspace/src/index/embeddings.rs` (the directory's resolution), `index/facade.rs` where it is read, `metadata_archive.rs` tests, and `crates/chan-workspace/design.md` if the seam is a public option. Not changed: where a user's models live; the download path; the import's behaviour.

## Acceptance

1. The test passes on a host whose cache holds the model, pinned by a seeded fake cache in the test's own temporary directory, red first.
2. The whole `chan-workspace` suite stays green on a host with no cache, in the ordinary and the symlinked-temp arms.
3. A gate run on a workstation with the model cached runs `cargo test --all-targets` green for this crate.
