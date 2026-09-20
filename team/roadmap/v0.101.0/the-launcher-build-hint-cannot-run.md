# The launcher-not-built hint names a command that cannot run

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog. The claims are a source reading against `main` at `fa0df75ad`.

## What was seen

When the launcher bundle is missing, `crates/chan-server/src/static_assets.rs` answers 404 with "launcher bundle not built; run `cd web-launcher && npm install && npm run build`", and a comment in `crates/chan-server/build.rs` says the same. `web-launcher/` is the gitignored build output of `web/packages/launcher` and has no `package.json`, so the command fails for anyone who follows it. The bundle is built by `make web-launcher`, which runs `npm run build -w @chan/launcher` from `web/`. The sibling hints for the workspace bundle (`cd web && npm install && npm run build`) point at a real package root and are not part of this.

Two comments in `crates/chan-server/src/indexer.rs` still name a plan label: "Option-A split" on the state that reaches Idle once BM25 is built, and "the Option-A background-embed state" further down. The label means nothing to a reader of the code and the writing rules keep plan references out of comments.

The backlog listed a third leftover, the `SERVE_LONG_ABOUT` constant in `crates/chan/src/lib.rs`, as a stale `chan serve` name. It is not stale: `serve` is a real verb again and the constant is that command's long help. Nothing to do there.

## Desired contract

Owner ruling, 2026-09-20: fix the hint; clean up the comments if it is simple. The hint names a command that works from a fresh clone, and the two comments describe the state in the code's own terms.

## Boundaries

`crates/chan-server/src/static_assets.rs`, `crates/chan-server/build.rs`, and the two comments in `crates/chan-server/src/indexer.rs`. The 404 body is a string a test may pin.

## Acceptance

1. The hint's command, run from a fresh clone, produces `web-launcher/dist`.
2. Each rewritten comment is checked against the function it sits on, and neither names a plan, an option label or a round.
3. `cargo test -p chan-server` is green, including any test that pins the 404 body.
