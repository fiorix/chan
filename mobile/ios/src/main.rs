//! iOS app entry for the binary target: the app is iOS-only, so a
//! host build of this binary exists only so the workspace check, test,
//! and clippy gates cover the crate; the real entries are the
//! staticlib's `app::ios_entry` (called from Swift) and, for a device
//! executable build, this `main`, both running the same boot in
//! `app::ios::run`.

fn main() {
    #[cfg(target_os = "ios")]
    app::ios::run();
}
