// Pull email addresses out of a contact note's body so the editor
// `@` picker (and `Workspace::contacts_filtered`) can match a typed
// `alice` against `alice@example.com` without having to re-parse the
// whole markdown bullet structure on every keystroke.
//
// We deliberately avoid a regex dep: the email shape we accept is
// narrow (RFC 5321-ish dot-atom local-part, dot-atom domain with at
// least one dot) and a hand-rolled scanner keeps chan-workspace's
// dependency footprint flat. The scanner runs once per indexed
// contact file, not per query, so its cost is amortized to zero on
// the picker hot path.
//
// Match shape:
//
//   local @ domain
//
//   local  : [A-Za-z0-9._%+-]+   (the punctuation set actually seen
//                                 in real address books; intentionally
//                                 narrower than RFC 5321 to keep
//                                 false-positives down on prose like
//                                 "see foo@bar in section 3")
//   domain : labels separated by `.`, each label
//            [A-Za-z0-9-]+ with no leading or trailing `-`,
//            TLD label of at least two chars.
//
// Quoted local parts (`"a b"@x.com`) and IP-literal domains
// (`a@[10.0.0.1]`) are out of scope: they are not in any address
// book we expect to see imported. Adding them later is a localized
// change to `accept_local_char` / `domain_char`.
//
// Output: lowercased, deduplicated, in first-seen order. Lowercase
// because the picker's match is ASCII case-insensitive and we don't
// want two case-different copies of the same address polluting the
// secondary-line preview.

use std::collections::HashSet;

/// Extract every email-shaped substring from `body`. See module
/// header for the accepted shape. Returns lowercased, deduplicated
/// addresses in first-seen order.
pub fn extract_emails(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            if let Some((start, end)) = match_at(bytes, i) {
                let raw = &body[start..end];
                // The matched range admits backslashes only as Markdown
                // escapes of accepted local-part punctuation.
                let lower = raw.replace('\\', "").to_ascii_lowercase();
                if seen.insert(lower.clone()) {
                    out.push(lower);
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Try to grow an email match around the `@` at byte offset `at`.
/// Returns the (start, end) byte range on success.
fn match_at(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    // Walk left from `at` while the byte is a valid local-part char.
    let mut start = at;
    while start > 0 && is_local_char(bytes[start - 1]) {
        start -= 1;
        if bytes[start].is_ascii_punctuation() {
            let backslashes = bytes[..start]
                .iter()
                .rev()
                .take_while(|&&b| b == b'\\')
                .count();
            // An even run represents literal backslashes, which remain a
            // boundary. Only the final slash of an odd run escapes this byte.
            if !backslashes.is_multiple_of(2) {
                start -= 1;
            }
        }
    }
    // Trim a leading `.` so prose like "...email me at .alice@..."
    // doesn't capture the dot. Repeat for `.+-_%` runs.
    while start < at && matches!(bytes[start], b'.' | b'-' | b'+' | b'_' | b'%') {
        start += 1;
    }
    if start == at {
        return None; // empty local part
    }

    // Walk right past the `@` while the byte is a valid domain char.
    let mut end = at + 1;
    while end < bytes.len() && is_domain_char(bytes[end]) {
        end += 1;
    }
    // Trim a trailing `.` or `-` (e.g., "alice@example.com." captured
    // by sentence end).
    while end > at + 1 && matches!(bytes[end - 1], b'.' | b'-') {
        end -= 1;
    }
    if end == at + 1 {
        return None; // empty domain
    }

    // Domain must have at least one `.` and a TLD of >= 2 chars.
    let domain = &bytes[at + 1..end];
    let last_dot = domain.iter().rposition(|b| *b == b'.')?;
    if domain.len() - last_dot - 1 < 2 {
        return None;
    }
    // No empty labels (e.g., "a@.com" or "a@x..com").
    let mut prev_was_dot = true; // domain must not start with `.`
    for &b in domain {
        if b == b'.' {
            if prev_was_dot {
                return None;
            }
            prev_was_dot = true;
        } else {
            prev_was_dot = false;
        }
    }

    Some((start, end))
}

fn is_local_char(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'+' | b'-' | b'%')
}

fn is_domain_char(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_markdown_escaped_underscore_local_part() {
        assert_eq!(
            extract_emails(r"- **Email**: first\_last@example.com"),
            ["first_last@example.com"]
        );
        assert_eq!(
            extract_emails(r"First\_Last@Example.COM first_last@example.com"),
            ["first_last@example.com"]
        );
        assert_eq!(
            extract_emails(r"first\_middle\_last@example.com"),
            ["first_middle_last@example.com"]
        );
        assert_eq!(
            extract_emails(r"first\.last\+work@example.com"),
            ["first.last+work@example.com"]
        );
        assert_eq!(
            extract_emails(r"first\\_last@example.com"),
            ["last@example.com"]
        );
        assert_eq!(
            extract_emails(r"first\qlast@example.com"),
            ["qlast@example.com"]
        );
    }

    #[test]
    fn extracts_a_single_email_from_a_bullet_line() {
        let v = extract_emails("- **Email**: alice@example.com (work)");
        assert_eq!(v, vec!["alice@example.com"]);
    }

    #[test]
    fn lowercases() {
        let v = extract_emails("Alice@Example.COM");
        assert_eq!(v, vec!["alice@example.com"]);
    }

    #[test]
    fn deduplicates_in_first_seen_order() {
        let body = "alice@x.com\nbob@y.com\nALICE@x.com\nalice@x.com";
        let v = extract_emails(body);
        assert_eq!(v, vec!["alice@x.com", "bob@y.com"]);
    }

    #[test]
    fn handles_plus_aliases_and_dotted_locals() {
        let v = extract_emails("a.b+filter@my.host.org");
        assert_eq!(v, vec!["a.b+filter@my.host.org"]);
    }

    #[test]
    fn ignores_bare_at_and_short_tld() {
        assert!(extract_emails("@x.com").is_empty());
        assert!(extract_emails("alice@").is_empty());
        assert!(extract_emails("alice@x.c").is_empty(), "TLD shorter than 2");
        assert!(extract_emails("alice@.com").is_empty(), "leading dot");
        assert!(extract_emails("alice@x..com").is_empty(), "empty label");
    }

    #[test]
    fn trims_surrounding_punctuation() {
        let v = extract_emails("Reach me at <alice@example.com>, please.");
        assert_eq!(v, vec!["alice@example.com"]);
    }

    #[test]
    fn does_not_extract_a_mid_word_at() {
        // Twitter-style `@handle` should not look like an email.
        let v = extract_emails("see @handle for details");
        assert!(v.is_empty(), "got {v:?}");
    }

    #[test]
    fn extracts_multiple_from_a_full_contact_body() {
        let body = "\
# Jane Doe

- **Email**: jane@home.com (Home)
- **Email**: jane@work.com (Work)
- **Phone**: +1-555-0100

Met at FOSDEM, follow-up to alice@example.com next week.
";
        let v = extract_emails(body);
        assert_eq!(
            v,
            vec!["jane@home.com", "jane@work.com", "alice@example.com"]
        );
    }
}
