//! Bounded workspace-local retrieval and graph traversal.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::{
    classify, normalize_graph_edges, ContactNode, Edge, EdgeKind, FileClass, Hit, Report, Result,
    SearchMode, SearchOpts, Workspace, WorkspaceReadiness,
};

const DEFAULT_LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 100;
const DEFAULT_NODE_LIMIT: u32 = 100;
const MAX_NODE_LIMIT: u32 = 1_000;
const DEFAULT_EDGE_LIMIT: u32 = 250;
const MAX_EDGE_LIMIT: u32 = 2_500;
const MAX_DEPTH: u8 = 10;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSearchRequest {
    pub query: Option<String>,
    pub from: Vec<WorkspaceSelector>,
    pub domains: Vec<WorkspaceSearchDomain>,
    pub depth: Option<u8>,
    pub direction: WorkspaceTraversalDirection,
    pub relationship_kinds: Vec<WorkspaceRelationshipKind>,
    pub limit: Option<u32>,
    pub node_limit: Option<u32>,
    pub edge_limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceSelector {
    pub kind: WorkspaceSelectorKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSelectorKind {
    File,
    Directory,
    Tag,
    Mention,
    Contact,
    Language,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSearchDomain {
    Content,
    File,
    Directory,
    Tag,
    Mention,
    Contact,
    Language,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceTraversalDirection {
    #[default]
    Auto,
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRelationshipKind {
    Link,
    Tag,
    Mention,
    Language,
    Contains,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSearchResult {
    pub workspace: WorkspaceSearchIdentity,
    #[serde(default)]
    pub readiness: WorkspaceReadiness,
    pub search: WorkspaceSearchStatus,
    pub content_hits: Vec<WorkspaceContentHit>,
    pub entity_matches: Vec<WorkspaceEntityMatch>,
    pub nodes: Vec<WorkspaceGraphNode>,
    pub relationships: Vec<WorkspaceRelationship>,
    pub traversal: EffectiveWorkspaceTraversal,
    pub truncation: WorkspaceSearchTruncation,
    pub warnings: Vec<WorkspaceSearchWarning>,
    pub errors: Vec<WorkspaceSearchError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSearchIdentity {
    pub root: String,
    pub metadata_key: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSearchStatus {
    pub requested: bool,
    pub ready: bool,
    pub mode: EffectiveSearchMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveSearchMode {
    NotRun,
    Bm25,
    Hybrid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceContentHit {
    pub path: String,
    pub chunk_id: String,
    pub heading: String,
    pub start_line: u64,
    pub snippet: String,
    pub score: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEntityMatchClass {
    Exact,
    Prefix,
    Substring,
    Browse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEntityMatch {
    pub id: String,
    pub kind: WorkspaceSelectorKind,
    pub label: String,
    pub selector: WorkspaceSelector,
    pub match_class: WorkspaceEntityMatchClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_lines: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceGraphFileClass {
    Markdown,
    Text,
    Source,
    Media,
    Binary,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceGraphNode {
    File {
        id: String,
        label: String,
        path: String,
        class: WorkspaceGraphFileClass,
    },
    Directory {
        id: String,
        label: String,
        path: String,
    },
    Tag {
        id: String,
        label: String,
        name: String,
        reference_count: u64,
    },
    Mention {
        id: String,
        label: String,
        name: String,
        reference_count: u64,
    },
    Contact {
        id: String,
        label: String,
        path: String,
        basename: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        emails: Vec<String>,
        aliases: Vec<String>,
    },
    Language {
        id: String,
        label: String,
        language: String,
        file_count: u64,
        code_lines: u64,
    },
}

impl WorkspaceGraphNode {
    fn id(&self) -> &str {
        match self {
            Self::File { id, .. }
            | Self::Directory { id, .. }
            | Self::Tag { id, .. }
            | Self::Mention { id, .. }
            | Self::Contact { id, .. }
            | Self::Language { id, .. } => id,
        }
    }

    fn kind_order(&self) -> u8 {
        match self {
            Self::File { .. } => 0,
            Self::Directory { .. } => 1,
            Self::Tag { .. } => 2,
            Self::Mention { .. } => 3,
            Self::Contact { .. } => 4,
            Self::Language { .. } => 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceRelationship {
    pub source: String,
    pub target: String,
    pub kind: WorkspaceRelationshipKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveWorkspaceTraversal {
    pub depth: u8,
    pub direction: WorkspaceTraversalDirection,
    pub relationship_kinds: Vec<WorkspaceRelationshipKind>,
    pub spine_forced: bool,
    pub profiles: Vec<WorkspaceTraversalProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceTraversalProfile {
    pub selector: WorkspaceSelector,
    pub node_id: String,
    pub depth: u8,
    pub direction: WorkspaceTraversalDirection,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSearchTruncation {
    pub content_hits: bool,
    pub content_hits_observed: u32,
    pub entity_matches: bool,
    pub entity_matches_observed: u32,
    pub graph_nodes: bool,
    pub graph_nodes_observed: u32,
    pub graph_edges: bool,
    pub graph_edges_observed: u32,
    pub frontier_stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum WorkspaceSearchWarning {
    LimitClamped {
        field: String,
        requested: u32,
        effective: u32,
        message: String,
    },
    ReportsDisabled {
        message: String,
    },
    ReportsUnavailable {
        message: String,
    },
    HybridUnavailable {
        message: String,
    },
    MissingLinkTarget {
        target: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum WorkspaceSearchError {
    InvalidRequest {
        message: String,
    },
    InvalidSelector {
        selector: WorkspaceSelector,
        message: String,
    },
    SelectorNotFound {
        selector: WorkspaceSelector,
        message: String,
    },
    AmbiguousSelector {
        selector: WorkspaceSelector,
        candidates: Vec<WorkspaceSelector>,
        message: String,
    },
    IndexNotReady {
        message: String,
    },
    DomainUnavailable {
        domain: WorkspaceSearchDomain,
        message: String,
    },
}

#[derive(Debug, Clone)]
struct NormalizedRequest {
    query: Option<String>,
    from: Vec<WorkspaceSelector>,
    domains: Vec<WorkspaceSearchDomain>,
    depth: u8,
    direction: WorkspaceTraversalDirection,
    relationship_kinds: Vec<WorkspaceRelationshipKind>,
    limit: u32,
    node_limit: u32,
    edge_limit: u32,
}

impl Workspace {
    pub fn effective_search_mode(&self) -> Result<EffectiveSearchMode> {
        if !self.semantic_enabled()? {
            return Ok(EffectiveSearchMode::Bm25);
        }
        #[cfg(feature = "embeddings")]
        {
            let config = crate::index::config::load(&self.paths().index)
                .map_err(|error| crate::ChanError::Search(error.to_string()))?;
            if crate::index::embeddings::resolve_model(&config.model).is_ok() {
                return Ok(EffectiveSearchMode::Hybrid);
            }
        }
        Ok(EffectiveSearchMode::Bm25)
    }

    pub fn workspace_search(
        &self,
        request: &WorkspaceSearchRequest,
    ) -> Result<WorkspaceSearchResult> {
        let identity = WorkspaceSearchIdentity {
            root: self.canonical_root().display().to_string(),
            metadata_key: self.metadata_key().to_string(),
            display_name: self.display_name(),
        };
        let (normalized, mut warnings, mut errors) = normalize_request(request);
        let readiness = self.readiness();
        let mut result = WorkspaceSearchResult {
            workspace: identity,
            readiness,
            search: WorkspaceSearchStatus {
                requested: false,
                ready: true,
                mode: EffectiveSearchMode::NotRun,
            },
            content_hits: Vec::new(),
            entity_matches: Vec::new(),
            nodes: Vec::new(),
            relationships: Vec::new(),
            traversal: EffectiveWorkspaceTraversal {
                depth: normalized.depth,
                direction: normalized.direction,
                relationship_kinds: normalized.relationship_kinds.clone(),
                spine_forced: false,
                profiles: Vec::new(),
            },
            truncation: WorkspaceSearchTruncation::default(),
            warnings: Vec::new(),
            errors: Vec::new(),
        };
        if !readiness.is_ready() {
            result.search.ready = false;
            errors.push(WorkspaceSearchError::IndexNotReady {
                message: "workspace derived state is recovering".into(),
            });
            result.warnings = warnings;
            result.errors = errors;
            return Ok(result);
        }
        if !errors.is_empty() {
            result.warnings = warnings;
            result.errors = errors;
            return Ok(result);
        }

        let catalog = Catalog::load(self)?;
        let language_requested = normalized
            .domains
            .contains(&WorkspaceSearchDomain::Language)
            || normalized
                .from
                .iter()
                .any(|selector| selector.kind == WorkspaceSelectorKind::Language)
            || normalized
                .relationship_kinds
                .contains(&WorkspaceRelationshipKind::Language);
        if language_requested && catalog.report.is_none() {
            if catalog.reports_enabled {
                push_unique(
                    &mut warnings,
                    WorkspaceSearchWarning::ReportsUnavailable {
                        message: "workspace report data is not available without a scan".into(),
                    },
                );
            } else {
                push_unique(
                    &mut warnings,
                    WorkspaceSearchWarning::ReportsDisabled {
                        message: "workspace reports are disabled".into(),
                    },
                );
            }
        }

        if normalized.domains.contains(&WorkspaceSearchDomain::Content)
            && normalized.query.is_some()
        {
            run_content_search(self, &normalized, &mut result, &mut warnings, &mut errors)?;
        }
        let (entity_matches, observed) = match_entities(&catalog, &normalized);
        result.truncation.entity_matches_observed = observed as u32;
        result.truncation.entity_matches = observed > normalized.limit as usize;
        result.entity_matches = entity_matches;

        let seeds = resolve_seeds(
            &catalog,
            &normalized,
            &result.content_hits,
            &result.entity_matches,
            &mut errors,
        );
        let mut traversal = TraversalBuilder::new(
            self,
            &catalog,
            normalized.node_limit,
            normalized.edge_limit,
            &mut warnings,
        );
        for seed in seeds {
            traverse_seed(&mut traversal, &normalized, seed)?;
        }
        traversal.retain_induced_relationships(&normalized.relationship_kinds, normalized.depth)?;
        let (nodes, relationships, profiles, traversal_truncation, spine_forced) =
            traversal.finish();
        result.nodes = nodes;
        result.relationships = relationships;
        result.traversal.profiles = profiles;
        result.traversal.spine_forced = spine_forced;
        result.truncation.graph_nodes = traversal_truncation.graph_nodes;
        result.truncation.graph_nodes_observed = traversal_truncation.graph_nodes_observed;
        result.truncation.graph_edges = traversal_truncation.graph_edges;
        result.truncation.graph_edges_observed = traversal_truncation.graph_edges_observed;
        result.truncation.frontier_stopped = traversal_truncation.frontier_stopped;
        let final_readiness = self.readiness();
        if !final_readiness.is_ready() {
            result.readiness = final_readiness;
            result.search.ready = false;
            result.content_hits.clear();
            result.entity_matches.clear();
            result.nodes.clear();
            result.relationships.clear();
            result.traversal.profiles.clear();
            result.traversal.spine_forced = false;
            result.truncation = WorkspaceSearchTruncation::default();
            errors.push(WorkspaceSearchError::IndexNotReady {
                message: "workspace derived state entered recovery during the query".into(),
            });
        } else {
            result.readiness = final_readiness;
        }
        result.warnings = warnings;
        result.errors = errors;
        Ok(result)
    }
}

fn normalize_request(
    request: &WorkspaceSearchRequest,
) -> (
    NormalizedRequest,
    Vec<WorkspaceSearchWarning>,
    Vec<WorkspaceSearchError>,
) {
    let mut warnings = Vec::new();
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let from = dedup_preserving(&request.from);
    let mut domains = dedup_preserving(&request.domains);
    if domains.is_empty() && query.is_some() {
        domains = all_domains();
    }
    let relationship_kinds = if request.relationship_kinds.is_empty() {
        all_relationship_kinds()
    } else {
        dedup_preserving(&request.relationship_kinds)
    };
    let depth_requested = request.depth.unwrap_or(if from.is_empty() { 0 } else { 1 });
    let depth = depth_requested.min(MAX_DEPTH);
    if depth_requested > MAX_DEPTH {
        warnings.push(clamped("depth", depth_requested as u32, depth as u32));
    }
    let limit = normalize_limit(
        "limit",
        request.limit,
        DEFAULT_LIMIT,
        MAX_LIMIT,
        &mut warnings,
    );
    let node_limit = normalize_limit(
        "node_limit",
        request.node_limit,
        DEFAULT_NODE_LIMIT,
        MAX_NODE_LIMIT,
        &mut warnings,
    );
    let edge_limit = normalize_limit(
        "edge_limit",
        request.edge_limit,
        DEFAULT_EDGE_LIMIT,
        MAX_EDGE_LIMIT,
        &mut warnings,
    );
    let valid_browse = domains
        .iter()
        .any(|domain| *domain != WorkspaceSearchDomain::Content);
    let mut errors = Vec::new();
    if query.is_none() && from.is_empty() && !valid_browse {
        errors.push(WorkspaceSearchError::InvalidRequest {
            message: "workspace search requires a query, selector, or non-content browse domain"
                .into(),
        });
    }
    (
        NormalizedRequest {
            query,
            from,
            domains,
            depth,
            direction: request.direction,
            relationship_kinds,
            limit,
            node_limit,
            edge_limit,
        },
        warnings,
        errors,
    )
}

fn normalize_limit(
    field: &str,
    requested: Option<u32>,
    default: u32,
    max: u32,
    warnings: &mut Vec<WorkspaceSearchWarning>,
) -> u32 {
    let value = requested.filter(|value| *value > 0).unwrap_or(default);
    let effective = value.min(max);
    if value > max {
        warnings.push(clamped(field, value, effective));
    }
    effective
}

fn clamped(field: &str, requested: u32, effective: u32) -> WorkspaceSearchWarning {
    WorkspaceSearchWarning::LimitClamped {
        field: field.to_string(),
        requested,
        effective,
        message: format!("{field} was clamped from {requested} to {effective}"),
    }
}

fn dedup_preserving<T>(values: &[T]) -> Vec<T>
where
    T: Clone + Eq + std::hash::Hash,
{
    let mut seen = HashSet::new();
    values
        .iter()
        .filter(|value| seen.insert((*value).clone()))
        .cloned()
        .collect()
}

fn all_domains() -> Vec<WorkspaceSearchDomain> {
    vec![
        WorkspaceSearchDomain::Content,
        WorkspaceSearchDomain::File,
        WorkspaceSearchDomain::Directory,
        WorkspaceSearchDomain::Tag,
        WorkspaceSearchDomain::Mention,
        WorkspaceSearchDomain::Contact,
        WorkspaceSearchDomain::Language,
    ]
}

fn all_relationship_kinds() -> Vec<WorkspaceRelationshipKind> {
    vec![
        WorkspaceRelationshipKind::Link,
        WorkspaceRelationshipKind::Tag,
        WorkspaceRelationshipKind::Mention,
        WorkspaceRelationshipKind::Language,
        WorkspaceRelationshipKind::Contains,
    ]
}

fn run_content_search(
    workspace: &Workspace,
    request: &NormalizedRequest,
    result: &mut WorkspaceSearchResult,
    warnings: &mut Vec<WorkspaceSearchWarning>,
    errors: &mut Vec<WorkspaceSearchError>,
) -> Result<()> {
    result.search.requested = true;
    if workspace.needs_rebuild() || workspace.is_reindexing() {
        result.search.ready = false;
        errors.push(WorkspaceSearchError::IndexNotReady {
            message: "workspace search index is rebuilding".into(),
        });
        return Ok(());
    }
    let mode = workspace.effective_search_mode()?;
    result.search.mode = mode;
    if mode == EffectiveSearchMode::Bm25 && workspace.semantic_enabled()? {
        push_unique(
            warnings,
            WorkspaceSearchWarning::HybridUnavailable {
                message:
                    "semantic search is enabled but the configured model is unavailable; using BM25"
                        .into(),
            },
        );
    }
    let query = request.query.as_deref().expect("content search has query");
    let expanded = request.limit.saturating_mul(8).min(request.limit.max(200));
    let search = workspace.search(
        query,
        &SearchOpts {
            mode: match mode {
                EffectiveSearchMode::Hybrid => SearchMode::Hybrid,
                EffectiveSearchMode::NotRun | EffectiveSearchMode::Bm25 => SearchMode::Bm25,
            },
            limit: expanded,
            scope: None,
        },
    )?;
    result.search.ready = search.ready;
    let mut hits = search.hits;
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.chunk_id.cmp(&right.chunk_id))
    });
    let mut seen = BTreeSet::new();
    let mut collapsed = Vec::new();
    for hit in hits {
        if seen.insert(hit.path.clone()) {
            collapsed.push(content_hit(hit));
        }
    }
    result.truncation.content_hits_observed = collapsed.len() as u32;
    result.truncation.content_hits = collapsed.len() > request.limit as usize;
    collapsed.truncate(request.limit as usize);
    result.content_hits = collapsed;
    Ok(())
}

fn content_hit(hit: Hit) -> WorkspaceContentHit {
    WorkspaceContentHit {
        path: hit.path,
        chunk_id: hit.chunk_id,
        heading: hit.heading,
        start_line: hit.start_line,
        snippet: hit.snippet,
        score: hit.score,
    }
}

#[derive(Debug)]
struct Catalog {
    files: BTreeSet<String>,
    directories: BTreeSet<String>,
    contacts: Vec<ContactNode>,
    contact_by_path: BTreeMap<String, ContactNode>,
    tags: BTreeMap<String, u64>,
    mentions: BTreeMap<String, u64>,
    report: Option<Report>,
    reports_enabled: bool,
}

impl Catalog {
    fn load(workspace: &Workspace) -> Result<Self> {
        let entries = workspace.list_tree_filtered_unified()?;
        let mut files = BTreeSet::new();
        let mut directories = BTreeSet::from([String::new()]);
        for entry in entries {
            if entry.is_dir {
                directories.insert(entry.path);
            } else {
                files.insert(entry.path);
            }
        }
        let graph = workspace.graph()?;
        let contacts = graph.contacts()?;
        let contact_by_path = contacts
            .iter()
            .cloned()
            .map(|contact| (contact.rel_path.clone(), contact))
            .collect();
        let tags = graph
            .tags()?
            .into_iter()
            .map(|tag| (tag.name, tag.count as u64))
            .collect();
        let mentions = graph
            .mentions()?
            .into_iter()
            .map(|mention| (mention.name, mention.count as u64))
            .collect();
        let reports_enabled = workspace.reports_enabled()?;
        let report = workspace.report_if_available()?;
        Ok(Self {
            files,
            directories,
            contacts,
            contact_by_path,
            tags,
            mentions,
            report,
            reports_enabled,
        })
    }

    fn language(&self, name: &str) -> Option<&crate::ReportLanguageStats> {
        self.report.as_ref()?.by_language.iter().find(|language| {
            language.name.eq_ignore_ascii_case(name)
                || format!("language:{}", language.name).eq_ignore_ascii_case(name)
        })
    }

    fn report_file(&self, path: &str) -> Option<&crate::ReportFileStats> {
        self.report
            .as_ref()?
            .files
            .iter()
            .find(|file| file.path == path)
    }
}

fn match_entities(
    catalog: &Catalog,
    request: &NormalizedRequest,
) -> (Vec<WorkspaceEntityMatch>, usize) {
    let mut matches = Vec::new();
    let query = request.query.as_deref();
    if request.domains.contains(&WorkspaceSearchDomain::File) {
        for path in catalog
            .files
            .iter()
            .filter(|path| !catalog.contact_by_path.contains_key(*path))
        {
            if let Some((class, field, value)) = match_fields(
                query,
                &[("path", path.as_str()), ("basename", basename(path))],
            ) {
                matches.push(entity_match(
                    path.clone(),
                    WorkspaceSelectorKind::File,
                    basename(path).to_string(),
                    path.clone(),
                    class,
                    field,
                    value,
                ));
            }
        }
    }
    if request.domains.contains(&WorkspaceSearchDomain::Directory) {
        for path in &catalog.directories {
            let cli_value = if path.is_empty() { "." } else { path };
            if let Some((class, field, value)) = match_fields(
                query,
                &[
                    ("path", cli_value),
                    ("basename", directory_label(path).as_str()),
                ],
            ) {
                matches.push(entity_match(
                    directory_id(path),
                    WorkspaceSelectorKind::Directory,
                    directory_label(path),
                    path.clone(),
                    class,
                    field,
                    value,
                ));
            }
        }
    }
    if request.domains.contains(&WorkspaceSearchDomain::Tag) {
        for (name, count) in &catalog.tags {
            let sigil = format!("#{name}");
            if let Some((class, field, value)) =
                match_fields(query, &[("name", name), ("sigil", sigil.as_str())])
            {
                let mut matched = entity_match(
                    sigil.clone(),
                    WorkspaceSelectorKind::Tag,
                    sigil,
                    name.clone(),
                    class,
                    field,
                    value,
                );
                matched.reference_count = Some(*count);
                matches.push(matched);
            }
        }
    }
    if request.domains.contains(&WorkspaceSearchDomain::Mention) {
        for (name, count) in &catalog.mentions {
            let sigil = format!("@@{name}");
            if let Some((class, field, value)) =
                match_fields(query, &[("name", name), ("sigil", sigil.as_str())])
            {
                let mut matched = entity_match(
                    sigil.clone(),
                    WorkspaceSelectorKind::Mention,
                    sigil,
                    name.clone(),
                    class,
                    field,
                    value,
                );
                matched.reference_count = Some(*count);
                matches.push(matched);
            }
        }
    }
    if request.domains.contains(&WorkspaceSearchDomain::Contact) {
        for contact in &catalog.contacts {
            let mut fields = vec![
                ("path", contact.rel_path.as_str()),
                ("basename", contact.basename.as_str()),
            ];
            if let Some(title) = &contact.title {
                fields.push(("title", title));
            }
            for email in &contact.emails {
                fields.push(("email", email));
            }
            for alias in &contact.aliases {
                fields.push(("alias", alias));
            }
            if let Some((class, field, value)) = match_fields(query, &fields) {
                let label = contact
                    .title
                    .clone()
                    .unwrap_or_else(|| contact.basename.clone());
                let mut matched = entity_match(
                    contact.rel_path.clone(),
                    WorkspaceSelectorKind::Contact,
                    label,
                    contact.rel_path.clone(),
                    class,
                    field,
                    value,
                );
                matched.path = Some(contact.rel_path.clone());
                matches.push(matched);
            }
        }
    }
    if request.domains.contains(&WorkspaceSearchDomain::Language) {
        if let Some(report) = &catalog.report {
            for language in &report.by_language {
                if let Some((class, field, value)) =
                    match_fields(query, &[("name", language.name.as_str())])
                {
                    let mut matched = entity_match(
                        format!("language:{}", language.name),
                        WorkspaceSelectorKind::Language,
                        language.name.clone(),
                        language.name.clone(),
                        class,
                        field,
                        value,
                    );
                    matched.file_count = Some(language.files);
                    matched.code_lines = Some(language.code);
                    matches.push(matched);
                }
            }
        }
    }
    if query.is_some() {
        matches.sort_by(|left, right| {
            match_class_order(left.match_class)
                .cmp(&match_class_order(right.match_class))
                .then_with(|| selector_kind_order(left.kind).cmp(&selector_kind_order(right.kind)))
                .then_with(|| left.id.cmp(&right.id))
        });
    } else {
        matches.sort_by(browse_order);
    }
    let observed = matches.len();
    matches.truncate(request.limit as usize);
    (matches, observed)
}

fn match_fields<'a>(
    query: Option<&str>,
    fields: &[(&'static str, &'a str)],
) -> Option<(WorkspaceEntityMatchClass, Option<String>, Option<String>)> {
    let Some(query) = query else {
        return Some((WorkspaceEntityMatchClass::Browse, None, None));
    };
    let query = query.to_lowercase();
    let mut best: Option<(u8, &'static str, &'a str)> = None;
    for (field, value) in fields {
        let folded = value.to_lowercase();
        let rank = if folded == query {
            0
        } else if folded.starts_with(&query) {
            1
        } else if folded.contains(&query) {
            2
        } else {
            continue;
        };
        if best.is_none_or(|current| rank < current.0) {
            best = Some((rank, *field, *value));
        }
    }
    best.map(|(rank, field, value)| {
        (
            match rank {
                0 => WorkspaceEntityMatchClass::Exact,
                1 => WorkspaceEntityMatchClass::Prefix,
                _ => WorkspaceEntityMatchClass::Substring,
            },
            Some(field.to_string()),
            Some(value.to_string()),
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn entity_match(
    id: String,
    kind: WorkspaceSelectorKind,
    label: String,
    value: String,
    match_class: WorkspaceEntityMatchClass,
    matched_field: Option<String>,
    matched_value: Option<String>,
) -> WorkspaceEntityMatch {
    WorkspaceEntityMatch {
        id,
        kind,
        label,
        selector: WorkspaceSelector { kind, value },
        match_class,
        matched_field,
        matched_value,
        path: None,
        reference_count: None,
        file_count: None,
        code_lines: None,
    }
}

fn browse_order(left: &WorkspaceEntityMatch, right: &WorkspaceEntityMatch) -> std::cmp::Ordering {
    selector_kind_order(left.kind)
        .cmp(&selector_kind_order(right.kind))
        .then_with(|| match left.kind {
            WorkspaceSelectorKind::Tag | WorkspaceSelectorKind::Mention => right
                .reference_count
                .unwrap_or(0)
                .cmp(&left.reference_count.unwrap_or(0)),
            WorkspaceSelectorKind::Language => right
                .file_count
                .unwrap_or(0)
                .cmp(&left.file_count.unwrap_or(0))
                .then_with(|| {
                    right
                        .code_lines
                        .unwrap_or(0)
                        .cmp(&left.code_lines.unwrap_or(0))
                }),
            WorkspaceSelectorKind::Contact => {
                left.label.to_lowercase().cmp(&right.label.to_lowercase())
            }
            _ => std::cmp::Ordering::Equal,
        })
        .then_with(|| left.id.cmp(&right.id))
}

fn match_class_order(class: WorkspaceEntityMatchClass) -> u8 {
    match class {
        WorkspaceEntityMatchClass::Exact => 0,
        WorkspaceEntityMatchClass::Prefix => 1,
        WorkspaceEntityMatchClass::Substring => 2,
        WorkspaceEntityMatchClass::Browse => 3,
    }
}

fn selector_kind_order(kind: WorkspaceSelectorKind) -> u8 {
    match kind {
        WorkspaceSelectorKind::File => 0,
        WorkspaceSelectorKind::Directory => 1,
        WorkspaceSelectorKind::Tag => 2,
        WorkspaceSelectorKind::Mention => 3,
        WorkspaceSelectorKind::Contact => 4,
        WorkspaceSelectorKind::Language => 5,
    }
}

#[derive(Debug, Clone)]
struct ResolvedSeed {
    selector: WorkspaceSelector,
    node_id: String,
    profile_kind: WorkspaceSelectorKind,
}

fn resolve_seeds(
    catalog: &Catalog,
    request: &NormalizedRequest,
    content_hits: &[WorkspaceContentHit],
    entity_matches: &[WorkspaceEntityMatch],
    errors: &mut Vec<WorkspaceSearchError>,
) -> Vec<ResolvedSeed> {
    let mut seeds = Vec::new();
    let mut seen = BTreeSet::new();
    for selector in &request.from {
        match resolve_selector(catalog, selector) {
            Ok(seed) => push_seed(&mut seeds, &mut seen, seed),
            Err(error) => errors.push(error),
        }
    }
    if request.depth > 0 {
        for hit in content_hits {
            let selector = WorkspaceSelector {
                kind: WorkspaceSelectorKind::File,
                value: hit.path.clone(),
            };
            if let Ok(seed) = resolve_selector(catalog, &selector) {
                push_seed(&mut seeds, &mut seen, seed);
            }
        }
        for entity in entity_matches {
            if let Ok(seed) = resolve_selector(catalog, &entity.selector) {
                push_seed(&mut seeds, &mut seen, seed);
            }
        }
    }
    seeds
}

fn push_seed(
    seeds: &mut Vec<ResolvedSeed>,
    seen: &mut BTreeSet<(WorkspaceSelectorKind, String)>,
    seed: ResolvedSeed,
) {
    if seen.insert((seed.profile_kind, seed.node_id.clone())) {
        seeds.push(seed);
    }
}

fn resolve_selector(
    catalog: &Catalog,
    selector: &WorkspaceSelector,
) -> std::result::Result<ResolvedSeed, WorkspaceSearchError> {
    let original = selector.clone();
    match selector.kind {
        WorkspaceSelectorKind::File => {
            let path = normalize_selector_path(&selector.value, false).map_err(|message| {
                WorkspaceSearchError::InvalidSelector {
                    selector: original.clone(),
                    message,
                }
            })?;
            if !catalog.files.contains(&path) || catalog.contact_by_path.contains_key(&path) {
                return Err(not_found(original));
            }
            Ok(ResolvedSeed {
                selector: WorkspaceSelector {
                    kind: selector.kind,
                    value: path.clone(),
                },
                node_id: path,
                profile_kind: selector.kind,
            })
        }
        WorkspaceSelectorKind::Directory => {
            let path = normalize_selector_path(&selector.value, true).map_err(|message| {
                WorkspaceSearchError::InvalidSelector {
                    selector: original.clone(),
                    message,
                }
            })?;
            if !catalog.directories.contains(&path) {
                return Err(not_found(original));
            }
            Ok(ResolvedSeed {
                selector: WorkspaceSelector {
                    kind: selector.kind,
                    value: path.clone(),
                },
                node_id: directory_id(&path),
                profile_kind: selector.kind,
            })
        }
        WorkspaceSelectorKind::Tag => {
            let value = selector.value.strip_prefix('#').unwrap_or(&selector.value);
            let Some(name) = catalog
                .tags
                .keys()
                .find(|name| name.eq_ignore_ascii_case(value))
            else {
                return Err(not_found(original));
            };
            Ok(ResolvedSeed {
                selector: WorkspaceSelector {
                    kind: selector.kind,
                    value: name.clone(),
                },
                node_id: format!("#{name}"),
                profile_kind: selector.kind,
            })
        }
        WorkspaceSelectorKind::Mention => {
            let value = selector.value.strip_prefix("@@").unwrap_or(&selector.value);
            let Some(name) = catalog
                .mentions
                .keys()
                .find(|name| name.eq_ignore_ascii_case(value))
            else {
                return Err(not_found(original));
            };
            let resolver = crate::MentionContactResolver::new(&catalog.contacts);
            let resolution = resolver.resolve(name);
            if resolution.candidates.len() > 1 {
                return Err(WorkspaceSearchError::AmbiguousSelector {
                    selector: original,
                    candidates: resolution
                        .candidates
                        .into_iter()
                        .map(|value| WorkspaceSelector {
                            kind: WorkspaceSelectorKind::Contact,
                            value,
                        })
                        .collect(),
                    message: "mention resolves to more than one contact".into(),
                });
            }
            Ok(ResolvedSeed {
                selector: WorkspaceSelector {
                    kind: selector.kind,
                    value: name.clone(),
                },
                node_id: resolution.selected.unwrap_or_else(|| format!("@@{name}")),
                profile_kind: selector.kind,
            })
        }
        WorkspaceSelectorKind::Contact => resolve_contact_selector(catalog, selector),
        WorkspaceSelectorKind::Language => {
            let Some(language) = catalog.language(&selector.value) else {
                if catalog.report.is_none() {
                    return Err(WorkspaceSearchError::DomainUnavailable {
                        domain: WorkspaceSearchDomain::Language,
                        message: "language metadata is unavailable without a maintained report"
                            .into(),
                    });
                }
                return Err(not_found(original));
            };
            Ok(ResolvedSeed {
                selector: WorkspaceSelector {
                    kind: selector.kind,
                    value: language.name.clone(),
                },
                node_id: format!("language:{}", language.name),
                profile_kind: selector.kind,
            })
        }
    }
}

fn resolve_contact_selector(
    catalog: &Catalog,
    selector: &WorkspaceSelector,
) -> std::result::Result<ResolvedSeed, WorkspaceSearchError> {
    if let Some(contact) = catalog.contact_by_path.get(&selector.value) {
        return Ok(ResolvedSeed {
            selector: WorkspaceSelector {
                kind: selector.kind,
                value: contact.rel_path.clone(),
            },
            node_id: contact.rel_path.clone(),
            profile_kind: selector.kind,
        });
    }
    let query = selector.value.to_lowercase();
    let candidates: Vec<&ContactNode> = catalog
        .contacts
        .iter()
        .filter(|contact| {
            contact.basename.eq_ignore_ascii_case(&query)
                || contact
                    .title
                    .as_deref()
                    .is_some_and(|title| title.eq_ignore_ascii_case(&query))
                || contact
                    .emails
                    .iter()
                    .any(|email| email.eq_ignore_ascii_case(&query))
                || contact
                    .aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(&query))
        })
        .collect();
    match candidates.as_slice() {
        [] => Err(not_found(selector.clone())),
        [contact] => Ok(ResolvedSeed {
            selector: WorkspaceSelector {
                kind: selector.kind,
                value: contact.rel_path.clone(),
            },
            node_id: contact.rel_path.clone(),
            profile_kind: selector.kind,
        }),
        _ => Err(WorkspaceSearchError::AmbiguousSelector {
            selector: selector.clone(),
            candidates: candidates
                .into_iter()
                .map(|contact| WorkspaceSelector {
                    kind: WorkspaceSelectorKind::Contact,
                    value: contact.rel_path.clone(),
                })
                .collect(),
            message: "contact selector is ambiguous".into(),
        }),
    }
}

fn normalize_selector_path(value: &str, allow_root: bool) -> std::result::Result<String, String> {
    let value = value.trim();
    if allow_root && (value.is_empty() || value == ".") {
        return Ok(String::new());
    }
    if value.is_empty() {
        return Err("path selector is empty".into());
    }
    let mut parts = Vec::new();
    for component in Path::new(value).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path selector escapes the workspace".into())
            }
        }
    }
    if parts.is_empty() && !allow_root {
        return Err("file selector is empty".into());
    }
    Ok(parts.join("/"))
}

fn not_found(selector: WorkspaceSelector) -> WorkspaceSearchError {
    WorkspaceSearchError::SelectorNotFound {
        message: format!(
            "selector {:?}:{} was not found",
            selector.kind, selector.value
        ),
        selector,
    }
}

fn push_unique<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn directory_label(path: &str) -> String {
    if path.is_empty() {
        "/".into()
    } else {
        basename(path).to_string()
    }
}

fn directory_id(path: &str) -> String {
    if path.is_empty() {
        String::new()
    } else {
        format!("directory:{path}")
    }
}

// Traversal implementation follows below.

#[derive(Debug, Clone, Default)]
struct TraversalTruncation {
    graph_nodes: bool,
    graph_nodes_observed: u32,
    graph_edges: bool,
    graph_edges_observed: u32,
    frontier_stopped: bool,
}

struct TraversalBuilder<'a> {
    workspace: &'a Workspace,
    catalog: &'a Catalog,
    node_limit: usize,
    edge_limit: usize,
    contains_selected: bool,
    nodes: BTreeMap<String, (u8, WorkspaceGraphNode)>,
    relationships: BTreeMap<(String, String, u8, String), (u8, WorkspaceRelationship)>,
    observed_nodes: BTreeSet<String>,
    observed_relationships: BTreeSet<(String, String, u8, String)>,
    profiles: Vec<WorkspaceTraversalProfile>,
    truncation: TraversalTruncation,
    spine_forced: bool,
    warnings: &'a mut Vec<WorkspaceSearchWarning>,
}

impl<'a> TraversalBuilder<'a> {
    fn new(
        workspace: &'a Workspace,
        catalog: &'a Catalog,
        node_limit: u32,
        edge_limit: u32,
        warnings: &'a mut Vec<WorkspaceSearchWarning>,
    ) -> Self {
        Self {
            workspace,
            catalog,
            node_limit: node_limit as usize,
            edge_limit: edge_limit as usize,
            contains_selected: true,
            nodes: BTreeMap::new(),
            relationships: BTreeMap::new(),
            observed_nodes: BTreeSet::new(),
            observed_relationships: BTreeSet::new(),
            profiles: Vec::new(),
            truncation: TraversalTruncation::default(),
            spine_forced: false,
            warnings,
        }
    }

    fn set_contains_selected(&mut self, selected: bool) {
        self.contains_selected = selected;
    }

    fn admit_node(&mut self, id: &str, hop: u8) -> bool {
        if let Some((existing_hop, _)) = self.nodes.get_mut(id) {
            *existing_hop = (*existing_hop).min(hop);
            return true;
        }
        let Some(node) = self.node_for_id(id) else {
            return false;
        };
        let path = node_path(&node);
        let mut required_nodes = Vec::new();
        let mut required_relationships = Vec::new();
        if let Some((path, is_directory)) = path {
            let (directory_paths, spine) = containment_spine(path, is_directory);
            for directory in directory_paths {
                let directory_id = directory_id(&directory);
                if directory_id != id && !self.nodes.contains_key(&directory_id) {
                    if let Some(directory_node) = self.node_for_id(&directory_id) {
                        required_nodes.push((directory_id, directory_node));
                    }
                }
            }
            required_relationships = spine;
            if !self.contains_selected && !required_relationships.is_empty() {
                self.spine_forced = true;
            }
        }
        self.observed_nodes.insert(id.to_string());
        for (required_id, _) in &required_nodes {
            self.observed_nodes.insert(required_id.clone());
        }
        let missing_node_count = required_nodes.len() + usize::from(!self.nodes.contains_key(id));
        let missing_relationship_count = required_relationships
            .iter()
            .filter(|relationship| {
                !self
                    .relationships
                    .contains_key(&relationship_key(relationship))
            })
            .count();
        if self.nodes.len() + missing_node_count > self.node_limit {
            self.truncation.graph_nodes = true;
            self.truncation.frontier_stopped = true;
            return false;
        }
        if self.relationships.len() + missing_relationship_count > self.edge_limit {
            self.truncation.graph_edges = true;
            self.truncation.frontier_stopped = true;
            return false;
        }
        for (required_id, required_node) in required_nodes {
            self.nodes.insert(required_id, (hop, required_node));
        }
        self.nodes.insert(id.to_string(), (hop, node));
        for relationship in required_relationships {
            self.insert_relationship(relationship, hop);
        }
        true
    }

    fn admit_relationship(&mut self, relationship: WorkspaceRelationship, hop: u8) -> bool {
        let key = relationship_key(&relationship);
        self.observed_relationships.insert(key.clone());
        if !self.nodes.contains_key(&relationship.source)
            || !self.nodes.contains_key(&relationship.target)
        {
            return false;
        }
        if let Some((existing_hop, _)) = self.relationships.get_mut(&key) {
            *existing_hop = (*existing_hop).min(hop);
            return true;
        }
        if self.relationships.len() >= self.edge_limit {
            self.truncation.graph_edges = true;
            self.truncation.frontier_stopped = true;
            return false;
        }
        self.relationships.insert(key, (hop, relationship));
        true
    }

    fn insert_relationship(&mut self, relationship: WorkspaceRelationship, hop: u8) {
        let key = relationship_key(&relationship);
        self.observed_relationships.insert(key.clone());
        self.relationships.entry(key).or_insert((hop, relationship));
    }

    fn node_for_id(&self, id: &str) -> Option<WorkspaceGraphNode> {
        if let Some(contact) = self.catalog.contact_by_path.get(id) {
            return Some(WorkspaceGraphNode::Contact {
                id: id.to_string(),
                label: contact
                    .title
                    .clone()
                    .unwrap_or_else(|| contact.basename.clone()),
                path: contact.rel_path.clone(),
                basename: contact.basename.clone(),
                title: contact.title.clone(),
                emails: contact.emails.clone(),
                aliases: contact.aliases.clone(),
            });
        }
        if self.catalog.files.contains(id) {
            return Some(WorkspaceGraphNode::File {
                id: id.to_string(),
                label: basename(id).to_string(),
                path: id.to_string(),
                class: graph_file_class(self.catalog, id),
            });
        }
        if id.is_empty() {
            return Some(WorkspaceGraphNode::Directory {
                id: String::new(),
                label: "/".into(),
                path: String::new(),
            });
        }
        if let Some(path) = id.strip_prefix("directory:") {
            if self.catalog.directories.contains(path) {
                return Some(WorkspaceGraphNode::Directory {
                    id: id.to_string(),
                    label: directory_label(path),
                    path: path.to_string(),
                });
            }
            return None;
        }
        if let Some(name) = id.strip_prefix('#') {
            let (canonical, count) = self
                .catalog
                .tags
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))?;
            return Some(WorkspaceGraphNode::Tag {
                id: format!("#{canonical}"),
                label: format!("#{canonical}"),
                name: canonical.clone(),
                reference_count: *count,
            });
        }
        if let Some(name) = id.strip_prefix("@@") {
            let (canonical, count) = self
                .catalog
                .mentions
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))?;
            return Some(WorkspaceGraphNode::Mention {
                id: format!("@@{canonical}"),
                label: format!("@@{canonical}"),
                name: canonical.clone(),
                reference_count: *count,
            });
        }
        if let Some(name) = id.strip_prefix("language:") {
            let language = self.catalog.language(name)?;
            return Some(WorkspaceGraphNode::Language {
                id: format!("language:{}", language.name),
                label: language.name.clone(),
                language: language.name.clone(),
                file_count: language.files,
                code_lines: language.code,
            });
        }
        None
    }

    fn incident_relationships(
        &mut self,
        frontier: &[String],
        direction: WorkspaceTraversalDirection,
        kinds: &[WorkspaceRelationshipKind],
    ) -> Result<Vec<WorkspaceRelationship>> {
        let edge_kinds = graph_edge_kinds(kinds);
        let graph = self.workspace.graph()?;
        let mut edges = Vec::new();
        if matches!(
            direction,
            WorkspaceTraversalDirection::Out | WorkspaceTraversalDirection::Both
        ) && !edge_kinds.is_empty()
        {
            edges.extend(graph.edges_from(frontier, &edge_kinds)?);
        }
        if matches!(
            direction,
            WorkspaceTraversalDirection::In | WorkspaceTraversalDirection::Both
        ) && !edge_kinds.is_empty()
        {
            let incoming = incoming_graph_ids(frontier, self.catalog);
            edges.extend(graph.edges_to(&incoming, &edge_kinds)?);
        }
        let mut normalization_edges = edges;
        normalize_graph_edges(
            &mut normalization_edges,
            &self.catalog.files,
            &self.catalog.contacts,
        );
        let frontier_set: BTreeSet<&str> = frontier.iter().map(String::as_str).collect();
        let mut relationships = Vec::new();
        for edge in normalization_edges {
            let Some(relationship) = self.graph_relationship(edge) else {
                continue;
            };
            let relevant = match direction {
                WorkspaceTraversalDirection::Out => {
                    frontier_set.contains(relationship.source.as_str())
                }
                WorkspaceTraversalDirection::In => {
                    frontier_set.contains(relationship.target.as_str())
                }
                WorkspaceTraversalDirection::Both => {
                    frontier_set.contains(relationship.source.as_str())
                        || frontier_set.contains(relationship.target.as_str())
                }
                WorkspaceTraversalDirection::Auto => false,
            };
            if relevant {
                relationships.push(relationship);
            }
        }
        relationships.extend(in_memory_relationships(
            frontier,
            direction,
            kinds,
            self.catalog,
        ));
        relationships.sort_by(relationship_order);
        relationships.dedup_by(|left, right| relationship_key(left) == relationship_key(right));
        Ok(relationships)
    }

    fn graph_relationship(&mut self, edge: Edge) -> Option<WorkspaceRelationship> {
        let kind = match edge.kind {
            EdgeKind::Link => WorkspaceRelationshipKind::Link,
            EdgeKind::Tag => WorkspaceRelationshipKind::Tag,
            EdgeKind::Mention => WorkspaceRelationshipKind::Mention,
        };
        if edge.kind == EdgeKind::Link {
            if self.catalog.directories.contains(&edge.dst) {
                return None;
            }
            if !self.catalog.files.contains(&edge.dst) {
                push_unique(
                    self.warnings,
                    WorkspaceSearchWarning::MissingLinkTarget {
                        target: edge.dst.clone(),
                        message: format!(
                            "link target {} does not resolve to a workspace file",
                            edge.dst
                        ),
                    },
                );
                return None;
            }
        }
        Some(WorkspaceRelationship {
            source: edge.src,
            target: edge.dst,
            kind,
            anchor: edge.anchor,
            broken: None,
        })
    }

    fn closure_for_files(
        &mut self,
        files: &[String],
        kinds: &[WorkspaceRelationshipKind],
        hop: u8,
    ) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let closure_kinds: Vec<WorkspaceRelationshipKind> = kinds
            .iter()
            .copied()
            .filter(|kind| {
                matches!(
                    kind,
                    WorkspaceRelationshipKind::Tag
                        | WorkspaceRelationshipKind::Mention
                        | WorkspaceRelationshipKind::Language
                )
            })
            .collect();
        let relationships =
            self.incident_relationships(files, WorkspaceTraversalDirection::Both, &closure_kinds)?;
        for relationship in relationships {
            let meta_id = if files.iter().any(|file| file == &relationship.source) {
                &relationship.target
            } else {
                &relationship.source
            };
            if !(meta_id.starts_with('#')
                || meta_id.starts_with("@@")
                || meta_id.starts_with("language:"))
            {
                continue;
            }
            if self.admit_node(meta_id, hop) {
                self.admit_relationship(relationship, hop);
            }
        }
        Ok(())
    }

    fn retain_induced_relationships(
        &mut self,
        kinds: &[WorkspaceRelationshipKind],
        hop: u8,
    ) -> Result<()> {
        let node_ids: Vec<String> = self.nodes.keys().cloned().collect();
        let relationships =
            self.incident_relationships(&node_ids, WorkspaceTraversalDirection::Both, kinds)?;
        for relationship in relationships {
            if self.nodes.contains_key(&relationship.source)
                && self.nodes.contains_key(&relationship.target)
            {
                self.admit_relationship(relationship, hop);
            }
        }
        Ok(())
    }

    fn finish(
        mut self,
    ) -> (
        Vec<WorkspaceGraphNode>,
        Vec<WorkspaceRelationship>,
        Vec<WorkspaceTraversalProfile>,
        TraversalTruncation,
        bool,
    ) {
        self.truncation.graph_nodes_observed = self.observed_nodes.len() as u32;
        self.truncation.graph_edges_observed = self.observed_relationships.len() as u32;
        let mut nodes: Vec<(u8, WorkspaceGraphNode)> = self.nodes.into_values().collect();
        nodes.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.kind_order().cmp(&right.1.kind_order()))
                .then_with(|| left.1.id().cmp(right.1.id()))
        });
        let mut relationships: Vec<(u8, WorkspaceRelationship)> =
            self.relationships.into_values().collect();
        relationships.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| relationship_order(&left.1, &right.1))
        });
        (
            nodes.into_iter().map(|(_, node)| node).collect(),
            relationships
                .into_iter()
                .map(|(_, relationship)| relationship)
                .collect(),
            self.profiles,
            self.truncation,
            self.spine_forced,
        )
    }
}

fn traverse_seed(
    builder: &mut TraversalBuilder<'_>,
    request: &NormalizedRequest,
    seed: ResolvedSeed,
) -> Result<()> {
    builder.set_contains_selected(
        request
            .relationship_kinds
            .contains(&WorkspaceRelationshipKind::Contains),
    );
    let direction = effective_direction(request.direction, seed.profile_kind);
    let depth = if seed.profile_kind == WorkspaceSelectorKind::Language {
        request.depth.min(1)
    } else {
        request.depth
    };
    builder.profiles.push(WorkspaceTraversalProfile {
        selector: seed.selector.clone(),
        node_id: seed.node_id.clone(),
        depth,
        direction,
    });
    if !builder.admit_node(&seed.node_id, 0) {
        return Ok(());
    }
    if depth == 0 {
        if seed.profile_kind == WorkspaceSelectorKind::Contact {
            builder.closure_for_files(
                std::slice::from_ref(&seed.node_id),
                &request.relationship_kinds,
                0,
            )?;
        }
        return Ok(());
    }
    if seed.profile_kind == WorkspaceSelectorKind::Directory {
        return traverse_directory(builder, request, &seed, direction, depth);
    }

    let mut visited = BTreeSet::from([seed.node_id.clone()]);
    let mut frontier = vec![seed.node_id];
    for hop in 0..depth {
        if frontier.is_empty() {
            break;
        }
        let frontier_set: BTreeSet<&str> = frontier.iter().map(String::as_str).collect();
        let relationships =
            builder.incident_relationships(&frontier, direction, &request.relationship_kinds)?;
        let mut next = BTreeSet::new();
        for relationship in relationships {
            let mut candidates = Vec::new();
            if frontier_set.contains(relationship.source.as_str()) {
                candidates.push(relationship.target.clone());
            }
            if frontier_set.contains(relationship.target.as_str()) {
                candidates.push(relationship.source.clone());
            }
            for candidate in candidates {
                if !visited.contains(&candidate) && builder.admit_node(&candidate, hop + 1) {
                    visited.insert(candidate.clone());
                    next.insert(candidate);
                }
            }
            builder.admit_relationship(relationship, hop + 1);
        }
        frontier = next.into_iter().collect();
    }
    if matches!(
        seed.profile_kind,
        WorkspaceSelectorKind::Tag
            | WorkspaceSelectorKind::Mention
            | WorkspaceSelectorKind::Contact
    ) {
        let files: Vec<String> = visited
            .iter()
            .filter(|id| {
                builder.catalog.files.contains(*id)
                    || builder.catalog.contact_by_path.contains_key(*id)
            })
            .cloned()
            .collect();
        builder.closure_for_files(&files, &request.relationship_kinds, depth)?;
    }
    Ok(())
}

fn traverse_directory(
    builder: &mut TraversalBuilder<'_>,
    request: &NormalizedRequest,
    seed: &ResolvedSeed,
    direction: WorkspaceTraversalDirection,
    depth: u8,
) -> Result<()> {
    if direction == WorkspaceTraversalDirection::In {
        return Ok(());
    }
    let base = seed.selector.value.as_str();
    let mut candidates = Vec::new();
    for directory in &builder.catalog.directories {
        if let Some(distance) = descendant_distance(base, directory) {
            if distance > 0 && distance <= depth {
                candidates.push((distance, directory_id(directory)));
            }
        }
    }
    for file in &builder.catalog.files {
        if let Some(distance) = descendant_distance(base, file) {
            if distance > 0 && distance <= depth {
                candidates.push((distance, file.clone()));
            }
        }
    }
    candidates.sort();
    let mut surfaced_files = Vec::new();
    for (distance, id) in candidates {
        if builder.admit_node(&id, distance) && builder.catalog.files.contains(&id) {
            surfaced_files.push(id);
        }
    }
    builder.closure_for_files(&surfaced_files, &request.relationship_kinds, depth)?;
    Ok(())
}

fn effective_direction(
    requested: WorkspaceTraversalDirection,
    kind: WorkspaceSelectorKind,
) -> WorkspaceTraversalDirection {
    if requested != WorkspaceTraversalDirection::Auto {
        return requested;
    }
    match kind {
        WorkspaceSelectorKind::File => WorkspaceTraversalDirection::Out,
        WorkspaceSelectorKind::Directory => WorkspaceTraversalDirection::Out,
        WorkspaceSelectorKind::Tag
        | WorkspaceSelectorKind::Mention
        | WorkspaceSelectorKind::Contact
        | WorkspaceSelectorKind::Language => WorkspaceTraversalDirection::Both,
    }
}

fn graph_edge_kinds(kinds: &[WorkspaceRelationshipKind]) -> Vec<EdgeKind> {
    kinds
        .iter()
        .filter_map(|kind| match kind {
            WorkspaceRelationshipKind::Link => Some(EdgeKind::Link),
            WorkspaceRelationshipKind::Tag => Some(EdgeKind::Tag),
            WorkspaceRelationshipKind::Mention => Some(EdgeKind::Mention),
            WorkspaceRelationshipKind::Language | WorkspaceRelationshipKind::Contains => None,
        })
        .collect()
}

fn incoming_graph_ids(frontier: &[String], catalog: &Catalog) -> Vec<String> {
    let mut ids: BTreeSet<String> = frontier.iter().cloned().collect();
    for id in frontier {
        if let Some(contact) = catalog.contact_by_path.get(id) {
            if let Some(stem) = Path::new(&contact.rel_path)
                .file_stem()
                .and_then(|stem| stem.to_str())
            {
                ids.insert(format!("@@{stem}"));
            }
            for alias in &contact.aliases {
                ids.insert(format!("@@{}", alias.trim()));
            }
        }
    }
    ids.into_iter().collect()
}

fn in_memory_relationships(
    frontier: &[String],
    direction: WorkspaceTraversalDirection,
    kinds: &[WorkspaceRelationshipKind],
    catalog: &Catalog,
) -> Vec<WorkspaceRelationship> {
    let mut relationships = Vec::new();
    if kinds.contains(&WorkspaceRelationshipKind::Contains) {
        for id in frontier {
            if matches!(
                direction,
                WorkspaceTraversalDirection::In | WorkspaceTraversalDirection::Both
            ) {
                if let Some(path) = entity_path(id, catalog) {
                    if !path.is_empty() {
                        relationships.push(contains_relationship(
                            &directory_id(parent_directory(path)),
                            id,
                        ));
                    }
                } else if let Some(path) = id.strip_prefix("directory:") {
                    relationships.push(contains_relationship(
                        &directory_id(parent_directory(path)),
                        id,
                    ));
                }
            }
            if matches!(
                direction,
                WorkspaceTraversalDirection::Out | WorkspaceTraversalDirection::Both
            ) {
                let directory = if id.is_empty() {
                    Some("")
                } else {
                    id.strip_prefix("directory:")
                };
                if let Some(directory) = directory {
                    for child in direct_directory_children(directory, catalog) {
                        relationships.push(contains_relationship(id, &child));
                    }
                }
            }
        }
    }
    if kinds.contains(&WorkspaceRelationshipKind::Language) {
        if let Some(report) = &catalog.report {
            for id in frontier {
                if matches!(
                    direction,
                    WorkspaceTraversalDirection::Out | WorkspaceTraversalDirection::Both
                ) {
                    if let Some(language) = id.strip_prefix("language:") {
                        for file in report
                            .files
                            .iter()
                            .filter(|file| file.language.eq_ignore_ascii_case(language))
                        {
                            relationships.push(language_relationship(&file.language, &file.path));
                        }
                    }
                }
                if matches!(
                    direction,
                    WorkspaceTraversalDirection::In | WorkspaceTraversalDirection::Both
                ) {
                    if let Some(file) = catalog.report_file(id) {
                        relationships.push(language_relationship(&file.language, &file.path));
                    }
                }
            }
        }
    }
    relationships
}

fn direct_directory_children(directory: &str, catalog: &Catalog) -> Vec<String> {
    let mut children = BTreeSet::new();
    for child in &catalog.directories {
        if !child.is_empty() && parent_directory(child) == directory {
            children.insert(directory_id(child));
        }
    }
    for child in &catalog.files {
        if parent_directory(child) == directory {
            children.insert(child.clone());
        }
    }
    children.into_iter().collect()
}

fn contains_relationship(source: &str, target: &str) -> WorkspaceRelationship {
    WorkspaceRelationship {
        source: source.to_string(),
        target: target.to_string(),
        kind: WorkspaceRelationshipKind::Contains,
        anchor: None,
        broken: None,
    }
}

fn language_relationship(language: &str, file: &str) -> WorkspaceRelationship {
    WorkspaceRelationship {
        source: format!("language:{language}"),
        target: file.to_string(),
        kind: WorkspaceRelationshipKind::Language,
        anchor: None,
        broken: None,
    }
}

fn containment_spine(path: &str, is_directory: bool) -> (Vec<String>, Vec<WorkspaceRelationship>) {
    let mut directories = vec![String::new()];
    let terminal_directory = if is_directory {
        path
    } else {
        parent_directory(path)
    };
    if !terminal_directory.is_empty() {
        let mut current = String::new();
        for component in terminal_directory.split('/') {
            current = if current.is_empty() {
                component.to_string()
            } else {
                format!("{current}/{component}")
            };
            directories.push(current.clone());
        }
    }
    let mut relationships = Vec::new();
    for pair in directories.windows(2) {
        relationships.push(contains_relationship(
            &directory_id(&pair[0]),
            &directory_id(&pair[1]),
        ));
    }
    if !is_directory {
        relationships.push(contains_relationship(
            &directory_id(terminal_directory),
            path,
        ));
    }
    (directories, relationships)
}

fn entity_path<'a>(id: &'a str, catalog: &Catalog) -> Option<&'a str> {
    (catalog.files.contains(id) || catalog.contact_by_path.contains_key(id)).then_some(id)
}

fn node_path(node: &WorkspaceGraphNode) -> Option<(&str, bool)> {
    match node {
        WorkspaceGraphNode::File { path, .. } | WorkspaceGraphNode::Contact { path, .. } => {
            Some((path, false))
        }
        WorkspaceGraphNode::Directory { path, .. } => Some((path, true)),
        _ => None,
    }
}

fn parent_directory(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn descendant_distance(base: &str, path: &str) -> Option<u8> {
    let remainder = if base.is_empty() {
        path
    } else if path == base {
        ""
    } else {
        path.strip_prefix(&format!("{base}/"))?
    };
    if remainder.is_empty() {
        return Some(0);
    }
    u8::try_from(remainder.split('/').count()).ok()
}

fn graph_file_class(catalog: &Catalog, path: &str) -> WorkspaceGraphFileClass {
    if let Some(file) = catalog.report_file(path) {
        if matches!(file.bucket, Some(crate::ReportFileBucket::Markdown)) {
            return WorkspaceGraphFileClass::Markdown;
        }
        if matches!(
            file.bucket,
            Some(crate::ReportFileBucket::SourceCode { .. })
        ) {
            return WorkspaceGraphFileClass::Source;
        }
    }
    match classify(path) {
        FileClass::EditableText if path.to_ascii_lowercase().ends_with(".md") => {
            WorkspaceGraphFileClass::Markdown
        }
        FileClass::EditableText => WorkspaceGraphFileClass::Text,
        FileClass::Text => WorkspaceGraphFileClass::Source,
        FileClass::Image | FileClass::Pdf => WorkspaceGraphFileClass::Media,
        FileClass::Other => WorkspaceGraphFileClass::Other,
    }
}

fn relationship_key(relationship: &WorkspaceRelationship) -> (String, String, u8, String) {
    (
        relationship.source.clone(),
        relationship.target.clone(),
        relationship_kind_order(relationship.kind),
        relationship.anchor.clone().unwrap_or_default(),
    )
}

fn relationship_order(
    left: &WorkspaceRelationship,
    right: &WorkspaceRelationship,
) -> std::cmp::Ordering {
    relationship_kind_order(left.kind)
        .cmp(&relationship_kind_order(right.kind))
        .then_with(|| left.source.cmp(&right.source))
        .then_with(|| left.target.cmp(&right.target))
        .then_with(|| left.anchor.cmp(&right.anchor))
}

fn relationship_kind_order(kind: WorkspaceRelationshipKind) -> u8 {
    match kind {
        WorkspaceRelationshipKind::Link => 0,
        WorkspaceRelationshipKind::Tag => 1,
        WorkspaceRelationshipKind::Mention => 2,
        WorkspaceRelationshipKind::Language => 3,
        WorkspaceRelationshipKind::Contains => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_workspace() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        std::sync::Arc<Workspace>,
    ) {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let library = crate::Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        (config, root, workspace)
    }

    #[test]
    fn workspace_search_normalizes_defaults_deduplication_and_caps() {
        let request = WorkspaceSearchRequest {
            query: Some("  needle  ".into()),
            domains: vec![
                WorkspaceSearchDomain::File,
                WorkspaceSearchDomain::File,
                WorkspaceSearchDomain::Tag,
            ],
            depth: Some(99),
            relationship_kinds: vec![
                WorkspaceRelationshipKind::Link,
                WorkspaceRelationshipKind::Link,
            ],
            limit: Some(999),
            node_limit: Some(9_999),
            edge_limit: Some(9_999),
            ..WorkspaceSearchRequest::default()
        };

        let (normalized, warnings, errors) = normalize_request(&request);

        assert!(errors.is_empty());
        assert_eq!(normalized.query.as_deref(), Some("needle"));
        assert_eq!(
            normalized.domains,
            vec![WorkspaceSearchDomain::File, WorkspaceSearchDomain::Tag]
        );
        assert_eq!(
            normalized.relationship_kinds,
            vec![WorkspaceRelationshipKind::Link]
        );
        assert_eq!(normalized.depth, MAX_DEPTH);
        assert_eq!(normalized.limit, MAX_LIMIT);
        assert_eq!(normalized.node_limit, MAX_NODE_LIMIT);
        assert_eq!(normalized.edge_limit, MAX_EDGE_LIMIT);
        assert_eq!(warnings.len(), 4);
    }

    #[test]
    fn workspace_search_rejects_an_empty_content_only_request() {
        let request = WorkspaceSearchRequest {
            domains: vec![WorkspaceSearchDomain::Content],
            ..WorkspaceSearchRequest::default()
        };
        let (_, _, errors) = normalize_request(&request);
        assert!(matches!(
            errors.as_slice(),
            [WorkspaceSearchError::InvalidRequest { .. }]
        ));
    }

    #[test]
    fn workspace_search_during_recovery_is_explicitly_not_ready() {
        let (_config, _root, workspace) = open_workspace();
        workspace
            .write_text("a.md", "# A\nrecovery-search-token\n")
            .unwrap();
        workspace.index_file("a.md").unwrap();
        workspace.request_recovery(crate::RecoveryAction::Reconcile);

        let result = workspace
            .workspace_search(&WorkspaceSearchRequest {
                query: Some("recovery-search-token".into()),
                domains: vec![WorkspaceSearchDomain::Content],
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();

        assert!(!result.search.ready);
        assert!(result.content_hits.is_empty());
        assert!(matches!(
            result.errors.as_slice(),
            [WorkspaceSearchError::IndexNotReady { .. }]
        ));
        assert_eq!(
            serde_json::to_value(result.readiness).unwrap()["state"],
            "recovering"
        );
    }

    #[test]
    fn workspace_search_tag_traversal_emits_files_and_complete_spines() {
        let (_config, _root, workspace) = open_workspace();
        workspace.create_dir("notes/deep").unwrap();
        workspace
            .write_text(
                "notes/a.md",
                "# A\n\nUses #shared, mentions @@ali, and links [B](deep/b.md).\n",
            )
            .unwrap();
        workspace
            .write_text("notes/deep/b.md", "# B\n\nUses #shared.\n")
            .unwrap();
        workspace.create_dir("contacts").unwrap();
        workspace
            .write_text(
                "contacts/alice.md",
                "---\naliases: [ali]\nchan:\n  kind: contact\n---\n# Alice\n",
            )
            .unwrap();
        workspace.index_file("notes/a.md").unwrap();
        workspace.index_file("notes/deep/b.md").unwrap();
        workspace.index_file("contacts/alice.md").unwrap();

        let result = workspace
            .workspace_search(&WorkspaceSearchRequest {
                from: vec![WorkspaceSelector {
                    kind: WorkspaceSelectorKind::Tag,
                    value: "#shared".into(),
                }],
                depth: Some(1),
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();

        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let ids: BTreeSet<&str> = result.nodes.iter().map(WorkspaceGraphNode::id).collect();
        assert!(ids.contains("#shared"));
        assert!(ids.contains("notes/a.md"));
        assert!(ids.contains("notes/deep/b.md"));
        assert!(ids.contains(""));
        assert!(ids.contains("directory:notes"));
        assert!(ids.contains("directory:notes/deep"));
        assert!(!ids.contains("contacts/alice.md"));
        assert!(result.relationships.iter().any(|relationship| {
            relationship.kind == WorkspaceRelationshipKind::Tag
                && relationship.source == "notes/a.md"
                && relationship.target == "#shared"
        }));
        assert!(result.relationships.iter().any(|relationship| {
            relationship.kind == WorkspaceRelationshipKind::Contains
                && relationship.source == "directory:notes/deep"
                && relationship.target == "notes/deep/b.md"
        }));
        assert!(!result.relationships.iter().any(|relationship| {
            relationship.kind == WorkspaceRelationshipKind::Mention
                && relationship.source == "notes/a.md"
                && relationship.target == "contacts/alice.md"
        }));
    }

    #[test]
    fn workspace_search_directory_retains_internal_links_and_forces_spines() {
        let (_config, _root, workspace) = open_workspace();
        workspace.create_dir("notes/deep").unwrap();
        workspace
            .write_text("notes/a.md", "[B](deep/b.md)\n")
            .unwrap();
        workspace.write_text("notes/deep/b.md", "# B\n").unwrap();
        workspace.index_file("notes/a.md").unwrap();
        workspace.index_file("notes/deep/b.md").unwrap();

        let result = workspace
            .workspace_search(&WorkspaceSearchRequest {
                from: vec![WorkspaceSelector {
                    kind: WorkspaceSelectorKind::Directory,
                    value: "notes".into(),
                }],
                depth: Some(2),
                relationship_kinds: vec![WorkspaceRelationshipKind::Link],
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();

        assert!(result.traversal.spine_forced);
        assert!(result.relationships.iter().any(|relationship| {
            relationship.kind == WorkspaceRelationshipKind::Link
                && relationship.source == "notes/a.md"
                && relationship.target == "notes/deep/b.md"
        }));
    }

    #[test]
    fn workspace_search_keeps_valid_seeds_when_another_selector_is_invalid() {
        let (_config, _root, workspace) = open_workspace();
        workspace.create_dir("notes").unwrap();
        workspace.write_text("notes/a.md", "# A\n").unwrap();
        workspace.index_file("notes/a.md").unwrap();

        let result = workspace
            .workspace_search(&WorkspaceSearchRequest {
                from: vec![
                    WorkspaceSelector {
                        kind: WorkspaceSelectorKind::File,
                        value: "notes/a.md".into(),
                    },
                    WorkspaceSelector {
                        kind: WorkspaceSelectorKind::File,
                        value: "../outside.md".into(),
                    },
                ],
                depth: Some(0),
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();

        assert!(result.nodes.iter().any(|node| node.id() == "notes/a.md"));
        assert!(matches!(
            result.errors.as_slice(),
            [WorkspaceSearchError::InvalidSelector { .. }]
        ));
    }

    #[test]
    fn workspace_search_omits_a_file_when_its_spine_cannot_fit() {
        let (_config, _root, workspace) = open_workspace();
        workspace.create_dir("a/b").unwrap();
        workspace.write_text("a/b/note.md", "# Note\n").unwrap();
        workspace.index_file("a/b/note.md").unwrap();

        let result = workspace
            .workspace_search(&WorkspaceSearchRequest {
                from: vec![WorkspaceSelector {
                    kind: WorkspaceSelectorKind::File,
                    value: "a/b/note.md".into(),
                }],
                depth: Some(0),
                node_limit: Some(2),
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();

        assert!(result.nodes.is_empty());
        assert!(result.truncation.graph_nodes);
        assert_eq!(result.truncation.graph_nodes_observed, 4);
        assert!(result.truncation.frontier_stopped);
    }

    #[test]
    fn workspace_search_discovers_source_paths_without_indexing_source_bodies() {
        let (_config, _root, workspace) = open_workspace();
        workspace.create_dir("src").unwrap();
        workspace
            .write_text(
                "src/lib.rs",
                "pub const UNIQUE_SOURCE_BODY_TOKEN: &str = \"secret\";\n",
            )
            .unwrap();
        workspace.index_file("src/lib.rs").unwrap();

        let content = workspace
            .workspace_search(&WorkspaceSearchRequest {
                query: Some("UNIQUE_SOURCE_BODY_TOKEN".into()),
                domains: vec![WorkspaceSearchDomain::Content],
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();
        assert!(content.content_hits.is_empty());

        let entity = workspace
            .workspace_search(&WorkspaceSearchRequest {
                query: Some("lib.rs".into()),
                domains: vec![WorkspaceSearchDomain::File],
                ..WorkspaceSearchRequest::default()
            })
            .unwrap();
        assert_eq!(entity.entity_matches.len(), 1);
        assert_eq!(entity.entity_matches[0].id, "src/lib.rs");
        assert_eq!(
            entity.entity_matches[0].match_class,
            WorkspaceEntityMatchClass::Exact
        );
    }
}
