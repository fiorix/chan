// Render a Contact as a markdown note.
//
// On-disk shape (slim version, post 2026-05-10):
//
//   ---
//   aliases: [jq, jdoe]
//   chan:
//     kind: contact
//     provider: google
//     imported_at: 2026-05-10T12:34:56Z
//     frontmatter_version: 2
//   ---
//
//   # Jane Q. Doe
//
//   - **Email**: jane@example.com (work)
//   - **Phone**: +1-555-0100 (mobile)
//   - **Org**: Acme Corp - Engineer
//   - **Labels**: Friends, Work
//
//   Notes from the CSV go here.
//
// Frontmatter holds the chan-internal classifier (so the graph
// builder + editor `@` picker can spot a contact note without
// re-parsing the body) plus an optional top-level `aliases:` array
// (Obsidian-compatible) that names extra strings `@@<alias>`
// mentions should resolve to this contact. The contact's actual
// data lives as bullet items in the body so a chan editor with no
// frontmatter renderer shows a friendly note rather than 12 lines
// of YAML.
//
// We hand-format the YAML rather than pulling a serializer dep.
// The chan block is small and fixed; adding `serde_yaml` would
// import an unmaintained crate for two lines of output.

use chrono::{DateTime, Utc};

use super::{Contact, EmailAddress, Organization, PhoneNumber};

/// Caller-supplied context. `imported_at` is plumbed in (rather
/// than read from the system clock) so tests can assert exact
/// output and so a single batch shares one timestamp.
#[derive(Debug, Clone)]
pub struct EmitContext {
    pub imported_at: DateTime<Utc>,
}

const FRONTMATTER_VERSION: u32 = 2;

pub fn render_markdown(c: &Contact, ctx: &EmitContext) -> String {
    let mut s = String::with_capacity(512);
    s.push_str("---\n");
    write_aliases_top(&mut s, c);
    write_chan_block(&mut s, c, ctx);
    s.push_str("---\n\n");
    s.push_str("# ");
    s.push_str(c.display_name.trim());
    s.push('\n');
    write_body_bullets(&mut s, c);
    if let Some(notes) = c.notes.as_ref() {
        let notes = notes.trim();
        if !notes.is_empty() {
            s.push('\n');
            write_notes(&mut s, notes);
        }
    }
    s
}

/// CSV "Notes" cells are arbitrary user text. Two failure modes if
/// emitted verbatim: `[[Other Note]]` becomes a live wiki-link edge
/// (importer-driven, not user-driven), and `# X` injects an extra H1
/// that breaks heading-based chunking and could shift the title the
/// indexer resolves for the file. `md_inline` escapes the link and
/// emphasis specials per line; this wrapper additionally backslash-
/// escapes any leading `#` so a note line never lands as an ATX
/// heading. Paragraph structure (blank lines) is preserved.
fn write_notes(s: &mut String, notes: &str) {
    for line in notes.split('\n') {
        let line = line.trim_end_matches('\r');
        let escaped = md_inline(line);
        let leading_ws_end = escaped
            .char_indices()
            .find(|(_, c)| !c.is_whitespace())
            .map(|(i, _)| i)
            .unwrap_or(escaped.len());
        let (lead, body) = escaped.split_at(leading_ws_end);
        s.push_str(lead);
        if body.starts_with('#') {
            s.push('\\');
        }
        s.push_str(body);
        s.push('\n');
    }
}

/// Write the Obsidian-style top-level `aliases:` array. Each entry
/// is rendered through `yaml_string` so an alias that happens to
/// contain a comma / quote / colon round-trips without breaking the
/// flow-list shape. Empty lists are skipped so untouched (non-
/// aliased) contacts keep their original frontmatter shape.
fn write_aliases_top(s: &mut String, c: &Contact) {
    if c.aliases.is_empty() {
        return;
    }
    s.push_str("aliases: [");
    for (i, alias) in c.aliases.iter().enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        s.push_str(&yaml_string(alias));
    }
    s.push_str("]\n");
}

fn write_chan_block(s: &mut String, c: &Contact, ctx: &EmitContext) {
    s.push_str("chan:\n");
    s.push_str("  kind: contact\n");
    s.push_str("  provider: ");
    s.push_str(c.provider.as_str());
    s.push('\n');
    s.push_str("  imported_at: ");
    // RFC3339; chrono's `to_rfc3339_opts` would let us pin the
    // format, but the default is good enough and round-trips
    // through gray_matter / serde_yaml parsers.
    s.push_str(&ctx.imported_at.to_rfc3339());
    s.push('\n');
    s.push_str("  frontmatter_version: ");
    s.push_str(&FRONTMATTER_VERSION.to_string());
    s.push('\n');
    if let Some(rid) = c.remote_id.as_ref() {
        s.push_str("  remote_id: ");
        s.push_str(&yaml_string(rid));
        s.push('\n');
    }
}

fn write_body_bullets(s: &mut String, c: &Contact) {
    let any = !c.emails.is_empty()
        || !c.phones.is_empty()
        || !c.organizations.is_empty()
        || !c.labels.is_empty();
    if !any {
        return;
    }
    s.push('\n');
    for e in &c.emails {
        write_bullet_email(s, e);
    }
    for p in &c.phones {
        write_bullet_phone(s, p);
    }
    for o in &c.organizations {
        write_bullet_org(s, o);
    }
    if !c.labels.is_empty() {
        s.push_str("- **Labels**: ");
        for (i, l) in c.labels.iter().enumerate() {
            if i > 0 {
                s.push_str(", ");
            }
            s.push_str(&md_inline(l));
        }
        s.push('\n');
    }
}

fn write_bullet_email(s: &mut String, e: &EmailAddress) {
    s.push_str("- **Email**: ");
    s.push_str(&md_inline(&e.value));
    if let Some(l) = e.label.as_ref() {
        let l = l.trim();
        if !l.is_empty() {
            s.push_str(" (");
            s.push_str(&md_inline(l));
            s.push(')');
        }
    }
    s.push('\n');
}

fn write_bullet_phone(s: &mut String, p: &PhoneNumber) {
    s.push_str("- **Phone**: ");
    s.push_str(&md_inline(&p.value));
    if let Some(l) = p.label.as_ref() {
        let l = l.trim();
        if !l.is_empty() {
            s.push_str(" (");
            s.push_str(&md_inline(l));
            s.push(')');
        }
    }
    s.push('\n');
}

fn write_bullet_org(s: &mut String, o: &Organization) {
    s.push_str("- **Org**: ");
    s.push_str(&md_inline(&o.name));
    if let Some(t) = o.title.as_ref() {
        let t = t.trim();
        if !t.is_empty() {
            // Hyphen, not em dash: workspace style rule + survives
            // ASCII-only round-trips.
            s.push_str(" - ");
            s.push_str(&md_inline(t));
        }
    }
    s.push('\n');
}

/// Escape inline markdown specials in a contact field. We only
/// escape the four chars that change rendering inside a list item:
/// asterisks, underscores, backticks, and brackets. Newlines are
/// stripped (replaced by space) so a multi-line value doesn't
/// break the bullet structure.
fn md_inline(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\n' | '\r' => out.push(' '),
            '*' | '_' | '`' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            c if c.is_control() => {} // drop other controls
            c => out.push(c),
        }
    }
    out
}

/// Double-quoted YAML string with the four escapes that matter for
/// arbitrary contact data (used only by the chan-block fields like
/// `remote_id`). Newlines / carriage returns / tabs land as
/// escapes; everything else passes through.
fn yaml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                // Other C0 controls. Use \xHH (YAML supports it).
                out.push_str(&format!("\\x{:02X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contacts::{EmailAddress, Organization, PhoneNumber, ProviderKind};
    use chrono::TimeZone;

    fn ctx() -> EmitContext {
        EmitContext {
            imported_at: Utc.with_ymd_and_hms(2026, 5, 10, 12, 34, 56).unwrap(),
        }
    }

    #[test]
    fn full_contact_emits_slim_frontmatter_and_bulleted_body() {
        let c = Contact {
            provider: ProviderKind::Google,
            remote_id: Some("people/c1".into()),
            display_name: "Jane Q. Doe".into(),
            given_name: Some("Jane".into()),
            family_name: Some("Doe".into()),
            emails: vec![EmailAddress {
                value: "jane@example.com".into(),
                label: Some("work".into()),
            }],
            phones: vec![PhoneNumber {
                value: "+1-555-0100".into(),
                label: Some("mobile".into()),
            }],
            organizations: vec![Organization {
                name: "Acme Corp".into(),
                title: Some("Engineer".into()),
            }],
            notes: Some("Met at FOSDEM 2026.".into()),
            labels: vec!["Friends".into(), "Work".into()],
            aliases: vec![],
        };
        let md = render_markdown(&c, &ctx());

        // H1 + body present.
        assert!(md.contains("# Jane Q. Doe"));
        assert!(md.contains("- **Email**: jane@example.com (work)"));
        assert!(md.contains("- **Phone**: +1-555-0100 (mobile)"));
        assert!(md.contains("- **Org**: Acme Corp - Engineer"));
        assert!(md.contains("- **Labels**: Friends, Work"));
        assert!(md.contains("Met at FOSDEM 2026."));

        // Frontmatter is the slim chan-block only; no contact: block.
        assert!(!md.contains("contact:"));
        assert!(!md.contains("display_name:"));

        // Frontmatter parses cleanly via the same parser the
        // markdown indexer uses; confirms the chan classifier shape
        // survives so the graph + @ picker keep working.
        let fm = crate::markdown::parse_frontmatter(&md);
        assert!(fm.body_offset > 0, "frontmatter not detected");
        let chan = fm.data.get("chan").expect("chan block");
        assert_eq!(chan.get("kind").and_then(|v| v.as_str()), Some("contact"));
        assert_eq!(
            chan.get("provider").and_then(|v| v.as_str()),
            Some("google")
        );
        assert_eq!(
            chan.get("frontmatter_version").and_then(|v| v.as_u64()),
            Some(2)
        );
        assert_eq!(
            chan.get("remote_id").and_then(|v| v.as_str()),
            Some("people/c1")
        );
        // No aliases provided -> the top-level aliases array is
        // omitted so non-aliased contacts keep their original
        // frontmatter shape on disk.
        assert!(fm.data.get("aliases").is_none());
    }

    #[test]
    fn aliases_emit_as_top_level_yaml_array_and_parse_back() {
        let c = Contact {
            display_name: "Alice Smith".into(),
            aliases: vec!["ali".into(), "alice".into(), "a".into()],
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        // Top-level aliases line lives above the chan: block so it
        // round-trips with the Obsidian convention (other tools
        // expect this shape at the root of frontmatter, not nested
        // under a custom namespace).
        assert!(md.contains("aliases: ["));
        let fm = crate::markdown::parse_frontmatter(&md);
        let aliases = fm.data.get("aliases").expect("aliases array");
        let arr = aliases.as_array().expect("array shape");
        let names: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(names, vec!["ali", "alice", "a"]);
    }

    #[test]
    fn aliases_with_special_chars_are_yaml_quoted() {
        let c = Contact {
            display_name: "Bob".into(),
            // A comma in the alias would otherwise split the flow
            // array; yaml_string wraps the value so the parser sees
            // a single element.
            aliases: vec!["bob, jr".into()],
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        let fm = crate::markdown::parse_frontmatter(&md);
        let arr = fm
            .data
            .get("aliases")
            .and_then(|v| v.as_array())
            .expect("array");
        let names: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(names, vec!["bob, jr"]);
    }

    #[test]
    fn minimal_contact_emits_only_h1_and_chan_block() {
        let c = Contact {
            display_name: "X".into(),
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(md.contains("kind: contact"));
        assert!(md.contains("# X"));
        // No bullet section when every contact-data field is empty.
        assert!(!md.contains("- **Email**"));
        assert!(!md.contains("- **Phone**"));
        assert!(!md.contains("- **Org**"));
        assert!(!md.contains("- **Labels**"));
        assert!(!md.contains("remote_id"));
    }

    #[test]
    fn body_strings_escape_inline_markdown_specials() {
        let c = Contact {
            display_name: "Test".into(),
            emails: vec![EmailAddress {
                // Asterisk + underscore would otherwise emphasize.
                value: "weird*user_name@x.com".into(),
                label: Some("home".into()),
            }],
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(md.contains(r"weird\*user\_name@x.com"));
    }

    #[test]
    fn rendered_email_round_trips_through_extract_emails() {
        let contact = Contact {
            display_name: "Imported Person".into(),
            emails: vec![EmailAddress {
                value: "first_last@example.com".into(),
                label: Some("work".into()),
            }],
            ..Default::default()
        };
        let markdown = render_markdown(&contact, &ctx());
        assert!(markdown.contains(r"first\_last@example.com"));
        assert_eq!(
            crate::contacts::extract_emails(&markdown),
            ["first_last@example.com"]
        );
    }

    #[test]
    fn body_strips_newlines_inside_field_values() {
        let c = Contact {
            display_name: "Test".into(),
            organizations: vec![Organization {
                name: "Foo\nCorp".into(),
                title: None,
            }],
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(md.contains("Foo Corp"));
        assert!(!md.contains("Foo\nCorp"));
    }

    #[test]
    fn body_starts_with_h1_of_display_name() {
        let c = Contact {
            display_name: "Some Body".into(),
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        let body_start = md.split("---\n").nth(2).unwrap().trim_start();
        assert!(body_start.starts_with("# Some Body"));
    }

    #[test]
    fn notes_escape_wiki_links_and_inline_specials() {
        // A wiki-link in the CSV must not become a real graph edge
        // after import; brackets get backslashed by `md_inline`.
        let c = Contact {
            display_name: "Test".into(),
            notes: Some("see [[Important Doc]] and *bold*".into()),
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(!md.contains("[[Important Doc]]"));
        assert!(md.contains(r"\[\[Important Doc\]\]"));
        assert!(md.contains(r"\*bold\*"));
    }

    #[test]
    fn notes_escape_leading_hash_so_no_extra_heading_appears() {
        // `# Section` in a note must not parse as an ATX heading
        // (would break heading-based chunking + title resolution).
        let c = Contact {
            display_name: "Test".into(),
            notes: Some("# Pwned\n\nbody line".into()),
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(md.contains(r"\# Pwned"));
        // The only real H1 is still the display-name line.
        let h1_count = md.lines().filter(|l| l.starts_with("# ")).count();
        assert_eq!(h1_count, 1);
    }

    #[test]
    fn notes_preserve_paragraph_structure() {
        let c = Contact {
            display_name: "Test".into(),
            notes: Some("first line\n\nsecond paragraph".into()),
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(md.contains("first line\n\nsecond paragraph"));
    }

    #[test]
    fn multiple_emails_each_get_their_own_bullet() {
        let c = Contact {
            display_name: "Alice".into(),
            emails: vec![
                EmailAddress {
                    value: "alice@home.com".into(),
                    label: Some("Home".into()),
                },
                EmailAddress {
                    value: "alice@work.com".into(),
                    label: Some("Work".into()),
                },
            ],
            ..Default::default()
        };
        let md = render_markdown(&c, &ctx());
        assert!(md.contains("- **Email**: alice@home.com (Home)"));
        assert!(md.contains("- **Email**: alice@work.com (Work)"));
    }
}
