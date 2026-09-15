// Filename derivation for imported contacts.
//
// Strategy:
//   1. Derive a base name from `display_name`, then fall back to
//      first email local-part, then `phone-<digits>`, then
//      `unnamed-<n>` (n increments within the import batch).
//   2. Sanitize: replace path separators, colons, control chars,
//      and leading/trailing whitespace runs with `_`.
//   3. Trim to MAX_BASE_BYTES while staying UTF-8 safe.
//   4. On collision in the destination directory, append " (2)",
//      " (3)", etc. before the `.md` extension. Caller decides
//      whether to suffix or to overwrite.

use std::collections::HashSet;

use super::Contact;

/// Base-name byte cap. 120 bytes leaves room under typical 255-byte
/// filesystem limits even after the ` (N).md` suffix and a parent
/// directory.
const MAX_BASE_BYTES: usize = 120;

/// Filename allocator for one import batch: owns the set of paths
/// already chosen plus the `unnamed-<n>` fallback counter, with the
/// destination `dir` and the `on_disk` existence probe fixed for the
/// batch.
///
/// `taken` starts empty deliberately: if a file already exists at a
/// contact's natural slug, the allocator must still pick that exact
/// name so the caller can apply skip/overwrite semantics on it, not
/// silently rename around it. `on_disk` is consulted only in the
/// `" (N)"` suffix loop, so two same-named contacts in one batch
/// don't clobber an unrelated existing file at the suffixed path.
pub struct SlugAllocator<'a> {
    dir: &'a str,
    on_disk: &'a dyn Fn(&str) -> bool,
    taken: HashSet<String>,
    unnamed: usize,
}

impl<'a> SlugAllocator<'a> {
    /// `dir` is a workspace-relative directory in POSIX form (e.g.,
    /// `"Contacts"`); empty string means the workspace root.
    pub fn new(dir: &'a str, on_disk: &'a dyn Fn(&str) -> bool) -> Self {
        Self {
            dir,
            on_disk,
            taken: HashSet::new(),
            unnamed: 0,
        }
    }

    /// Pick a filename for `c`, returning a workspace-relative path
    /// under the allocator's `dir`, and record it as taken for the
    /// rest of the batch.
    pub fn slug_for(&mut self, c: &Contact) -> String {
        let base = base_name(c, &mut self.unnamed);
        let sanitized = sanitize(&base);
        let trimmed = trim_to_bytes(&sanitized, MAX_BASE_BYTES);

        let mut candidate = join(self.dir, &format!("{trimmed}.md"));
        if !self.taken.contains(&candidate) {
            self.taken.insert(candidate.clone());
            return candidate;
        }
        // Collision: try " (2)", " (3)", ... suffixes. Avoid both names
        // already chosen in this batch and unrelated files already on
        // disk at that suffix.
        let mut n = 2usize;
        loop {
            candidate = join(self.dir, &format!("{trimmed} ({n}).md"));
            if !self.taken.contains(&candidate) && !(self.on_disk)(&candidate) {
                self.taken.insert(candidate.clone());
                return candidate;
            }
            n += 1;
        }
    }
}

fn base_name(c: &Contact, unnamed_counter: &mut usize) -> String {
    let dn = c.display_name.trim();
    if !dn.is_empty() {
        return dn.to_string();
    }
    if let Some(email) = c.emails.first() {
        if let Some((local, _)) = email.value.split_once('@') {
            let local = local.trim();
            if !local.is_empty() {
                return local.to_string();
            }
        }
    }
    if let Some(phone) = c.phones.first() {
        // Keep a leading `+` so E.164 numbers (`+15550100`) don't slug
        // to the same name as their unprefixed form (`15550100`); both
        // shapes appear in CSV exports and conflating them would
        // collide silently in the same batch.
        let mut canon = String::with_capacity(phone.value.len());
        let mut seen_digit = false;
        for ch in phone.value.chars() {
            if ch == '+' && !seen_digit && canon.is_empty() {
                canon.push('+');
            } else if ch.is_ascii_digit() {
                canon.push(ch);
                seen_digit = true;
            }
        }
        if seen_digit {
            return format!("phone-{canon}");
        }
    }
    *unnamed_counter += 1;
    format!("unnamed-{}", *unnamed_counter)
}

fn sanitize(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let bad = matches!(ch, '/' | '\\' | ':' | '\0')
            || ch.is_control()
            // Reserved on Windows; harmless to drop on Unix too so
            // imports stay portable.
            || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*');
        out.push(if bad { '_' } else { ch });
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed
    }
}

fn trim_to_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Cut on a UTF-8 char boundary at or before `max`.
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].trim_end().to_string()
}

fn join(dir: &str, file: &str) -> String {
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        file.to_string()
    } else {
        format!("{dir}/{file}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contacts::{EmailAddress, PhoneNumber};

    fn contact_named(name: &str) -> Contact {
        Contact {
            display_name: name.into(),
            ..Default::default()
        }
    }

    fn no_disk(_: &str) -> bool {
        false
    }

    #[test]
    fn basic_slug_under_dir() {
        let mut slugs = SlugAllocator::new("Contacts", &no_disk);
        let p = slugs.slug_for(&contact_named("Jane Doe"));
        assert_eq!(p, "Contacts/Jane Doe.md");
        assert!(slugs.taken.contains("Contacts/Jane Doe.md"));
    }

    #[test]
    fn collision_appends_paren_n() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        slugs.slug_for(&contact_named("Jane"));
        let p2 = slugs.slug_for(&contact_named("Jane"));
        let p3 = slugs.slug_for(&contact_named("Jane"));
        assert_eq!(p2, "Jane (2).md");
        assert_eq!(p3, "Jane (3).md");
    }

    #[test]
    fn collision_loop_skips_existing_disk_files() {
        // Two "Jane" contacts in a batch, and "Jane (2).md" already
        // exists on disk for an unrelated reason. The second contact
        // must NOT pick "Jane (2).md" (would clobber under overwrite,
        // or report misleading "skipped" otherwise). It should jump
        // to "Jane (3).md".
        let exists = |p: &str| p == "Jane (2).md";
        let mut slugs = SlugAllocator::new("", &exists);
        let p1 = slugs.slug_for(&contact_named("Jane"));
        let p2 = slugs.slug_for(&contact_named("Jane"));
        assert_eq!(p1, "Jane.md");
        assert_eq!(p2, "Jane (3).md");
    }

    #[test]
    fn natural_slug_ignores_disk_so_overwrite_semantics_apply() {
        // The natural slug must still land on "Jane.md" even when the
        // file exists, so the orchestrator can decide skip vs.
        // overwrite. Only the suffix-loop branch consults disk.
        let exists = |p: &str| p == "Jane.md";
        let mut slugs = SlugAllocator::new("", &exists);
        let p = slugs.slug_for(&contact_named("Jane"));
        assert_eq!(p, "Jane.md");
    }

    #[test]
    fn sanitize_replaces_path_chars() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        let p = slugs.slug_for(&contact_named("a/b\\c:d"));
        assert_eq!(p, "a_b_c_d.md");
    }

    #[test]
    fn sanitize_replaces_control_chars() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        let p = slugs.slug_for(&contact_named("a\nb\tc"));
        assert_eq!(p, "a_b_c.md");
    }

    #[test]
    fn fallback_to_email_local_part() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        let c = Contact {
            emails: vec![EmailAddress {
                value: "alice@example.com".into(),
                label: None,
            }],
            ..Default::default()
        };
        let p = slugs.slug_for(&c);
        assert_eq!(p, "alice.md");
    }

    #[test]
    fn fallback_to_phone_keeps_leading_plus() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        let c = Contact {
            phones: vec![PhoneNumber {
                value: "+1 (555) 010-2000".into(),
                label: None,
            }],
            ..Default::default()
        };
        let p = slugs.slug_for(&c);
        assert_eq!(p, "phone-+15550102000.md");
    }

    #[test]
    fn phone_without_plus_does_not_collide_with_e164_form() {
        // `+15550100` and `15550100` are distinct numbers in the
        // exported CSV, so they must not share `phone-15550100`.
        let mut slugs = SlugAllocator::new("", &no_disk);
        let with_plus = Contact {
            phones: vec![PhoneNumber {
                value: "+1-555-0100".into(),
                label: None,
            }],
            ..Default::default()
        };
        let without = Contact {
            phones: vec![PhoneNumber {
                value: "15550100".into(),
                label: None,
            }],
            ..Default::default()
        };
        let p1 = slugs.slug_for(&with_plus);
        let p2 = slugs.slug_for(&without);
        assert_ne!(p1, p2);
        assert_eq!(p1, "phone-+15550100.md");
        assert_eq!(p2, "phone-15550100.md");
    }

    #[test]
    fn fallback_to_unnamed_counter() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        let c = Contact::default();
        let p1 = slugs.slug_for(&c);
        let p2 = slugs.slug_for(&c);
        assert_eq!(p1, "unnamed-1.md");
        assert_eq!(p2, "unnamed-2.md");
    }

    #[test]
    fn trim_long_names_on_char_boundary() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        // "é" is 2 bytes in UTF-8; ensure we don't slice mid-char.
        let long = "é".repeat(80); // 160 bytes
        let p = slugs.slug_for(&contact_named(&long));
        let stem = p.strip_suffix(".md").unwrap();
        assert!(stem.len() <= MAX_BASE_BYTES);
        assert!(stem.is_char_boundary(stem.len()));
    }

    #[test]
    fn empty_name_is_unnamed_not_underscore() {
        let mut slugs = SlugAllocator::new("", &no_disk);
        // Display name is whitespace-only and there's no email/phone.
        let c = contact_named("   ");
        let p = slugs.slug_for(&c);
        assert_eq!(p, "unnamed-1.md");
    }

    #[test]
    fn dir_with_leading_or_trailing_slash() {
        let mut slugs = SlugAllocator::new("/Contacts/", &no_disk);
        let p = slugs.slug_for(&contact_named("X"));
        assert_eq!(p, "Contacts/X.md");
    }
}
