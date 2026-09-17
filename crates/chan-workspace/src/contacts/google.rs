// Google Contacts CSV parser.
//
// Format reference: contacts.google.com -> Export -> "Google CSV".
// The header row varies a little across export vintages and locales,
// but the columns we care about have stable names since 2018-ish.
//
// Multi-valued slots use one of two encodings:
//
//   1. Repeated indexed columns:
//        "E-mail 1 - Value", "E-mail 1 - Type",
//        "E-mail 2 - Value", "E-mail 2 - Type", ...
//
//   2. Multi-value within a single column, separated by " ::: ":
//        "E-mail 1 - Value": "a@x.com ::: b@y.com"
//        "E-mail 1 - Type":  "home ::: work"
//
// We handle both. (1) is the documented default; (2) shows up
// occasionally and is harmless to support.
//
// Columns we read (with fallbacks, in priority order):
//   Name | Display Name             -> display_name
//   Given Name | First Name         -> given_name
//   (none)     | Middle Name        -> middle_name (only used to
//                                       compose display_name when
//                                       the Name column is empty)
//   Family Name | Last Name         -> family_name
//   Notes                           -> notes
//   Group Membership | Labels       -> labels (split on " ::: ")
//   E-mail N - Value / Type         -> emails
//   Phone N - Value / Type          -> phones
//   Organization N - Name / Title   -> organizations
//
// Why the fallbacks: Google's current Google CSV export (as of 2025/2026) uses First Name / Middle Name / Last Name, while older exports use Given Name / Family Name. Reading only one shape leaves the name columns unread and titles every row by its email.
//
// Everything else is ignored. We don't error on unknown columns;
// Google adds them all the time and dropping them is the right call.

use std::collections::HashMap;
use std::io::Read;

use crate::error::{ChanError, Result};

use super::{Contact, EmailAddress, Organization, PhoneNumber, ProviderKind};

const MULTI_SEP: &str = " ::: ";

/// Cap on `<prefix> N - <field>` slot scanning per row. Google's CSV
/// export typically tops out at 9; 16 is generous and bounded so a
/// row with weird headers can't make us iterate forever.
const MAX_INDEXED_FIELDS: usize = 16;

/// Parse a Google Contacts CSV from any `Read`. Returns one
/// `Contact` per non-empty data row. Rows with no usable identity
/// (no display name, no email, no phone) are skipped silently
/// rather than emitted as ghost contacts.
pub fn parse_google_csv<R: Read>(rdr: R) -> Result<Vec<Contact>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(rdr);

    let header_index: HashMap<String, usize> = reader
        .headers()
        .map_err(csv_err)?
        .iter()
        .enumerate()
        .map(|(i, h)| (h.trim().to_string(), i))
        .collect();

    let mut out = Vec::new();
    for rec in reader.records() {
        let rec = rec.map_err(csv_err)?;
        let get = |name: &str| -> Option<String> {
            header_index
                .get(name)
                .and_then(|&i| rec.get(i))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let get_any = |names: &[&str]| -> Option<String> { names.iter().find_map(|n| get(n)) };

        let display_name = get_any(&["Name", "Display Name"]).unwrap_or_default();
        let given_name = get_any(&["Given Name", "First Name"]);
        let middle_name = get("Middle Name");
        let family_name = get_any(&["Family Name", "Last Name"]);
        let notes = get("Notes");
        let labels = get_any(&["Group Membership", "Labels"])
            .map(|s| {
                s.split(MULTI_SEP)
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    // "* myContacts" is the system label Google sets on
                    // every contact; not useful as a user-facing tag.
                    .filter(|p| !p.starts_with("* "))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let emails: Vec<EmailAddress> = collect_pairs(&get, "E-mail", "Value", "Type")
            .into_iter()
            .map(|(value, label)| EmailAddress { value, label })
            .collect();

        let phones: Vec<PhoneNumber> = collect_pairs(&get, "Phone", "Value", "Type")
            .into_iter()
            .map(|(value, label)| PhoneNumber { value, label })
            .collect();

        let organizations: Vec<Organization> = collect_pairs(&get, "Organization", "Name", "Title")
            .into_iter()
            .map(|(name, title)| Organization { name, title })
            .collect();

        let has_identity = !display_name.is_empty() || !emails.is_empty() || !phones.is_empty();
        if !has_identity {
            continue;
        }

        let display_name = if display_name.is_empty() {
            // Synthesize from what we have so the body H1 isn't empty.
            // Slug logic has its own fallback chain for the filename.
            best_effort_name(&given_name, &middle_name, &family_name, &emails, &phones)
        } else {
            display_name
        };

        out.push(Contact {
            provider: ProviderKind::Google,
            remote_id: None,
            display_name,
            given_name,
            family_name,
            emails,
            phones,
            organizations,
            notes,
            labels,
            // Google's CSV export does not carry alternate names;
            // users add aliases by editing the imported note.
            aliases: vec![],
        });
    }

    Ok(out)
}

/// Collect all "<prefix> N - <field_a>" / "<prefix> N - <field_b>"
/// pairs across all N, then split each cell on " ::: " in case the
/// export bundled multiple values into one column. Returns
/// `Vec<(field_a, Option<field_b>)>` in the order encountered.
fn collect_pairs<F>(
    get: &F,
    prefix: &str,
    field_a: &str,
    field_b: &str,
) -> Vec<(String, Option<String>)>
where
    F: Fn(&str) -> Option<String>,
{
    let mut out = Vec::new();
    for n in 1..=MAX_INDEXED_FIELDS {
        let key_a = format!("{prefix} {n} - {field_a}");
        let key_b = format!("{prefix} {n} - {field_b}");
        let raw_a = get(&key_a);
        let raw_b = get(&key_b);
        if raw_a.is_none() && raw_b.is_none() {
            continue;
        }
        let parts_a: Vec<String> = raw_a
            .as_deref()
            .map(|s| s.split(MULTI_SEP).map(str::to_string).collect())
            .unwrap_or_default();
        let parts_b: Vec<String> = raw_b
            .as_deref()
            .map(|s| s.split(MULTI_SEP).map(str::to_string).collect())
            .unwrap_or_default();
        let count = parts_a.len().max(parts_b.len()).max(1);
        for i in 0..count {
            let a = parts_a.get(i).map(|s| s.trim()).unwrap_or("");
            if a.is_empty() {
                continue;
            }
            let b = parts_b
                .get(i)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            out.push((a.to_string(), b));
        }
    }
    out
}

fn best_effort_name(
    given: &Option<String>,
    middle: &Option<String>,
    family: &Option<String>,
    emails: &[EmailAddress],
    phones: &[PhoneNumber],
) -> String {
    let parts: Vec<&str> = [given.as_deref(), middle.as_deref(), family.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if !parts.is_empty() {
        return parts.join(" ");
    }
    emails
        .first()
        .map(|e| e.value.clone())
        .or_else(|| phones.first().map(|p| p.value.clone()))
        .unwrap_or_default()
}

fn csv_err(e: csv::Error) -> ChanError {
    // CSV errors carry a position; surface it so callers can point
    // the user at the bad row.
    if let Some(pos) = e.position() {
        ChanError::Contacts(format!("csv error at line {}: {e}", pos.line()))
    } else {
        ChanError::Contacts(format!("csv error: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "Name,Given Name,Family Name,Notes,Group Membership,\
E-mail 1 - Type,E-mail 1 - Value,E-mail 2 - Type,E-mail 2 - Value,\
Phone 1 - Type,Phone 1 - Value,\
Organization 1 - Name,Organization 1 - Title";

    #[test]
    fn parses_one_full_row() {
        let csv = format!(
            "{HEADER}\n\
\"Jane Q. Doe\",Jane,Doe,\"Met at FOSDEM\",\"* myContacts ::: Friends\",\
Home,jane@home.com,Work,jane@work.com,\
Mobile,+1-555-0100,\
\"Acme Corp\",Engineer\n"
        );
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 1);
        let c = &v[0];
        assert_eq!(c.display_name, "Jane Q. Doe");
        assert_eq!(c.given_name.as_deref(), Some("Jane"));
        assert_eq!(c.family_name.as_deref(), Some("Doe"));
        assert_eq!(c.notes.as_deref(), Some("Met at FOSDEM"));
        assert_eq!(c.labels, vec!["Friends".to_string()]); // * myContacts dropped
        assert_eq!(c.emails.len(), 2);
        assert_eq!(c.emails[0].value, "jane@home.com");
        assert_eq!(c.emails[0].label.as_deref(), Some("Home"));
        assert_eq!(c.emails[1].value, "jane@work.com");
        assert_eq!(c.phones.len(), 1);
        assert_eq!(c.phones[0].value, "+1-555-0100");
        assert_eq!(c.organizations.len(), 1);
        assert_eq!(c.organizations[0].name, "Acme Corp");
        assert_eq!(c.organizations[0].title.as_deref(), Some("Engineer"));
    }

    #[test]
    fn handles_multi_value_within_one_column() {
        // Two emails packed into the slot-1 column.
        let csv = format!(
            "{HEADER}\n\
\"Bob\",Bob,,,\"* myContacts\",\
\"Home ::: Work\",\"a@x.com ::: b@y.com\",,,\
,,\
,\n"
        );
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 1);
        let c = &v[0];
        assert_eq!(c.emails.len(), 2);
        assert_eq!(c.emails[0].value, "a@x.com");
        assert_eq!(c.emails[0].label.as_deref(), Some("Home"));
        assert_eq!(c.emails[1].value, "b@y.com");
        assert_eq!(c.emails[1].label.as_deref(), Some("Work"));
    }

    #[test]
    fn skips_rows_with_no_identity() {
        let csv = format!("{HEADER}\n,,,,,,,,,,,,\n");
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 0);
    }

    #[test]
    fn synthesizes_display_name_when_missing() {
        let csv = format!(
            "{HEADER}\n\
,Carol,,,,,carol@x.com,,,,,,\n"
        );
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 1);
        // Falls back to given name since family is missing.
        assert_eq!(v[0].display_name, "Carol");
    }

    #[test]
    fn ragged_rows_dont_crash() {
        // Truncated row: csv crate's flexible mode accepts it; we
        // just see fewer fields. Should still parse the leading
        // columns we have.
        let csv = format!("{HEADER}\n\"Dave\",Dave\n");
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].display_name, "Dave");
        assert_eq!(v[0].emails.len(), 0);
    }

    #[test]
    fn unicode_names_preserved() {
        let csv = format!("{HEADER}\n\"Zoë Müller\",Zoë,Müller,,,,,,,,,,\n");
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v[0].display_name, "Zoë Müller");
        assert_eq!(v[0].given_name.as_deref(), Some("Zoë"));
    }

    #[test]
    fn empty_input_returns_empty() {
        let v = parse_google_csv(b"".as_slice()).unwrap();
        assert!(v.is_empty());
    }

    #[test]
    fn header_only_returns_empty() {
        let v = parse_google_csv(HEADER.as_bytes()).unwrap();
        assert!(v.is_empty());
    }

    /// Current Google Contacts export header uses `First Name` /
    /// `Middle Name` / `Last Name` instead of the older `Given Name`
    /// / `Family Name` shape. Verify the fallback lookups pick them
    /// up and compose `display_name` correctly.
    #[test]
    fn parses_first_middle_last_header_shape() {
        let header = "First Name,Middle Name,Last Name,Notes,Labels,\
E-mail 1 - Label,E-mail 1 - Value,\
Phone 1 - Label,Phone 1 - Value,\
Organization 1 - Name,Organization 1 - Title";
        let csv = format!(
            "{header}\n\
Alexandre,Prado,Vilela,,,\
Home,alepradovilella@yahoo.com.br,\
,,\
,\n"
        );
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 1);
        let c = &v[0];
        assert_eq!(c.display_name, "Alexandre Prado Vilela");
        assert_eq!(c.given_name.as_deref(), Some("Alexandre"));
        assert_eq!(c.family_name.as_deref(), Some("Vilela"));
        assert_eq!(c.emails.len(), 1);
        assert_eq!(c.emails[0].value, "alepradovilella@yahoo.com.br");
    }

    /// First Name only, no middle / last. Display name should be
    /// just the given name (no extra spaces, no email fallback).
    #[test]
    fn first_name_only_falls_through_cleanly() {
        let header = "First Name,Middle Name,Last Name,\
E-mail 1 - Label,E-mail 1 - Value";
        let csv = format!("{header}\nAldren,,,Home,aldren@gmail.com\n");
        let v = parse_google_csv(csv.as_bytes()).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].display_name, "Aldren");
    }
}
