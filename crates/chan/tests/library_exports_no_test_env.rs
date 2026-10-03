//! The library compiles its test harness for its own tests alone, so the
//! library an integration test or a binary links exports no `test_env`.
//!
//! A missing module cannot be named, so the check is a rival for the name.
//! Both globs below offer a `test_env`: the probe always, the library only
//! if it exports one. While it does, this file does not compile: the name is
//! ambiguous between the two globs, which the lint denied below reports, and
//! rustc 1.95 resolves it to the library's module, which has no
//! `is_the_probe` (E0425). Once the library exports none, the name is the
//! probe's alone.

// Rustc reports this ambiguity through a lint until it becomes a hard error;
// denied here so the check does not rest on the flags of the build.
#![deny(ambiguous_glob_imports)]

mod probe {
    pub mod test_env {
        pub fn is_the_probe() -> bool {
            true
        }
    }
}

use chan::*;
use probe::*;

#[test]
fn the_library_exports_no_test_env() {
    // Named through the library's glob, which shows that glob reaches the
    // library's root, where a `test_env` would be.
    let _through_the_library: Personality = Personality::Standalone;
    assert!(test_env::is_the_probe());
}
