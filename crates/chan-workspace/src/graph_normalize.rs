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

    for candidate in &candidates {
        for path in [
            candidate.clone(),
            format!("{candidate}.md"),
            format!("{candidate}.txt"),
        ] {
            if files.contains(path.as_str()) {
                return path;
            }
        }
    }
    decoded
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
}
