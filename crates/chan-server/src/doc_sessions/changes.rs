//! ChangeSet JSON wire grammar and the UTF-16 applier for live doc
//! sessions.
//!
//! The grammar is pinned to `@codemirror/state`'s `ChangeSet.toJSON` /
//! `ChangeSet.fromJSON` (vendored copy under
//! `web/node_modules/@codemirror/state/dist/index.js`): a change set is
//! a JSON array of sections in document order, where a bare
//! non-negative integer `n` retains `n` UTF-16 code units, `[n]`
//! deletes `n` units, and `[n, "line0", "line1", ...]` replaces `n`
//! units with the lines joined by `"\n"` (so inserting a lone newline
//! is `[0, "", ""]`). Anything else is rejected at deserialization: a
//! malformed change set means a desynced or buggy client, and the doc
//! route closes that attach loudly rather than guessing.
//!
//! Positions count UTF-16 code units because that is CodeMirror's (and
//! JavaScript's) native string unit. The authority text stays a Rust
//! `String`: a `Vec<u16>` round-trip could silently rewrite content on
//! lossy conversion, and a rope is needless at the 2 MiB doc cap.
//! serde_json rejects unpaired surrogates, so client-inserted text is
//! always valid Unicode; the one CM-representable state a `String`
//! cannot hold (an edit boundary strictly inside a surrogate pair)
//! cannot be produced by interactive editing and is rejected as
//! [`ApplyError::SplitSurrogate`].
//!
//! Everything here is pure: no I/O, no tokio, no session state.

use std::fmt;

use chan_workspace::TEXT_WRITE_LIMIT;
use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// One section of a change set, in document order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Section {
    /// Keep the next `n` UTF-16 code units (`n` on the wire).
    Retain(u64),
    /// Replace the next `del` UTF-16 code units with `lines` joined by
    /// `"\n"` (`[del, lines...]` on the wire). A pure delete is an edit
    /// with no lines (`[del]`); a pure insert has `del == 0`.
    Edit { del: u64, lines: Vec<String> },
}

/// A CodeMirror `ChangeSet` in its `toJSON` wire form. The section
/// totals (retain + delete counts) must span the whole document; the
/// applier enforces that.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChangeSetJson {
    pub sections: Vec<Section>,
}

/// One collab update: a change set plus the client id that produced
/// it. An `effects` field from the client is tolerated and dropped
/// (CodeMirror serializes shared store-effects there; the authority
/// does not interpret them and never re-broadcasts them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateJson {
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub changes: ChangeSetJson,
}

/// Result of a successful apply: the new document text plus its UTF-16
/// length, so callers keep the cached length without a recount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub text: String,
    pub len16: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApplyError {
    /// A section boundary lands strictly inside a surrogate pair.
    #[error("change lands inside a surrogate pair at utf-16 offset {at}")]
    SplitSurrogate { at: u64 },
    /// The change set's section total does not span the document.
    #[error("change set spans {span} utf-16 units, document has {doc}")]
    LengthMismatch { span: u64, doc: u64 },
    /// The post-apply text would exceed the workspace text write limit.
    #[error("document would be {bytes} bytes, over the {limit} byte limit")]
    DocTooLarge { bytes: u64, limit: u64 },
}

/// UTF-16 code-unit length of a string.
pub fn utf16_len(s: &str) -> u64 {
    s.encode_utf16().count() as u64
}

/// Apply one change set to `doc` in a single forward pass.
///
/// `doc_len16` is the caller's cached UTF-16 length of `doc`; the
/// section totals are validated against it before any text work, and
/// the walk itself re-verifies against the real bytes. Pure: `doc` is
/// never modified, so a failed apply leaves the caller's text exactly
/// as it was.
pub fn apply(doc: &str, doc_len16: u64, cs: &ChangeSetJson) -> Result<Applied, ApplyError> {
    apply_with_limit(doc, doc_len16, cs, TEXT_WRITE_LIMIT)
}

/// Apply one change set under a caller-supplied semantic write budget.
pub fn apply_with_limit(
    doc: &str,
    doc_len16: u64,
    cs: &ChangeSetJson,
    limit: u64,
) -> Result<Applied, ApplyError> {
    // Saturating: an overflowing total cannot equal any real document
    // length (len16 <= 2 * byte length < u64::MAX).
    let span = cs
        .sections
        .iter()
        .map(|s| match s {
            Section::Retain(n) => *n,
            Section::Edit { del, .. } => *del,
        })
        .fold(0u64, u64::saturating_add);
    if span != doc_len16 {
        return Err(ApplyError::LengthMismatch {
            span,
            doc: doc_len16,
        });
    }

    let mut out = String::with_capacity(doc.len());
    let mut out_len16 = 0u64;
    let mut byte = 0usize;
    let mut pos16 = 0u64;

    for section in &cs.sections {
        match section {
            Section::Retain(n) => {
                let start = byte;
                advance(doc, &mut byte, &mut pos16, *n).map_err(|e| e.into_apply(span, doc))?;
                out.push_str(&doc[start..byte]);
                out_len16 += *n;
            }
            Section::Edit { del, lines } => {
                advance(doc, &mut byte, &mut pos16, *del).map_err(|e| e.into_apply(span, doc))?;
                let mut first = true;
                for line in lines {
                    if !first {
                        out.push('\n');
                        out_len16 += 1;
                    }
                    first = false;
                    out.push_str(line);
                    out_len16 += utf16_len(line);
                }
            }
        }
    }
    // The span pre-check makes this reachable only when `doc_len16`
    // disagrees with `doc` itself (a caller bug); report the truth.
    if byte != doc.len() {
        return Err(ApplyError::LengthMismatch {
            span,
            doc: utf16_len(doc),
        });
    }
    if out.len() as u64 > limit {
        return Err(ApplyError::DocTooLarge {
            bytes: out.len() as u64,
            limit,
        });
    }
    Ok(Applied {
        text: out,
        len16: out_len16,
    })
}

/// Apply a batch of updates in order, all-or-nothing: the first
/// failure aborts the batch, and because the whole path is pure the
/// caller's document is untouched unless every update applied.
// The session's push path applies per-update against its working copy;
// this batch form serves the reference and route tests.
#[allow(dead_code)]
pub fn apply_all(doc: &str, doc_len16: u64, updates: &[UpdateJson]) -> Result<Applied, ApplyError> {
    let mut applied = Applied {
        text: doc.to_owned(),
        len16: doc_len16,
    };
    for update in updates {
        applied = apply(&applied.text, applied.len16, &update.changes)?;
    }
    Ok(applied)
}

/// Express `old -> new` as a minimal whole-document replace: trim the
/// byte-level common prefix and suffix, backed off to char boundaries
/// (every char boundary is a UTF-16 boundary), and emit
/// retain / edit / retain. `apply(old, ..)` of the result yields `new`
/// exactly.
pub fn replace_diff(old: &str, new: &str) -> ChangeSetJson {
    let old_b = old.as_bytes();
    let new_b = new.as_bytes();

    let mut prefix = old_b.iter().zip(new_b).take_while(|(a, b)| a == b).count();
    while prefix > 0 && (!old.is_char_boundary(prefix) || !new.is_char_boundary(prefix)) {
        prefix -= 1;
    }

    let max_suffix = old.len().min(new.len()) - prefix;
    let mut suffix = (0..max_suffix)
        .take_while(|i| old_b[old.len() - 1 - i] == new_b[new.len() - 1 - i])
        .count();
    while suffix > 0
        && (!old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix))
    {
        suffix -= 1;
    }

    let mid_old = &old[prefix..old.len() - suffix];
    let mid_new = &new[prefix..new.len() - suffix];

    let mut sections = Vec::new();
    if prefix > 0 {
        sections.push(Section::Retain(utf16_len(&old[..prefix])));
    }
    if !mid_old.is_empty() || !mid_new.is_empty() {
        let lines = if mid_new.is_empty() {
            Vec::new()
        } else {
            mid_new.split('\n').map(str::to_owned).collect()
        };
        sections.push(Section::Edit {
            del: utf16_len(mid_old),
            lines,
        });
    }
    if suffix > 0 {
        sections.push(Section::Retain(utf16_len(&old[old.len() - suffix..])));
    }
    ChangeSetJson { sections }
}

enum AdvanceErr {
    Eof,
    Split { at: u64 },
}

impl AdvanceErr {
    fn into_apply(self, span: u64, doc: &str) -> ApplyError {
        match self {
            // Only reachable when the caller's cached length overstates
            // the document; see the equivalent check in `apply`.
            AdvanceErr::Eof => ApplyError::LengthMismatch {
                span,
                doc: utf16_len(doc),
            },
            AdvanceErr::Split { at } => ApplyError::SplitSurrogate { at },
        }
    }
}

/// Move `byte` / `pos16` forward by `n` UTF-16 code units, requiring
/// the landing point to be a scalar-value boundary.
fn advance(doc: &str, byte: &mut usize, pos16: &mut u64, n: u64) -> Result<(), AdvanceErr> {
    let mut remaining = n;
    let mut chars = doc[*byte..].chars();
    while remaining > 0 {
        let ch = chars.next().ok_or(AdvanceErr::Eof)?;
        let units = ch.len_utf16() as u64;
        if units > remaining {
            return Err(AdvanceErr::Split {
                at: *pos16 + remaining,
            });
        }
        remaining -= units;
        *pos16 += units;
        *byte += ch.len_utf8();
    }
    Ok(())
}

impl Serialize for Section {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Section::Retain(n) => serializer.serialize_u64(*n),
            Section::Edit { del, lines } => {
                let mut seq = serializer.serialize_seq(Some(1 + lines.len()))?;
                seq.serialize_element(del)?;
                for line in lines {
                    seq.serialize_element(line)?;
                }
                seq.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Section {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SectionVisitor;

        impl<'de> Visitor<'de> for SectionVisitor {
            type Value = Section;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a non-negative retain count or a [deleted, \"line0\", ...] array")
            }

            fn visit_u64<E: de::Error>(self, n: u64) -> Result<Section, E> {
                Ok(Section::Retain(n))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Section, A::Error> {
                let del: u64 = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &"a non-empty section array"))?;
                let mut lines = Vec::new();
                while let Some(line) = seq.next_element::<String>()? {
                    lines.push(line);
                }
                Ok(Section::Edit { del, lines })
            }
        }

        deserializer.deserialize_any(SectionVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> ChangeSetJson {
        serde_json::from_str(json).expect("valid change set json")
    }

    // ---- grammar pins ----

    #[test]
    fn grammar_round_trips_the_pinned_wire_form() {
        let cs = ChangeSetJson {
            sections: vec![
                Section::Retain(3),
                Section::Edit {
                    del: 1,
                    lines: vec![],
                },
                Section::Edit {
                    del: 2,
                    lines: vec!["ab".into(), String::new()],
                },
                Section::Retain(4),
            ],
        };
        let wire = r#"[3,[1],[2,"ab",""],4]"#;
        assert_eq!(serde_json::to_string(&cs).unwrap(), wire);
        assert_eq!(parse(wire), cs);
        assert_eq!(parse("[]"), ChangeSetJson::default());
        assert_eq!(parse("[5]").sections, vec![Section::Retain(5)]);
    }

    #[test]
    fn grammar_rejects_malformed_sections() {
        for json in [
            "5", // not an array
            "{}",
            "\"x\"",
            "[[]]",      // empty section
            "[[\"a\"]]", // first element not a number
            "[[1,2]]",   // non-string after the delete count
            "[[1,\"a\",2]]",
            "[-1]",  // negative retain
            "[1.5]", // fractional retain
            "[[-1]]",
            "[[1.5,\"a\"]]",
            "[true]",
            "[null]",
            "[[1,null]]",
        ] {
            assert!(
                serde_json::from_str::<ChangeSetJson>(json).is_err(),
                "should reject {json}"
            );
        }
    }

    #[test]
    fn single_newline_insert_is_zero_del_two_empty_lines() {
        let cs = parse(r#"[1,[0,"",""],1]"#);
        assert_eq!(apply("ab", 2, &cs).unwrap().text, "a\nb");
        assert_eq!(replace_diff("ab", "a\nb"), cs);
        assert_eq!(apply("", 0, &parse(r#"[[0,"",""]]"#)).unwrap().text, "\n");
    }

    #[test]
    fn update_tolerates_and_drops_effects() {
        let update: UpdateJson = serde_json::from_str(
            r#"{"clientID":"c1","changes":[[0,"hi"]],"effects":["opaque",1]}"#,
        )
        .unwrap();
        assert_eq!(update.client_id, "c1");
        assert_eq!(
            serde_json::to_string(&update).unwrap(),
            r#"{"clientID":"c1","changes":[[0,"hi"]]}"#
        );
    }

    // ---- applier ----

    #[test]
    fn applies_across_two_unit_chars() {
        // U+1F600: one char, four UTF-8 bytes, two UTF-16 units.
        let doc = "a\u{1f600}b";
        assert_eq!(utf16_len(doc), 4);
        let applied = apply(doc, 4, &parse(r#"[1,[2,"X"],1]"#)).unwrap();
        assert_eq!(applied.text, "aXb");
        assert_eq!(applied.len16, 3);
        assert_eq!(apply(doc, 4, &parse("[4]")).unwrap().text, doc);
    }

    #[test]
    fn applies_cjk_combining_and_zwj() {
        // CJK stays one unit each.
        let cjk = "\u{6f22}\u{5b57}";
        assert_eq!(utf16_len(cjk), 2);
        let applied = apply(cjk, 2, &parse(r#"[[1,"\u548c"],1]"#)).unwrap();
        assert_eq!(applied.text, "\u{548c}\u{5b57}");

        // A combining mark is its own unit and independently deletable.
        let accented = "e\u{301}";
        assert_eq!(utf16_len(accented), 2);
        assert_eq!(apply(accented, 2, &parse("[1,[1]]")).unwrap().text, "e");

        // ZWJ sequence: U+1F468 (2) + U+200D (1) + U+1F469 (2).
        let family = "\u{1f468}\u{200d}\u{1f469}";
        assert_eq!(utf16_len(family), 5);
        let applied = apply(family, 5, &parse("[2,[1],2]")).unwrap();
        assert_eq!(applied.text, "\u{1f468}\u{1f469}");
        assert_eq!(applied.len16, 4);
    }

    #[test]
    fn insert_spanning_newlines_delete_to_empty_insert_into_empty() {
        let applied = apply("", 0, &parse(r#"[[0,"l1","l2","l3"]]"#)).unwrap();
        assert_eq!(applied.text, "l1\nl2\nl3");
        assert_eq!(applied.len16, 8);
        assert_eq!(apply("abc", 3, &parse("[[3]]")).unwrap().text, "");
        assert_eq!(
            apply("", 0, &parse(r#"[[0,"hello"]]"#)).unwrap().text,
            "hello"
        );
        assert_eq!(apply("", 0, &parse("[]")).unwrap().text, "");
    }

    #[test]
    fn rejects_surrogate_splits() {
        let doc = "a\u{1f600}b"; // units: 'a' | high | low | 'b'
        assert_eq!(
            apply(doc, 4, &parse("[2,[1],1]")),
            Err(ApplyError::SplitSurrogate { at: 2 })
        );
        assert_eq!(
            apply(doc, 4, &parse("[1,[1],2]")),
            Err(ApplyError::SplitSurrogate { at: 2 })
        );
    }

    #[test]
    fn rejects_length_mismatch_both_directions() {
        assert_eq!(
            apply("abc", 3, &parse("[2]")),
            Err(ApplyError::LengthMismatch { span: 2, doc: 3 })
        );
        assert_eq!(
            apply("abc", 3, &parse("[4]")),
            Err(ApplyError::LengthMismatch { span: 4, doc: 3 })
        );
        // A section total that overflows u64 cannot span any document.
        let cs = ChangeSetJson {
            sections: vec![Section::Retain(u64::MAX), Section::Retain(u64::MAX)],
        };
        assert!(matches!(
            apply("abc", 3, &cs),
            Err(ApplyError::LengthMismatch { .. })
        ));
        // Stale cached length: the pre-check passes, the walk runs out
        // of document and reports the real length.
        assert_eq!(
            apply("a", 2, &parse("[2]")),
            Err(ApplyError::LengthMismatch { span: 2, doc: 1 })
        );
    }

    #[test]
    fn rejects_oversized_result() {
        let line = "x".repeat(chan_workspace::TEXT_WRITE_LIMIT as usize + 1);
        let cs = ChangeSetJson {
            sections: vec![Section::Edit {
                del: 0,
                lines: vec![line],
            }],
        };
        assert!(matches!(
            apply("", 0, &cs),
            Err(ApplyError::DocTooLarge { .. })
        ));
    }

    #[test]
    fn apply_all_is_all_or_nothing() {
        let updates: Vec<UpdateJson> = serde_json::from_str(
            r#"[{"clientID":"c1","changes":[[0,"ab"]]},{"clientID":"c2","changes":[1,[1,"X"]]}]"#,
        )
        .unwrap();
        let applied = apply_all("", 0, &updates).unwrap();
        assert_eq!(applied.text, "aX");
        assert_eq!(applied.len16, 2);

        // The second update's span does not match the doc the first
        // produces, so the whole batch fails.
        let updates: Vec<UpdateJson> = serde_json::from_str(
            r#"[{"clientID":"c1","changes":[[0,"ab"]]},{"clientID":"c1","changes":[9]}]"#,
        )
        .unwrap();
        assert_eq!(
            apply_all("", 0, &updates),
            Err(ApplyError::LengthMismatch { span: 9, doc: 2 })
        );
    }

    // ---- replace_diff ----

    #[test]
    fn replace_diff_emits_trimmed_retain_edit_retain() {
        assert_eq!(
            replace_diff("abc", "abc").sections,
            vec![Section::Retain(3)]
        );
        assert_eq!(replace_diff("", ""), ChangeSetJson::default());
        assert_eq!(replace_diff("ab", "aXb"), parse(r#"[1,[0,"X"],1]"#));
        assert_eq!(replace_diff("aXb", "ab"), parse("[1,[1],1]"));
        assert_eq!(replace_diff("aa", "a"), parse("[1,[1]]"));
    }

    #[test]
    fn replace_diff_backs_off_to_char_boundaries() {
        // e-acute vs e-grave share their first UTF-8 byte; the trim
        // must not stop inside the char.
        let cs = replace_diff("a\u{e9}b", "a\u{e8}b");
        assert_eq!(
            cs.sections,
            vec![
                Section::Retain(1),
                Section::Edit {
                    del: 1,
                    lines: vec!["\u{e8}".into()],
                },
                Section::Retain(1),
            ]
        );

        // Two emoji sharing three of four UTF-8 bytes: the whole char
        // is replaced, never a byte prefix.
        let cs = replace_diff("\u{1f600}", "\u{1f601}");
        assert_eq!(
            cs.sections,
            vec![Section::Edit {
                del: 2,
                lines: vec!["\u{1f601}".into()],
            }]
        );

        // Common multibyte suffix is retained whole.
        let cs = replace_diff("x\u{1f600}", "y\u{1f600}");
        assert_eq!(
            cs.sections,
            vec![
                Section::Edit {
                    del: 1,
                    lines: vec!["y".into()],
                },
                Section::Retain(2),
            ]
        );
    }

    // ---- seeded randomized cross-check ----

    /// Deterministic xorshift64* so the randomized suites stay
    /// reproducible with zero new dependencies.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// ASCII, Latin-1, CJK, combining mark, ZWJ, and three astral
    /// (two-unit) chars, plus newlines to exercise line splitting.
    const POOL: &[char] = &[
        'a',
        'b',
        'Z',
        '0',
        ' ',
        '\n',
        '\t',
        '\u{e9}',
        '\u{6f22}',
        '\u{301}',
        '\u{200d}',
        '\u{1f600}',
        '\u{1f469}',
        '\u{1d54f}',
    ];

    fn random_string(rng: &mut Rng, max_chars: usize) -> String {
        let len = rng.below(max_chars + 1);
        (0..len).map(|_| POOL[rng.below(POOL.len())]).collect()
    }

    fn random_lines(rng: &mut Rng) -> Vec<String> {
        random_string(rng, 6)
            .split('\n')
            .map(str::to_owned)
            .collect()
    }

    /// Random change set with char-aligned section boundaries, so it is
    /// always valid against `doc`.
    fn random_changeset(rng: &mut Rng, doc: &str) -> ChangeSetJson {
        let chars: Vec<char> = doc.chars().collect();
        let mut sections = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            let take = 1 + rng.below((chars.len() - i).min(5));
            let seg16 = chars[i..i + take]
                .iter()
                .map(|c| c.len_utf16() as u64)
                .sum();
            i += take;
            sections.push(match rng.below(3) {
                0 => Section::Retain(seg16),
                1 => Section::Edit {
                    del: seg16,
                    lines: vec![],
                },
                _ => Section::Edit {
                    del: seg16,
                    lines: random_lines(rng),
                },
            });
        }
        if rng.below(3) == 0 {
            sections.push(Section::Edit {
                del: 0,
                lines: random_lines(rng),
            });
        }
        ChangeSetJson { sections }
    }

    /// Naive reference applier: the document as raw UTF-16 units,
    /// sections applied by unit counts alone.
    fn reference_apply(doc: &str, cs: &ChangeSetJson) -> Vec<u16> {
        let units: Vec<u16> = doc.encode_utf16().collect();
        let mut out = Vec::new();
        let mut idx = 0usize;
        for section in &cs.sections {
            match section {
                Section::Retain(n) => {
                    out.extend_from_slice(&units[idx..idx + *n as usize]);
                    idx += *n as usize;
                }
                Section::Edit { del, lines } => {
                    idx += *del as usize;
                    out.extend(lines.join("\n").encode_utf16());
                }
            }
        }
        assert_eq!(idx, units.len(), "generated sections must span the doc");
        out
    }

    #[test]
    fn randomized_apply_matches_utf16_reference() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..500 {
            let doc = random_string(&mut rng, 40);
            let cs = random_changeset(&mut rng, &doc);
            let expected = reference_apply(&doc, &cs);
            let applied = apply(&doc, utf16_len(&doc), &cs).expect("valid random set applies");
            assert_eq!(applied.text.encode_utf16().collect::<Vec<u16>>(), expected);
            assert_eq!(applied.len16, utf16_len(&applied.text));

            let json = serde_json::to_string(&cs).unwrap();
            assert_eq!(serde_json::from_str::<ChangeSetJson>(&json).unwrap(), cs);
        }
    }

    #[test]
    fn randomized_replace_diff_round_trips() {
        let mut rng = Rng(0x0123_4567_89ab_cdef);
        for _ in 0..500 {
            let old = random_string(&mut rng, 40);
            let new = random_string(&mut rng, 40);
            let cs = replace_diff(&old, &new);
            let applied = apply(&old, utf16_len(&old), &cs).expect("replace_diff applies");
            assert_eq!(applied.text, new);
            assert_eq!(applied.len16, utf16_len(&new));
        }
    }
}
