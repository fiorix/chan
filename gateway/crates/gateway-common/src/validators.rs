//! Shared shape validators and the rename-cap constant.
//!
//! These rules cross service boundaries: profile-service mints
//! placeholder usernames and enforces the cap on rename; identity-
//! service validates rename input before calling profile. Keeping the
//! rules in one place avoids drift, especially around the `[a-z0-9-]`
//! alphabet and the lifetime-rename cap.

/// Hard cap on lifetime username renames. Counter starts at 0 on
/// account creation; the API rejects when count == cap. Picked to
/// allow occasional renames without letting handles churn under
/// chan.app/{username}.
pub const MAX_USERNAME_EDITS: i32 = 4;

/// 3-32 chars, lowercase ascii alnum plus `-`, must not start or end
/// with a hyphen, and must not contain `--`: the double hyphen is
/// reserved as the `{user}--{disc}` separator in devserver wildcard
/// hosts, so a username carrying it would make host parsing
/// ambiguous. Equivalent to
/// `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` minus any `--`, without
/// pulling regex in for one pattern. Used as the universal "is this
/// a syntactically well-formed username" gate.
pub fn valid_username(s: &str) -> bool {
    let len = s.len();
    if !(3..=32).contains(&len) {
        return false;
    }
    let b = s.as_bytes();
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !alnum(b[0]) || !alnum(b[len - 1]) {
        return false;
    }
    if s.contains("--") {
        return false;
    }
    b.iter().all(|&c| alnum(c) || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_minimal_and_full_length() {
        assert!(valid_username("abc"));
        assert!(valid_username("a-very-long-handle-with-thirty-2"));
    }

    #[test]
    fn rejects_short_long_and_boundary_hyphens() {
        assert!(!valid_username("ab"));
        assert!(!valid_username(&"x".repeat(33)));
        assert!(!valid_username("-abc"));
        assert!(!valid_username("abc-"));
    }

    #[test]
    fn rejects_double_hyphen_accepts_single() {
        // `--` is the reserved user/disc separator in devserver
        // wildcard hosts ({user}--{disc}.devserver.<base>).
        assert!(!valid_username("ab--cd"));
        assert!(!valid_username("a--b"));
        assert!(!valid_username("x--y--z"));
        assert!(valid_username("ab-cd"));
        assert!(valid_username("a-b-c"));
    }

    #[test]
    fn rejects_uppercase_and_disallowed_chars() {
        assert!(!valid_username("Abc"));
        assert!(!valid_username("a_b"));
        assert!(!valid_username("a.b"));
        assert!(!valid_username("a b"));
    }
}
