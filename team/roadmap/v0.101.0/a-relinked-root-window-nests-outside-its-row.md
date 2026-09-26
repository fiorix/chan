# A relinked root's handoff window nests outside its launcher row

Status: raised during v0.101.0 on 2026-09-26 by the independent review of a test-only order (`dev/v0101-team/reviews/review-Services-1.md`, finding 3, in the development tree), which found it older than that order's range. A source reading against `main` at `1566b06d0`; not reproduced.

## What was seen

The window feed matches a record's stored root against either of two keys the runtime holds, its canonical root or the registry row's root it was opened at (`found_by`, `crates/chan-library/src/host.rs:589-590`), so a record minted with either spelling is in the feed. The launcher nests a window under its workspace row by string equality with the row's `root_path` (`web/packages/launcher/src/lib/machineTree.ts:52-55`, `:106`; the row's path comes from the registry at `crates/chan-server/src/routes/library.rs:704-707`). Two mint sites store the canonical key of the caller's path rather than the row's root: the devserver handoff (`crates/chan-server/src/devserver.rs:2610-2611`, keyed at `:854-859`) and the desktop's window paths (`desktop/src-tauri/src/window_ops.rs:163-170`, `main.rs:2889`, `:2904`, `serve.rs:112`). For a root whose spelling has been relinked since the row was stored (a row at `/home/u/proj` after `/home/u` became a symlink to `/data/u`), those sites store `/data/u/proj`: the window is in the feed and sits outside its workspace row. The window route and the command action store the row's root and nest correctly. `crates/chan-library/design.md`'s sentence that a record's path is the one the launcher nests it under holds only for those two.

## Desired contract

A window minted for a registered root nests under that root's launcher row whichever spelling the minting site resolved, and the design text says which spelling a record stores.

## What to do

Either have every mint site store the registry row's root (the handoff and desktop sites would look the row up by the key they already hold), or have the launcher nest by the same two-key match the feed uses. The first keeps one spelling in every record and is the smaller change; the second keeps a lexical launcher. Red first: a test that relinks a registered root, mints through the devserver handoff, and asserts the launcher tree nests the window under the row; today it is a top-level window.

## Boundaries

The mint sites named above, `machineTree.ts` if the second shape is taken, and the design sentence. The feed match itself and the root locks are not part of this item.
