//! Stamp the `chan` binary with the build it was made from.
//!
//! The version string cannot identify a build on its own: the version pins
//! bump only at release cut, so a branch build and the previous release carry
//! the same version. That ambiguity cost the 2026-08-08 extension incident its
//! first diagnostic cycle, unable to tell a freshly built devserver from a
//! day-old process behind the same tunnel.
//!
//! `desktop/src-tauri/build.rs` is the shape this follows, with one deliberate
//! difference. Deriving the id from git alone is not enough here, because this
//! crate has to keep its identity through the Nix release path: `flake.nix`
//! passes `src = self`, and the flake source in the Nix store has no `.git`,
//! so a purely git-derived id would stamp `unknown` in exactly the path that
//! has to work. The id is therefore injectable -- `CHAN_BUILD_ID` from the
//! build environment wins, and git is the fallback for an ordinary checkout.
//! `packaging/nix/chan.nix` is the setter.
//!
//! The rules themselves live in `src/build_id.rs` so `cargo test` covers them.

include!("src/build_id.rs");

fn main() {
    // The included rules are part of this script's behaviour, and the
    // rerun-if-* lines below opt out of Cargo's default whole-package scan.
    println!("cargo:rerun-if-changed=src/build_id.rs");
    // Without this, a first build with no override would keep its git-derived
    // stamp across a later build that sets one -- which is the Nix path.
    println!("cargo:rerun-if-env-changed={BUILD_ID_ENV}");

    let id = resolve_build_id(std::env::var(BUILD_ID_ENV).ok(), git_build_id);
    println!("cargo:rustc-env={BUILD_ID_ENV}={id}");

    // Restamp when the checkout's head moves. `--absolute-git-dir` resolves
    // through a worktree's `.git` file to the real git directory. Emitted
    // even when an override won, so removing the override from the
    // environment still lands on a fresh git id rather than a stale one.
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        println!("cargo:rerun-if-changed={git_dir}/index");
    }
}

/// The checkout's head as `git-<12 hex>`, `-dirty` when the tree carries
/// uncommitted tracked changes. `None` outside a git checkout, or where `git`
/// is not installed -- both true inside the Nix build sandbox.
fn git_build_id() -> Option<String> {
    let hash = git(&["rev-parse", "--short=12", "HEAD"])?;
    // A `git status` that could not run reads as clean, as it does in the
    // desktop build script: an unprovable `-dirty` is worse than none.
    let dirty = git(&["status", "--porcelain"]).is_some_and(|status| !status.is_empty());
    Some(git_build_id_from(&hash, dirty))
}

fn git(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
