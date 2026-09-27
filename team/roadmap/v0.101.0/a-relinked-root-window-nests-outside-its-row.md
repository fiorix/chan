# A relinked root's handoff window nests outside its launcher row

Status: raised during v0.101.0 on 2026-09-26 by the independent review of a test-only order (`dev/v0101-team/reviews/review-Services-1.md`, finding 3, in the development tree), which found it older than that order's range. A source reading against `main` at `1566b06d0`; not reproduced.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, with the smaller shape: every mint site stores the registry row's root, the handoff and desktop sites looking the row up by the key they already hold; red first with a relinked root minted through the devserver handoff. The services lane's, paired with the absent-root handoff item since both touch the desktop's handoff mint.

On 2026-09-27 the owner accepted, as the lead recommended, a widening of the item. A code map of the lane's next orders (`dev/v0101-team/int24-docs/codemaps/services-next.md` in the development tree, headline 5 and its section on this item, read at `4139f8656`, nothing run) found a second place where the two spellings part. The devserver keys a new mount's record by the canonical key of the path it was given (`begin_registered_mount`, `crates/chan-server/src/devserver.rs:1092`, the key from `register_workspace_keyed` and `mount_at`, `:968-974`, `:986-991`), while its management list joins records to registry rows by the row's stored root (`workspace_entries`, `:1634-1646`), lists a row with no record as off (`:1644-1645`) and lists a record with no row only while it is on (`:1653-1657`). So after a relinked root is mounted, a desktop connected to the devserver would list the workspace twice, an off row at the stored root and an on row at the canonical path, and a fix of the window's path alone would nest the window under the off row. That is inferred from the code, and no test asserts it. Revised: the item widens from the window's path to one row per workspace, joined by the canonical key, and a code map comes before its order.

## What was seen

The window feed matches a record's stored root against either of two keys the runtime holds, its canonical root or the registry row's root it was opened at (`found_by`, `crates/chan-library/src/host.rs:589-590`), so a record minted with either spelling is in the feed. The launcher nests a window under its workspace row by string equality with the row's `root_path` (`web/packages/launcher/src/lib/machineTree.ts:52-55`, `:106`; the row's path comes from the registry at `crates/chan-server/src/routes/library.rs:704-707`). Two mint sites store the canonical key of the caller's path rather than the row's root: the devserver handoff (`crates/chan-server/src/devserver.rs:2610-2611`, keyed at `:854-859`) and the desktop's window paths (`desktop/src-tauri/src/window_ops.rs:163-170`, `main.rs:2889`, `:2904`, `serve.rs:112`). For a root whose spelling has been relinked since the row was stored (a row at `/home/u/proj` after `/home/u` became a symlink to `/data/u`), those sites store `/data/u/proj`: the window is in the feed and sits outside its workspace row. The window route and the command action store the row's root and nest correctly. `crates/chan-library/design.md`'s sentence that a record's path is the one the launcher nests it under holds only for those two.

## Desired contract

A window minted for a registered root nests under that root's launcher row whichever spelling the minting site resolved, and the design text says which spelling a record stores.

## What to do

Either have every mint site store the registry row's root (the handoff and desktop sites would look the row up by the key they already hold), or have the launcher nest by the same two-key match the feed uses. The first keeps one spelling in every record and is the smaller change; the second keeps a lexical launcher. Red first: a test that relinks a registered root, mints through the devserver handoff, and asserts the launcher tree nests the window under the row; today it is a top-level window.

Under the owner's revised ruling of 2026-09-27 the item also asks for one row per workspace: the devserver's list joins a relinked root's record to its registry row by the canonical key, so the root lists once, and the window nests under that one row. The code map that the ruling asked for was made the same day (`dev/v0101-team/int28-docs/codemaps/relinked-root-one-row.md` in the development tree, read at `91cdd462e`, nothing run), and from it the lead ruled how the join reads the key: a record joins the registry row whose stored root or whose cached canonical path is the record's root, the match `canonical_root_status` already makes (`crates/chan-library/src/host.rs:3718-3728` at `37e9d23dd`), which resolves nothing and touches no filesystem; and every mint of a workspace window stores the root its runtime was opened at. Windows that an earlier build stored under the canonical path are not rewritten. Red first for this half: the same relinked root mounted through the devserver, and its management list read for one row. This paragraph was added on 2026-09-27 to bring this section to the revised ruling.

## Boundaries

The mint sites named above, `machineTree.ts` if the second shape is taken, and the design sentence. The feed match itself and the root locks are not part of this item.
