//! The library compiles its test harness for its own tests alone, so the
//! library an integration test or a binary links exports no `test_env`.
//!
//! A missing module cannot be named, so the check is a rival for the name.
//! Both globs below offer a `test_env`: the probe always, the library only
//! if it exports one. While it does, the name is ambiguous and this file
//! does not compile (E0659); once it does not, the name is the probe's.

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
    assert!(!BUILD_ID.is_empty());
    assert!(test_env::is_the_probe());
}
