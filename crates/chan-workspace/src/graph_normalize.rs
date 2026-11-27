//! Read-time normalization for graph relationships.
//!
//! Graph rows preserve the authored link and mention spelling. Consumers use
//! these helpers to project those rows onto canonical workspace entity IDs
//! without mutating the graph database.

use std::borrow::Borrow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use percent_encoding::percent_decode_str;

use crate::{ContactNode, Edge, EdgeKind};

/// Every contact candidate for one mention plus the selected winner.
///
/// Candidates retain `GraphView::contacts()` order. The selected path is the
/// final candidate, matching the graph projection's last-writer rule when
/// contact basenames or aliases collide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionContactResolution {
    /// Canonical contact paths in `GraphView::contacts()` order.
    pub candidates: Vec<String>,
    /// Compatibility-selected path, or `None` when no contact matches.
    pub selected: Option<String>,
}

/// Reusable mention-to-contact lookup built from graph contact rows.
#[derive(Debug, Clone, Default)]
pub struct MentionContactResolver {
    candidates: BTreeMap<String, Vec<String>>,
}

impl MentionContactResolver {
    /// Build a lookup from contact basename stems and declared aliases.
    pub fn new(contacts: &[ContactNode]) -> Self {
        let mut resolver = Self::default();
        for contact in contacts {
            if let Some(stem) = Path::new(&contact.rel_path)
                .file_stem()
                .and_then(|value| value.to_str())
            {
                resolver.insert(stem, &contact.rel_path);
            }
            for alias in &contact.aliases {
                resolver.insert(alias.trim(), &contact.rel_path);
            }
        }
        resolver
    }

    /// Resolve a bare or `@@`-prefixed mention without choosing ambiguities silently.
    pub fn resolve(&self, mention: &str) -> MentionContactResolution {
        let key = mention.strip_prefix("@@").unwrap_or(mention).to_lowercase();
        let candidates = self.candidates.get(&key).cloned().unwrap_or_default();
        let selected = candidates.last().cloned();
        MentionContactResolution {
            candidates,
            selected,
        }
    }

    fn insert(&mut self, name: &str, path: &str) {
        if name.is_empty() {
            return;
        }
        let candidates = self.candidates.entry(name.to_lowercase()).or_default();
        if !candidates.iter().any(|candidate| candidate == path) {
            candidates.push(path.to_string());
        }
    }
}

/// Metadata collected while graph rows are normalized for a projection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphNormalization {
    /// Contact paths selected by at least one normalized mention edge.
    pub referenced_contact_paths: BTreeSet<String>,
    /// Resolution details keyed by the authored mention destination.
    pub mention_resolutions: BTreeMap<String, MentionContactResolution>,
}

/// Normalize authored link and mention destinations onto graph entity IDs.
pub fn normalize_graph_edges<T>(
    edges: &mut [Edge],
    files: &BTreeSet<T>,
    contacts: &[ContactNode],
) -> GraphNormalization
where
    T: Borrow<str> + Ord,
{
    let resolver = MentionContactResolver::new(contacts);
    let mut normalization = GraphNormalization::default();
    for edge in edges {
        match edge.kind {
            EdgeKind::Link => {
                edge.dst = resolve_link_target(&edge.src, &edge.dst, files);
            }
            EdgeKind::Mention => {
                let authored = edge.dst.clone();
                let resolution = resolver.resolve(&authored);
                if let Some(path) = &resolution.selected {
                    edge.dst = path.clone();
                    normalization.referenced_contact_paths.insert(path.clone());
                }
                normalization
                    .mention_resolutions
                    .entry(authored)
                    .or_insert(resolution);
            }
            EdgeKind::Tag => {}
        }
    }
    normalization
}

/// Resolve an authored link target against existing workspace files.
///
/// Resolution checks the workspace-rooted target first, then the source
/// directory and each ancestor. Each candidate tries exact, `.md`, and `.txt`
/// forms. An unresolved target is returned percent-decoded for diagnostics.
pub fn resolve_link_target<T>(src: &str, target: &str, files: &BTreeSet<T>) -> String
where
    T: Borrow<str> + Ord,
{
    LinkSpellings::new(src, target).resolve(|path| files.contains(path))
}

/// The suffixes each candidate of a link is tried with, in order.
const FORM_SUFFIXES: [&str; 3] = ["", ".md", ".txt"];

/// The spellings a link target resolves through, in the order
/// [`resolve_link_target`] tries them, for a caller that asks whether a
/// spelling names a file one spelling at a time instead of holding every
/// file in a set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpellings {
    /// The target percent-decoded, answered when no spelling names a file.
    decoded: String,
    /// The workspace-rooted target, then the target joined to the source's
    /// directory and to each directory above it.
    candidates: Vec<String>,
}

impl LinkSpellings {
    /// The spellings of `target` as the link in the file `src` stores it.
    pub fn new(src: &str, target: &str) -> Self {
        let decoded = percent_decode_str(target).decode_utf8_lossy().into_owned();
        let stripped = decoded.trim_start_matches('/');

        let mut candidates = vec![stripped.to_string()];
        let mut base = Path::new(src).parent();
        while let Some(dir) = base {
            if !dir.as_os_str().is_empty() {
                if let Some(normalized) = normalize_workspace_rel(&dir.join(stripped)) {
                    candidates.push(normalized);
                }
            }
            base = dir.parent();
        }
        Self {
            decoded,
            candidates,
        }
    }

    /// The first spelling that `is_file` accepts, asking in resolution
    /// order and stopping there, or the decoded target when it accepts none.
    pub fn resolve(self, mut is_file: impl FnMut(&str) -> bool) -> String {
        for candidate in &self.candidates {
            for path in FORM_SUFFIXES.map(|suffix| format!("{candidate}{suffix}")) {
                if is_file(&path) {
                    return path;
                }
            }
        }
        self.decoded
    }

    /// Whether [`resolve`](Self::resolve) with the same `is_file` answers
    /// `path`, asking `is_file` of as few spellings as that takes.
    ///
    /// A link whose spellings and decoded target all differ from `path`
    /// cannot answer it, and `is_file` is not asked at all. Otherwise it is
    /// asked in resolution order, of the spellings before `path` and of
    /// `path`; past `path` only when `path` names no file and is the decoded
    /// target, since only then can the link still answer it. `is_file` must
    /// give one answer per spelling.
    pub fn resolves_to(&self, path: &str, mut is_file: impl FnMut(&str) -> bool) -> bool {
        if !self.may_name(path) {
            return false;
        }
        for candidate in &self.candidates {
            for spelling in FORM_SUFFIXES.map(|suffix| format!("{candidate}{suffix}")) {
                if is_file(&spelling) {
                    return spelling == path;
                }
                if spelling == path && self.decoded != path {
                    return false;
                }
            }
        }
        self.decoded == path
    }

    /// Whether `path` is one of the spellings or the decoded target, read
    /// from the strings alone.
    fn may_name(&self, path: &str) -> bool {
        self.decoded == path
            || self.candidates.iter().any(|candidate| {
                FORM_SUFFIXES
                    .iter()
                    .any(|suffix| path.strip_suffix(suffix) == Some(candidate.as_str()))
            })
    }
}

fn normalize_workspace_rel(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contact(path: &str, aliases: &[&str]) -> ContactNode {
        ContactNode {
            rel_path: path.to_string(),
            basename: Path::new(path)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            title: None,
            emails: Vec::new(),
            aliases: aliases.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    #[test]
    fn mention_resolution_keeps_collision_candidates_and_compatibility_winner() {
        let contacts = [
            contact("contacts/alice.md", &["shared"]),
            contact("people/shared.md", &[]),
            contact("contacts/bob.md", &["shared"]),
        ];
        let resolver = MentionContactResolver::new(&contacts);

        assert_eq!(
            resolver.resolve("@@shared"),
            MentionContactResolution {
                candidates: vec![
                    "contacts/alice.md".to_string(),
                    "people/shared.md".to_string(),
                    "contacts/bob.md".to_string(),
                ],
                selected: Some("contacts/bob.md".to_string()),
            }
        );
    }

    #[test]
    fn graph_normalization_rewrites_links_and_mentions() {
        let files = BTreeSet::from([
            "contacts/alice.md".to_string(),
            "notes/intro.md".to_string(),
            "notes/my note.md".to_string(),
        ]);
        let contacts = [contact("contacts/alice.md", &["ali"])];
        let mut edges = [
            Edge {
                src: "notes/intro.md".to_string(),
                dst: "my%20note.md".to_string(),
                kind: EdgeKind::Link,
                anchor: None,
            },
            Edge {
                src: "notes/intro.md".to_string(),
                dst: "@@ali".to_string(),
                kind: EdgeKind::Mention,
                anchor: None,
            },
        ];

        let normalized = normalize_graph_edges(&mut edges, &files, &contacts);

        assert_eq!(edges[0].dst, "notes/my note.md");
        assert_eq!(edges[1].dst, "contacts/alice.md");
        assert_eq!(
            normalized.referenced_contact_paths,
            BTreeSet::from(["contacts/alice.md".to_string()])
        );
    }

    /// What `resolves_to(path)` answers when `files` are the files, and the
    /// spellings it asks of them, in order.
    fn asked(spellings: &LinkSpellings, path: &str, files: &[&str]) -> (bool, Vec<String>) {
        let mut asked = Vec::new();
        let answer = spellings.resolves_to(path, |spelling| {
            asked.push(spelling.to_string());
            files.contains(&spelling)
        });
        (answer, asked)
    }

    #[test]
    fn link_spellings_resolve_to_what_resolve_answers() {
        let cases: [(&str, &str, &[&str]); 12] = [
            ("notes/sub/deep.md", "beside.log", &["notes/sub/beside.log"]),
            ("notes/sub/deep.md", "up.log", &["notes/up.log", "up.log"]),
            ("notes/sub/deep.md", "up.log", &["notes/up.log"]),
            ("notes/a.md", "todo", &["todo.txt"]),
            ("top.md", "docs/leaf", &["docs/leaf", "docs/leaf.md"]),
            ("top.md", "docs/leaf", &["docs/leaf.md"]),
            ("notes/a.md", "my%20note.md", &["notes/my note.md"]),
            ("notes/a.md", "/LICENSE", &[]),
            ("notes/a.md", "/LICENSE", &["LICENSE"]),
            ("notes/a.md", "%2e%2e/outside.log", &["outside.log"]),
            ("a/b/c.md", "../x", &["a/x", "x"]),
            ("notes/a.md", "gone.log", &[]),
        ];
        for (src, target, files) in cases {
            let spellings = LinkSpellings::new(src, target);
            let resolved = spellings.clone().resolve(|path| files.contains(&path));
            assert_eq!(
                resolved,
                resolve_link_target(src, target, &files.iter().copied().collect::<BTreeSet<_>>()),
                "{src} links {target} with {files:?}"
            );
            let mut probes: Vec<String> = spellings
                .candidates
                .iter()
                .flat_map(|candidate| FORM_SUFFIXES.map(|suffix| format!("{candidate}{suffix}")))
                .collect();
            probes.push(spellings.decoded.clone());
            probes.push("unrelated.md".to_string());
            for probe in probes {
                assert_eq!(
                    asked(&spellings, &probe, files).0,
                    resolved == probe,
                    "{src} links {target} with {files:?}: resolves to {probe}?"
                );
            }
        }
    }

    #[test]
    fn link_spellings_ask_only_the_spellings_that_decide() {
        let spellings = LinkSpellings::new("notes/sub/deep.md", "up.log");
        let tried = [
            "up.log",
            "up.log.md",
            "up.log.txt",
            "notes/sub/up.log",
            "notes/sub/up.log.md",
            "notes/sub/up.log.txt",
            "notes/up.log",
            "notes/up.log.md",
            "notes/up.log.txt",
        ]
        .map(String::from);

        assert_eq!(
            asked(&spellings, "docs/up.log", &["notes/up.log"]),
            (false, vec![]),
            "a path no spelling names asks nothing"
        );
        assert_eq!(
            asked(&spellings, "notes/sub/up.log", &["notes/up.log"]),
            (false, tried[..4].to_vec()),
            "a spelling that names no file, and is not the decoded target, asks none past it"
        );
        assert_eq!(
            asked(&spellings, "notes/up.log", &["notes/up.log"]),
            (true, tried[..7].to_vec()),
            "the spellings before the one that names a file are asked first"
        );
        assert_eq!(
            asked(&spellings, "up.log", &[]),
            (true, tried.to_vec()),
            "the decoded target is answered when no spelling names a file"
        );
        assert_eq!(
            asked(&spellings, "up.log", &["notes/up.log"]),
            (false, tried[..7].to_vec()),
            "past the decoded target, a later spelling that names a file decides"
        );
    }
}
