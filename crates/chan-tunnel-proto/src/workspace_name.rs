//! Shape checks for tunnel workspace names and validated usernames.
//!
//! Both tunnel ends check `Hello.workspace` as defense in depth. The
//! devserver sends the placeholder `devserver`; the gateway registers the
//! tunnel using the devserver id resolved from the token and never puts
//! this Hello name in a public URL. The devserver derives public tenant
//! path segments from its own workspace slugs.

/// Maximum accepted length of `Hello.workspace` (inclusive).
pub const MAX_WORKSPACE_NAME_LEN: usize = 32;

/// Maximum username length (inclusive). Generous compared to common
/// identity services (GitHub caps at 39, Google goes higher); we
/// pick 64 so the defensive check rarely rejects legitimate input
/// that the upstream validator already accepted.
pub const MAX_USERNAME_LEN: usize = 64;

/// Returns true if `s` passes the tunnel server's defensive username check:
/// 1..=`MAX_USERNAME_LEN` ASCII alphanumerics, `-` or `_`, starting with
/// an alphanumeric character. Rejects path separators, whitespace and leading
/// punctuation after bearer-token validation.
///
/// This permits uppercase, underscores and double hyphens. The gateway's
/// `gateway_common::validators::valid_username` enforces the stricter shape
/// required for usernames in public tenant host labels.
pub fn is_valid_username(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_USERNAME_LEN {
        return false;
    }
    let valid = |b: u8| b.is_ascii_alphanumeric() || b == b'-' || b == b'_';
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes.iter().all(|&b| valid(b))
}

/// Returns true if `s` is a syntactically valid workspace name.
///
/// Rules:
/// - 1..=32 ASCII bytes
/// - characters are `[a-z0-9-]`
/// - first and last character are alphanumeric (no leading/trailing
///   hyphen)
pub fn is_valid_workspace_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_WORKSPACE_NAME_LEN {
        return false;
    }
    let valid = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if !alnum(bytes[0]) || !alnum(bytes[bytes.len() - 1]) {
        return false;
    }
    bytes.iter().all(|&b| valid(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_canonical_examples() {
        assert!(is_valid_workspace_name("notes"));
        assert!(is_valid_workspace_name("a"));
        assert!(is_valid_workspace_name("d-1"));
        assert!(is_valid_workspace_name("123"));
        assert!(is_valid_workspace_name(&"a".repeat(MAX_WORKSPACE_NAME_LEN)));
    }

    #[test]
    fn rejects_invalid_examples() {
        assert!(!is_valid_workspace_name(""));
        assert!(!is_valid_workspace_name("-leading"));
        assert!(!is_valid_workspace_name("trailing-"));
        assert!(!is_valid_workspace_name("UpperCase"));
        assert!(!is_valid_workspace_name("with space"));
        assert!(!is_valid_workspace_name("punct!"));
        assert!(!is_valid_workspace_name(
            &"a".repeat(MAX_WORKSPACE_NAME_LEN + 1)
        ));
    }

    #[test]
    fn username_accepts_typical_shapes() {
        assert!(is_valid_username("alice"));
        assert!(is_valid_username("Alice"));
        assert!(is_valid_username("alice_42"));
        assert!(is_valid_username("alice-bob"));
        assert!(is_valid_username("a"));
        assert!(is_valid_username(&"a".repeat(MAX_USERNAME_LEN)));
    }

    #[test]
    fn username_rejects_unsafe_shapes() {
        assert!(!is_valid_username(""));
        assert!(!is_valid_username("..")); // path traversal
        assert!(!is_valid_username("alice/bob")); // slash
        assert!(!is_valid_username("alice bob")); // space
        assert!(!is_valid_username("-leading-hyphen"));
        assert!(!is_valid_username("_leading_underscore")); // first must be alnum
        assert!(!is_valid_username("alice?query"));
        assert!(!is_valid_username("alice#anchor"));
        assert!(!is_valid_username(&"a".repeat(MAX_USERNAME_LEN + 1)));
    }
}
