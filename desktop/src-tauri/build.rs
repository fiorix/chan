fn main() {
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        stage_check_sidecar();
    }
    emit_build_id();
    tauri_build::build()
}

/// Build environment variable that overrides the git-derived id, and the name
/// the resolved id is compiled under. `packaging/nix/chan-desktop.nix` is the
/// only setter.
///
/// The override is what makes the id survive a build that cannot see a git
/// checkout. `flake.nix` passes `src = self`, so the source in the Nix store
/// has no `.git`; without this the packaged desktop app stamps
/// [`UNKNOWN_BUILD_ID`] in the path most users install from.
const BUILD_ID_ENV: &str = "CHAN_DESKTOP_BUILD_ID";

/// Stamped when neither an override nor a git checkout is available. Matches
/// the `chan` build script's fallback so the two read alike.
const UNKNOWN_BUILD_ID: &str = "unknown";

/// Marks an id as a commit from a git checkout, as opposed to the
/// content-derived id `flake.nix` falls back to for a revisionless flake.
///
/// Both are 12 hex characters, so without a tag an operator reading a build id
/// off a running app cannot tell a commit from a content hash, and only one of
/// them can be looked up in the history. `crates/chan/src/build_id.rs` and
/// `flake.nix` carry the same two tags; keep them in step.
const GIT_BUILD_ID_TAG: &str = "git-";

/// Stamp the binary with the build it was made from. The version string cannot
/// identify a build on its own: the version pins bump only at release cut, so a
/// pre-release branch build and the previous release's bundle carry the same
/// version.
///
/// An injected override wins and git is the fallback, in that order, because
/// the packaging path that most needs an id is the one with no git to ask.
fn emit_build_id() {
    // Without this, a first build with no override keeps its git-derived stamp
    // across a later build that sets one, which is the Nix path.
    println!("cargo:rerun-if-env-changed={BUILD_ID_ENV}");

    let injected = std::env::var(BUILD_ID_ENV).ok();
    let id = injected
        .as_deref()
        .and_then(accept_injected)
        .map(str::to_string)
        .or_else(git_build_id)
        .unwrap_or_else(|| UNKNOWN_BUILD_ID.to_string());
    println!("cargo:rustc-env={BUILD_ID_ENV}={id}");

    // Restamp when the checkout's head moves. `--absolute-git-dir` resolves
    // through a worktree's `.git` file to the real git directory. Emitted even
    // when an override won, so removing the override from the environment
    // still lands on a fresh git id rather than a stale one.
    //
    // KNOWN LIMITATION, shared with `crates/chan/build.rs` and deliberate:
    // these lines exist only when git resolved, so a build that saw no git
    // stamps "unknown" and that stamp is STICKY until something else
    // invalidates the script. No shipped path makes that transition, since Nix
    // always injects an override and CI and developer checkouts have git from
    // the first build.
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        println!("cargo:rerun-if-changed={git_dir}/index");
    }
}

/// The checkout's head as `git-<12 hex>`, `-dirty` when the tree carries
/// uncommitted tracked changes. `None` outside a git checkout, or where `git`
/// is not installed, both of which are true inside the Nix build sandbox.
fn git_build_id() -> Option<String> {
    let hash = git(&["rev-parse", "--short=12", "HEAD"])?;
    // A `git status` that could not run reads as clean: an unprovable `-dirty`
    // is worse than none.
    let dirty = git(&["status", "--porcelain"]).is_some_and(|status| !status.is_empty());
    let suffix = if dirty { "-dirty" } else { "" };
    Some(format!("{GIT_BUILD_ID_TAG}{hash}{suffix}"))
}

/// Validate an injected id, returning `None` when it carries nothing.
///
/// An override that is empty or all whitespace counts as absent: a packaging
/// path that computed no revision passes an empty string, and stamping an empty
/// id would read as a build with no identity rather than falling back to
/// whatever git can still say.
///
/// Panics on a non-empty value that is not an identity token. The only setters
/// are our own packaging recipes, so a malformed value is a packaging defect
/// that should stop the build loudly; falling back to git would hide it behind
/// the `unknown` stamp this mechanism exists to prevent. The character rule is
/// not cosmetic: the id is printed as a `cargo:rustc-env=` line, so a newline
/// in it would let the value forge further build-script directives out of this
/// script's stdout.
fn accept_injected(raw: &str) -> Option<&str> {
    let id = raw.trim();
    if id.is_empty() {
        return None;
    }
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '+'));
    assert!(
        ok,
        "{BUILD_ID_ENV} must be alphanumeric with -._+ separators, got {id:?}"
    );
    Some(id)
}

fn git(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn stage_check_sidecar() {
    let Some(manifest_dir) = std::env::var_os("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Some(target) = std::env::var_os("TARGET") else {
        return;
    };

    let sidecars_dir = std::path::Path::new(&manifest_dir).join("binaries");
    let sidecar = sidecars_dir.join(format!("chan-{}", target.to_string_lossy()));
    println!("cargo:rerun-if-changed={}", sidecar.display());

    if sidecar.exists() {
        return;
    }

    std::fs::create_dir_all(&sidecars_dir).expect("creating Tauri sidecar dir");
    std::fs::write(&sidecar, b"").expect("creating check-only Tauri sidecar placeholder");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755))
            .expect("marking check-only Tauri sidecar placeholder executable");
    }
}
