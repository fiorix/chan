// Build-id resolution rules, shared between `build.rs` and its tests.
//
// `build.rs` pulls this file in with `include!`, and `lib.rs` mounts it under
// `#[cfg(test)]` so the rules are exercised by `cargo test` rather than only by
// whichever build happened to run. Keep it dependency-free and std-only: a
// build script compiles before the crate's dependencies exist.
//
// Plain `//` rather than `//!`: an included file's inner doc comments would
// land mid-file in `build.rs` and inner docs may only open an item.

/// Build environment variable that overrides the git-derived id.
///
/// The override is what makes the id survive a build that cannot see a git
/// checkout. `packaging/nix/chan.nix` sets it from the flake's revision;
/// without it the Nix store's `.git`-less source would stamp
/// [`UNKNOWN_BUILD_ID`] in exactly the release path that has to carry an id.
const BUILD_ID_ENV: &str = "CHAN_BUILD_ID";

/// Stamped when neither an override nor a git checkout is available. Matches
/// the desktop build script's fallback so the two read alike.
const UNKNOWN_BUILD_ID: &str = "unknown";

/// Marks an id as a commit from a git checkout, as opposed to the
/// content-derived id `flake.nix` falls back to for a revisionless flake.
///
/// Both are 12 hex characters, so without a tag an operator reading a build id
/// over a tunnel cannot tell a commit from a content hash -- and only one of
/// them can be looked up in the history. Keep this in step with the tags in
/// `flake.nix`.
const GIT_BUILD_ID_TAG: &str = "git-";

/// Resolve the id to stamp: an injected override wins, git is the fallback.
///
/// `injected` is the raw `CHAN_BUILD_ID` value and `git_id` is consulted only
/// when the override is absent -- deliberately lazy, because a Nix build has
/// no `git` binary to run and no checkout to run it against.
///
/// An override that is empty or all whitespace counts as absent: a packaging
/// path that computed no revision passes an empty string, and stamping an
/// empty id would read as a build with no identity rather than falling back
/// to whatever git can still say.
fn resolve_build_id(injected: Option<String>, git_id: impl FnOnce() -> Option<String>) -> String {
    if let Some(raw) = injected {
        if let Some(id) = accept_injected(&raw) {
            return id.to_string();
        }
    }
    git_id().unwrap_or_else(|| UNKNOWN_BUILD_ID.to_string())
}

/// Tag a git-derived id, suffixing `-dirty` when the tree had uncommitted
/// tracked changes. `hash` is the checkout's short head.
fn git_build_id_from(hash: &str, dirty: bool) -> String {
    let suffix = if dirty { "-dirty" } else { "" };
    format!("{GIT_BUILD_ID_TAG}{hash}{suffix}")
}

/// Validate an injected id, returning `None` when it carries nothing.
///
/// Panics on a non-empty value that is not an identity token. The only
/// setters are our own packaging recipes, so a malformed value is a
/// packaging defect that should stop the build loudly; falling back to git
/// would hide it behind the `unknown` stamp this whole mechanism exists to
/// prevent. The character rule is not cosmetic: the id is printed as a
/// `cargo:rustc-env=` line, so a newline in it would let the value forge
/// further build-script directives out of this script's stdout.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_id_wins_over_git() {
        // The load-bearing rule for the Nix path: the store's source has no
        // `.git`, so the override has to beat git even when git answers.
        let id = resolve_build_id(Some("abc123def456".to_string()), || {
            panic!("git must not be consulted when an override is set")
        });
        assert_eq!(id, "abc123def456");
    }

    #[test]
    fn git_id_is_the_fallback_without_an_override() {
        let id = resolve_build_id(None, || Some("0123456789ab".to_string()));
        assert_eq!(id, "0123456789ab");
    }

    #[test]
    fn no_override_and_no_git_stamps_unknown() {
        assert_eq!(resolve_build_id(None, || None), UNKNOWN_BUILD_ID);
    }

    #[test]
    fn blank_override_falls_back_to_git_rather_than_stamping_empty() {
        // A packaging path that resolved no revision passes "" through the
        // environment; that is absence, not an identity.
        for blank in ["", "   ", "\n"] {
            let id = resolve_build_id(Some(blank.to_string()), || Some("cafebabe1234".to_string()));
            assert_eq!(id, "cafebabe1234", "blank override {blank:?}");
        }
    }

    #[test]
    fn override_is_trimmed() {
        // `$(git rev-parse ...)` through a shell keeps its trailing newline.
        let id = resolve_build_id(Some("  abc123def456\n".to_string()), || None);
        assert_eq!(id, "abc123def456");
    }

    #[test]
    fn nix_style_content_ids_are_accepted() {
        // The shapes packaging/nix passes: a sliced rev, a dirty rev, and the
        // narHash-derived id a revisionless `path:` flake degrades to.
        for id in [
            "git-abc123def456",
            "git-abc123def456-dirty",
            "nar-0123456789ab",
        ] {
            assert_eq!(accept_injected(id), Some(id));
        }
    }

    #[test]
    fn a_git_id_says_it_is_a_commit() {
        // The tag is what lets an operator with no shell on the host tell a
        // commit they can look up from the same-width content hash that
        // `flake.nix` falls back to.
        assert_eq!(git_build_id_from("abc123def456", false), "git-abc123def456");
        assert_eq!(
            git_build_id_from("abc123def456", true),
            "git-abc123def456-dirty"
        );
    }

    #[test]
    #[should_panic(expected = "CHAN_BUILD_ID must be alphanumeric")]
    fn a_newline_bearing_override_stops_the_build() {
        // Not hypothetical hygiene: the id is emitted as a `cargo:rustc-env=`
        // line, so an embedded newline forges a second directive.
        accept_injected("abc123\ncargo:rustc-env=CHAN_PACKAGED=nix");
    }

    #[test]
    #[should_panic(expected = "CHAN_BUILD_ID must be alphanumeric")]
    fn a_shell_bearing_override_stops_the_build() {
        accept_injected("abc123; rm -rf /");
    }
}
