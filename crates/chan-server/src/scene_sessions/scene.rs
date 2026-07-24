//! Pure scene model for live Excalidraw collaboration: opaque elements
//! merged by element-level last-writer-wins.
//!
//! Elements are opaque `serde_json::Value` objects; the model extracts
//! only the merge metadata (`id`, `version`, `versionNonce`, `index`,
//! `isDeleted`) and never interprets geometry or styling. The LWW rule
//! is pinned to the vendored `@excalidraw/excalidraw` dist
//! (`data/reconcile.ts` in
//! `web/node_modules/@excalidraw/excalidraw/dist/dev/index.js`): a
//! stored element survives an incoming one iff its version is higher,
//! or the versions tie and its versionNonce is lower. Clients run the
//! same rule through `reconcileElements`, so the authority and every
//! canvas converge on identical winners.
//!
//! Replace semantics serve the `$http` PUT divert and the `$disk`
//! reconciler: the incoming file body becomes the authority. Any
//! element whose value differs from the stored one is adopted with
//! `version = max(stored + 1, incoming)` and a fresh nonce, and a live
//! element absent from the body becomes a tombstone with a bumped
//! version, so the change wins client-side reconciliation everywhere.
//! Tombstones live only in session memory; the file form excludes
//! them, and a replace against a tombstone-less file leaves existing
//! tombstones untouched (deletes never resurrect).
//!
//! The file form matches the client's `serializeAsJSON(.., "local")`:
//! a pretty-printed `{type, version, source, elements, appState,
//! files}` envelope with non-deleted elements ordered by
//! `(index, id)` and the files map filtered to entries a live element
//! references. Embedded images ride that files map as data URLs and
//! the map only grows for the life of a session, so image-heavy
//! scenes approach the byte cap; an asset side-channel is a named
//! follow-up.
//!
//! The growth cap counts compact-JSON bytes against
//! [`TEXT_WRITE_LIMIT`]. That is a lower bound of the pretty file
//! form; exactness does not matter (the workspace write path enforces
//! the on-disk limit independently), the cap only bounds session
//! memory. Everything here is pure: no I/O, no tokio, no session
//! state.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chan_workspace::TEXT_WRITE_LIMIT;
use serde::Serialize;
use serde_json::{Map, Value};

/// Envelope constants for the on-disk form. The version is
/// Excalidraw's scene-format version, not chan's.
const SCENE_FILE_TYPE: &str = "excalidraw";
const SCENE_FILE_VERSION: u64 = 2;
const SCENE_FILE_SOURCE: &str = "chan";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SceneError {
    /// The body or a frame payload is not a usable Excalidraw scene.
    /// The PUT divert maps this to a 400; the ws route closes the
    /// attachment loudly rather than guessing.
    #[error("invalid excalidraw scene: {0}")]
    Invalid(&'static str),
    /// The mutation would grow the scene past the text write limit.
    #[error("scene would be {bytes} bytes, over the {limit} byte limit")]
    TooLarge { bytes: u64, limit: u64 },
}

/// Compact-JSON byte cost of a value; the unit of the growth cap.
fn value_cost(value: &Value) -> usize {
    serde_json::to_string(value)
        .expect("serialize json value")
        .len()
}

/// One element as the authority holds it: the full client value plus
/// the extracted merge metadata. The metadata is mirrored INTO the
/// value on every server-side write, so fan-out, snapshots, and the
/// file form always carry the fields clients merge on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredElement {
    pub value: Value,
    pub version: u64,
    pub version_nonce: u64,
    pub index: Option<String>,
    pub is_deleted: bool,
    /// Compact-JSON byte cost of `value`, cached for the growth cap.
    cost: usize,
}

impl StoredElement {
    /// Normalize a raw client or file element: require an object with
    /// a string id, extract the merge metadata with defensive defaults
    /// (a missing or non-numeric version reads as 0, so any real
    /// update wins), and write the normalized fields back into the
    /// value.
    fn from_value(mut value: Value) -> Result<(String, Self), SceneError> {
        let obj = value
            .as_object_mut()
            .ok_or(SceneError::Invalid("element is not an object"))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or(SceneError::Invalid("element without a string id"))?
            .to_owned();
        let version = obj.get("version").and_then(Value::as_u64).unwrap_or(0);
        let version_nonce = obj.get("versionNonce").and_then(Value::as_u64).unwrap_or(0);
        let index = obj.get("index").and_then(Value::as_str).map(str::to_owned);
        let is_deleted = obj
            .get("isDeleted")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        obj.insert("version".into(), version.into());
        obj.insert("versionNonce".into(), version_nonce.into());
        obj.insert("isDeleted".into(), is_deleted.into());
        let cost = value_cost(&value);
        Ok((
            id,
            Self {
                value,
                version,
                version_nonce,
                index,
                is_deleted,
                cost,
            },
        ))
    }

    /// Rewrite the merge metadata (a server-side version bump) and
    /// mirror it into the value.
    fn restamp(&mut self, version: u64, version_nonce: u64, is_deleted: bool) {
        self.version = version;
        self.version_nonce = version_nonce;
        self.is_deleted = is_deleted;
        let obj = self
            .value
            .as_object_mut()
            .expect("stored element value is an object");
        obj.insert("version".into(), version.into());
        obj.insert("versionNonce".into(), version_nonce.into());
        obj.insert("isDeleted".into(), is_deleted.into());
        self.cost = value_cost(&self.value);
    }
}

/// The last-writer-wins rule, ported exactly from the vendored dist's
/// `shouldDiscardRemoteElement` with the stored element as "local":
/// stored wins iff `stored.version > incoming.version`, or the
/// versions tie and `stored.versionNonce < incoming.versionNonce`.
/// The dist's additional actively-being-edited guards read the client
/// appState and have no server analogue.
fn stored_wins(stored: &StoredElement, version: u64, version_nonce: u64) -> bool {
    stored.version > version || (stored.version == version && stored.version_nonce < version_nonce)
}

/// The mutation outcome a session fans to the OTHER attachments: the
/// accepted (push) or changed (replace) element values, the adopted
/// whole appState object when it changed, and file entries learned by
/// this mutation. Empty means nothing to fan.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Applied {
    pub elements: Vec<Value>,
    pub app_state: Option<Value>,
    pub files: Map<String, Value>,
}

impl Applied {
    pub fn is_empty(&self) -> bool {
        self.elements.is_empty() && self.app_state.is_none() && self.files.is_empty()
    }
}

/// The authority scene: elements keyed by id (tombstones included),
/// a whole-object-LWW appState, and an additive files map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scene {
    elements: HashMap<String, StoredElement>,
    app_state: Map<String, Value>,
    files: Map<String, Value>,
    elements_cost: usize,
    app_state_cost: usize,
    files_cost: usize,
}

impl Default for Scene {
    fn default() -> Self {
        Self::empty()
    }
}

impl Scene {
    pub fn empty() -> Self {
        let app_state = Map::new();
        let app_state_cost = value_cost(&Value::Object(app_state.clone()));
        Self {
            elements: HashMap::new(),
            app_state,
            files: Map::new(),
            elements_cost: 0,
            app_state_cost,
            files_cost: 0,
        }
    }

    /// Parse a `.excalidraw` file body. Whitespace-only text is the
    /// fresh empty board (the canvas treats it the same). Envelope
    /// keys beyond `elements` / `appState` / `files` are ignored;
    /// duplicate element ids keep the first occurrence, matching the
    /// dist reconciler's added-set semantics.
    pub fn parse(text: &str) -> Result<Self, SceneError> {
        if text.trim().is_empty() {
            return Ok(Self::empty());
        }
        let root: Value =
            serde_json::from_str(text).map_err(|_| SceneError::Invalid("not valid JSON"))?;
        let Value::Object(mut root) = root else {
            return Err(SceneError::Invalid("top level is not an object"));
        };
        let raw_elements = match root.remove("elements") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a,
            Some(_) => return Err(SceneError::Invalid("elements is not an array")),
        };
        let app_state = match root.remove("appState") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(o)) => o,
            Some(_) => return Err(SceneError::Invalid("appState is not an object")),
        };
        let files = match root.remove("files") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(o)) => o,
            Some(_) => return Err(SceneError::Invalid("files is not an object")),
        };

        let mut elements = HashMap::new();
        let mut elements_cost = 0usize;
        for value in raw_elements {
            let (id, el) = StoredElement::from_value(value)?;
            if let std::collections::hash_map::Entry::Vacant(slot) = elements.entry(id) {
                elements_cost += el.cost;
                slot.insert(el);
            }
        }
        let app_state_cost = value_cost(&Value::Object(app_state.clone()));
        let files_cost = files.iter().map(|(k, v)| k.len() + value_cost(v)).sum();
        Ok(Self {
            elements,
            app_state,
            files,
            elements_cost,
            app_state_cost,
            files_cost,
        })
    }

    fn total_cost(&self) -> usize {
        self.elements_cost + self.app_state_cost + self.files_cost
    }

    /// Validate an optional appState payload into a staged map. `None`
    /// and JSON `null` mean "not carried by this mutation".
    fn stage_app_state(app_state: Option<Value>) -> Result<Option<Map<String, Value>>, SceneError> {
        match app_state {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Object(o)) => Ok(Some(o)),
            Some(_) => Err(SceneError::Invalid("appState is not an object")),
        }
    }

    /// Validate an optional files payload down to the entries this
    /// scene does not know. Known ids are immutable and never
    /// overwritten (the map is additive).
    fn stage_new_files(&self, files: Option<Value>) -> Result<Map<String, Value>, SceneError> {
        match files {
            None | Some(Value::Null) => Ok(Map::new()),
            Some(Value::Object(o)) => Ok(o
                .into_iter()
                .filter(|(k, _)| !self.files.contains_key(k))
                .collect()),
            Some(_) => Err(SceneError::Invalid("files is not an object")),
        }
    }

    /// Merge one client push. All-or-nothing: validation or the growth
    /// cap failing leaves the scene untouched. Elements are resolved
    /// in push order against the evolving state, so a batch carrying
    /// the same id twice converges like two sequential pushes. An
    /// appState equal to the stored object is treated as not carried:
    /// a client echoing the authority's own appState back must never
    /// bump the version or re-fan, or two live canvases ping-pong the
    /// object forever.
    pub fn apply_push(
        &mut self,
        elements: Vec<Value>,
        app_state: Option<Value>,
        files: Option<Value>,
    ) -> Result<Applied, SceneError> {
        let mut staged: HashMap<String, StoredElement> = HashMap::new();
        let mut accepted: Vec<Value> = Vec::new();
        for value in elements {
            let (id, el) = StoredElement::from_value(value)?;
            let current = staged.get(&id).or_else(|| self.elements.get(&id));
            if current.is_some_and(|c| stored_wins(c, el.version, el.version_nonce)) {
                continue;
            }
            accepted.push(el.value.clone());
            staged.insert(id, el);
        }
        let staged_app_state = Self::stage_app_state(app_state)?.filter(|o| *o != self.app_state);
        let new_files = self.stage_new_files(files)?;

        let elements_delta: i64 = staged
            .iter()
            .map(|(id, el)| el.cost as i64 - self.elements.get(id).map_or(0, |old| old.cost as i64))
            .sum();
        let app_state_cost = staged_app_state
            .as_ref()
            .map(|o| value_cost(&Value::Object(o.clone())));
        let files_delta: usize = new_files.iter().map(|(k, v)| k.len() + value_cost(v)).sum();
        let prospective = self.total_cost() as i64
            + elements_delta
            + app_state_cost.map_or(0, |c| c as i64 - self.app_state_cost as i64)
            + files_delta as i64;
        if prospective > TEXT_WRITE_LIMIT as i64 {
            return Err(SceneError::TooLarge {
                bytes: prospective.max(0) as u64,
                limit: TEXT_WRITE_LIMIT,
            });
        }

        for (id, el) in staged {
            self.elements_cost += el.cost;
            if let Some(old) = self.elements.insert(id, el) {
                self.elements_cost -= old.cost;
            }
        }
        let app_state = match (staged_app_state, app_state_cost) {
            (Some(o), Some(cost)) => {
                self.app_state = o.clone();
                self.app_state_cost = cost;
                Some(Value::Object(o))
            }
            _ => None,
        };
        self.files_cost += files_delta;
        for (k, v) in &new_files {
            self.files.insert(k.clone(), v.clone());
        }
        Ok(Applied {
            elements: accepted,
            app_state,
            files: new_files,
        })
    }

    /// Replace the whole scene from a file body (the `$http` PUT
    /// divert and the `$disk` reconciler): the incoming scene is the
    /// authority. Differing elements are adopted with
    /// `version = max(stored + 1, incoming)` and a fresh nonce; live
    /// elements absent from the body become tombstones with bumped
    /// versions; existing tombstones stay untouched unless the body
    /// resurrects their id. Equal content yields an empty [`Applied`]
    /// (the flush-echo case). All-or-nothing like the push path.
    pub fn apply_replace(
        &mut self,
        text: &str,
        fresh_nonce: &mut dyn FnMut() -> u64,
    ) -> Result<Applied, SceneError> {
        let incoming = Self::parse(text)?;

        let mut next: HashMap<String, StoredElement> =
            HashMap::with_capacity(self.elements.len().max(incoming.elements.len()));
        let mut changed: Vec<Value> = Vec::new();
        for (id, inc) in incoming.ordered() {
            match self.elements.get(id) {
                Some(stored) if stored.value == inc.value => {
                    next.insert(id.clone(), stored.clone());
                }
                Some(stored) => {
                    let mut el = inc.clone();
                    el.restamp(
                        stored.version.saturating_add(1).max(inc.version),
                        fresh_nonce(),
                        inc.is_deleted,
                    );
                    changed.push(el.value.clone());
                    next.insert(id.clone(), el);
                }
                None => {
                    changed.push(inc.value.clone());
                    next.insert(id.clone(), inc.clone());
                }
            }
        }
        for (id, stored) in self.ordered() {
            if incoming.elements.contains_key(id) {
                continue;
            }
            if stored.is_deleted {
                next.insert(id.clone(), stored.clone());
            } else {
                let mut el = stored.clone();
                el.restamp(stored.version.saturating_add(1), fresh_nonce(), true);
                changed.push(el.value.clone());
                next.insert(id.clone(), el);
            }
        }

        let app_state = (incoming.app_state != self.app_state)
            .then(|| Value::Object(incoming.app_state.clone()));
        let new_files: Map<String, Value> = incoming
            .files
            .iter()
            .filter(|(k, _)| !self.files.contains_key(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let elements_cost = next.values().map(|el| el.cost).sum::<usize>();
        let app_state_cost = if app_state.is_some() {
            incoming.app_state_cost
        } else {
            self.app_state_cost
        };
        let files_delta: usize = new_files.iter().map(|(k, v)| k.len() + value_cost(v)).sum();
        let prospective = elements_cost + app_state_cost + self.files_cost + files_delta;
        if prospective > TEXT_WRITE_LIMIT as usize {
            return Err(SceneError::TooLarge {
                bytes: prospective as u64,
                limit: TEXT_WRITE_LIMIT,
            });
        }

        self.elements = next;
        self.elements_cost = elements_cost;
        if app_state.is_some() {
            self.app_state = incoming.app_state;
            self.app_state_cost = app_state_cost;
        }
        self.files_cost += files_delta;
        for (k, v) in &new_files {
            self.files.insert(k.clone(), v.clone());
        }
        Ok(Applied {
            elements: changed,
            app_state,
            files: new_files,
        })
    }

    /// Elements in `(index, id)` order, lexicographic on both, exactly
    /// the dist's `orderByFractionalIndex` (fractional indexes sort
    /// lexicographically). The dist comparator is not a total order
    /// for index-less elements; those sort after indexed ones, by id.
    fn ordered(&self) -> Vec<(&String, &StoredElement)> {
        let mut all: Vec<_> = self.elements.iter().collect();
        all.sort_by(|(aid, a), (bid, b)| match (&a.index, &b.index) {
            (Some(ai), Some(bi)) => ai.cmp(bi).then_with(|| aid.cmp(bid)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => aid.cmp(bid),
        });
        all
    }

    /// Every element including tombstones, ordered; the attach
    /// snapshot payload (clients need tombstones so a stale local
    /// element cannot win reconciliation against a delete).
    pub fn elements_snapshot(&self) -> Vec<Value> {
        self.ordered()
            .into_iter()
            .map(|(_, el)| el.value.clone())
            .collect()
    }

    pub fn app_state(&self) -> &Map<String, Value> {
        &self.app_state
    }

    pub fn files(&self) -> &Map<String, Value> {
        &self.files
    }

    /// The on-disk `.excalidraw` form: non-deleted elements ordered,
    /// the files map filtered to entries a live element references
    /// (the dist's `filterOutDeletedFiles`), pretty-printed like the
    /// client's `serializeAsJSON(.., "local")`.
    pub fn serialize_file(&self) -> String {
        #[derive(Serialize)]
        struct SceneFile<'a> {
            #[serde(rename = "type")]
            kind: &'static str,
            version: u64,
            source: &'static str,
            elements: Vec<&'a Value>,
            #[serde(rename = "appState")]
            app_state: &'a Map<String, Value>,
            files: BTreeMap<&'a str, &'a Value>,
        }
        let live: Vec<&StoredElement> = self
            .ordered()
            .into_iter()
            .filter_map(|(_, el)| (!el.is_deleted).then_some(el))
            .collect();
        let files: BTreeMap<&str, &Value> = live
            .iter()
            .filter_map(|el| el.value.get("fileId").and_then(Value::as_str))
            .filter_map(|fid| self.files.get_key_value(fid))
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        serde_json::to_string_pretty(&SceneFile {
            kind: SCENE_FILE_TYPE,
            version: SCENE_FILE_VERSION,
            source: SCENE_FILE_SOURCE,
            elements: live.iter().map(|el| &el.value).collect(),
            app_state: &self.app_state,
            files,
        })
        .expect("serialize scene file")
    }

    // Test-surface accessor; production reads go through the typed
    // methods above.
    #[allow(dead_code)]
    pub fn element(&self, id: &str) -> Option<&StoredElement> {
        self.elements.get(id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MergeConflict;

/// Merge a dirty authority and an external file from their durable
/// baseline. Element ids are stable identities; within one element,
/// appState, and files, object keys are independent fields. Arrays and
/// scalar values remain atomic. A delete versus edit, two incompatible
/// additions under one id, duplicate ids, or a same-field edit is a
/// conflict.
pub(super) fn merge_three_way(
    baseline_text: &str,
    authority: &Scene,
    disk_text: &str,
) -> Result<String, MergeConflict> {
    let baseline = parse_merge_input(baseline_text)?;
    let disk = parse_merge_input(disk_text)?;

    let mut ids = BTreeSet::new();
    ids.extend(baseline.elements.keys().cloned());
    ids.extend(authority.elements.keys().cloned());
    ids.extend(disk.elements.keys().cloned());

    let mut elements = HashMap::new();
    for id in ids {
        let baseline_element = baseline.elements.get(&id).filter(|el| !el.is_deleted);
        let authority_element = authority.elements.get(&id).filter(|el| !el.is_deleted);
        let disk_element = disk.elements.get(&id).filter(|el| !el.is_deleted);
        let baseline_value = baseline_element.map(element_content);
        let authority_value = authority_element.map(element_content);
        let disk_value = disk_element.map(element_content);

        if baseline_element.is_none()
            && authority_element.is_some()
            && disk_element.is_some()
            && authority_value != disk_value
        {
            return Err(MergeConflict);
        }

        let merged_value = merge_value(
            baseline_value.as_ref(),
            authority_value.as_ref(),
            disk_value.as_ref(),
        )?;
        let Some(merged_value) = merged_value else {
            continue;
        };
        let merged = if authority_value.as_ref() == Some(&merged_value) {
            authority_element
                .expect("authority value came from an element")
                .clone()
        } else if disk_value.as_ref() == Some(&merged_value) {
            disk_element
                .expect("disk value came from an element")
                .clone()
        } else {
            build_element(
                &id,
                merged_value,
                baseline_element,
                authority_element,
                disk_element,
            )?
        };
        elements.insert(id, merged);
    }

    let app_state = merge_object(&baseline.app_state, &authority.app_state, &disk.app_state)?;
    let files = merge_object(&baseline.files, &authority.files, &disk.files)?;
    let elements_cost = elements.values().map(|el| el.cost).sum();
    let app_state_cost = value_cost(&Value::Object(app_state.clone()));
    let files_cost = files.iter().map(|(k, v)| k.len() + value_cost(v)).sum();
    let merged = Scene {
        elements,
        app_state,
        files,
        elements_cost,
        app_state_cost,
        files_cost,
    };
    let text = merged.serialize_file();
    if merged.total_cost() > TEXT_WRITE_LIMIT as usize || text.len() > TEXT_WRITE_LIMIT as usize {
        return Err(MergeConflict);
    }
    Ok(text)
}

fn parse_merge_input(text: &str) -> Result<Scene, MergeConflict> {
    if !text.trim().is_empty() {
        let root: Value = serde_json::from_str(text).map_err(|_| MergeConflict)?;
        let raw_elements = root
            .as_object()
            .and_then(|root| root.get("elements"))
            .filter(|elements| !elements.is_null());
        if let Some(raw_elements) = raw_elements {
            let raw_elements = raw_elements.as_array().ok_or(MergeConflict)?;
            let mut ids = HashSet::with_capacity(raw_elements.len());
            for element in raw_elements {
                let id = element
                    .as_object()
                    .and_then(|element| element.get("id"))
                    .and_then(Value::as_str)
                    .ok_or(MergeConflict)?;
                if !ids.insert(id) {
                    return Err(MergeConflict);
                }
            }
        }
    }
    Scene::parse(text).map_err(|_| MergeConflict)
}

pub(super) fn validate_merge_input(text: &str) -> Result<(), MergeConflict> {
    parse_merge_input(text).map(|_| ())
}

fn element_content(element: &StoredElement) -> Value {
    let mut value = element.value.clone();
    let object = value
        .as_object_mut()
        .expect("stored element value is an object");
    for metadata in ["id", "version", "versionNonce", "isDeleted"] {
        object.remove(metadata);
    }
    value
}

fn build_element(
    id: &str,
    content: Value,
    baseline: Option<&StoredElement>,
    authority: Option<&StoredElement>,
    disk: Option<&StoredElement>,
) -> Result<StoredElement, MergeConflict> {
    let mut object = content.as_object().cloned().ok_or(MergeConflict)?;
    let version = [baseline, authority, disk]
        .into_iter()
        .flatten()
        .map(|element| element.version)
        .max()
        .unwrap_or_default();
    let version_nonce = authority
        .or(disk)
        .or(baseline)
        .map_or(0, |element| element.version_nonce);
    object.insert("id".into(), id.into());
    object.insert("version".into(), version.into());
    object.insert("versionNonce".into(), version_nonce.into());
    object.insert("isDeleted".into(), false.into());
    StoredElement::from_value(Value::Object(object))
        .map(|(_, element)| element)
        .map_err(|_| MergeConflict)
}

fn merge_object(
    baseline: &Map<String, Value>,
    authority: &Map<String, Value>,
    disk: &Map<String, Value>,
) -> Result<Map<String, Value>, MergeConflict> {
    let merged = merge_value(
        Some(&Value::Object(baseline.clone())),
        Some(&Value::Object(authority.clone())),
        Some(&Value::Object(disk.clone())),
    )?
    .expect("three present objects produce a present object");
    merged.as_object().cloned().ok_or(MergeConflict)
}

fn merge_value(
    baseline: Option<&Value>,
    authority: Option<&Value>,
    disk: Option<&Value>,
) -> Result<Option<Value>, MergeConflict> {
    if authority == disk {
        return Ok(authority.cloned());
    }
    if authority == baseline {
        return Ok(disk.cloned());
    }
    if disk == baseline {
        return Ok(authority.cloned());
    }

    let (baseline, authority, disk) = match (baseline, authority, disk) {
        (
            Some(Value::Object(baseline)),
            Some(Value::Object(authority)),
            Some(Value::Object(disk)),
        ) => (Some(baseline), authority, disk),
        (None, Some(Value::Object(authority)), Some(Value::Object(disk))) => {
            (None, authority, disk)
        }
        _ => return Err(MergeConflict),
    };
    let mut keys = BTreeSet::new();
    if let Some(baseline) = baseline {
        keys.extend(baseline.keys().cloned());
    }
    keys.extend(authority.keys().cloned());
    keys.extend(disk.keys().cloned());
    let mut merged = Map::new();
    for key in keys {
        if let Some(value) = merge_value(
            baseline.and_then(|baseline| baseline.get(&key)),
            authority.get(&key),
            disk.get(&key),
        )? {
            merged.insert(key, value);
        }
    }
    Ok(Some(Value::Object(merged)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn el(id: &str, version: u64, nonce: u64, index: &str) -> Value {
        json!({
            "id": id,
            "type": "rectangle",
            "version": version,
            "versionNonce": nonce,
            "index": index,
            "isDeleted": false,
            "x": 10.5,
            "strokeColor": "#1e1e1e",
        })
    }

    fn with_text(mut value: Value, text: &str) -> Value {
        value
            .as_object_mut()
            .unwrap()
            .insert("text".into(), text.into());
        value
    }

    fn scene_of(elements: Vec<Value>) -> Scene {
        let mut scene = Scene::empty();
        scene.apply_push(elements, None, None).unwrap();
        scene
    }

    fn counting_nonce() -> (impl FnMut() -> u64, fn(u64) -> u64) {
        let mut n = 9000u64;
        (
            move || {
                n += 1;
                n
            },
            |i| 9000 + i,
        )
    }

    fn versions(scene: &Scene, id: &str) -> (u64, u64, bool) {
        let el = scene.element(id).unwrap();
        // The metadata and the value must never drift apart.
        assert_eq!(el.value["version"].as_u64().unwrap(), el.version);
        assert_eq!(el.value["versionNonce"].as_u64().unwrap(), el.version_nonce);
        assert_eq!(el.value["isDeleted"].as_bool().unwrap(), el.is_deleted);
        (el.version, el.version_nonce, el.is_deleted)
    }

    fn file(elements: Vec<Value>) -> String {
        json!({
            "elements": elements,
            "appState": {},
            "files": {},
        })
        .to_string()
    }

    // ---- three-way disk merge ----

    #[test]
    fn three_way_merges_distinct_fields_of_one_stable_element() {
        let baseline_element = el("x", 1, 1, "a1");
        let baseline = file(vec![baseline_element.clone()]);
        let mut authority_element = baseline_element.clone();
        authority_element["version"] = 2.into();
        authority_element["x"] = 20.into();
        let authority = Scene::parse(&file(vec![authority_element])).unwrap();
        let mut disk_element = baseline_element;
        disk_element["version"] = 2.into();
        disk_element["strokeColor"] = "#ff0000".into();
        let disk = file(vec![disk_element]);

        let merged = Scene::parse(&merge_three_way(&baseline, &authority, &disk).unwrap()).unwrap();
        let merged = &merged.element("x").unwrap().value;
        assert_eq!(merged["x"], 20);
        assert_eq!(merged["strokeColor"], "#ff0000");
    }

    #[test]
    fn three_way_rejects_same_field_delete_edit_and_duplicate_identity() {
        let baseline_element = el("x", 1, 1, "a1");
        let baseline = file(vec![baseline_element.clone()]);
        let mut authority_element = baseline_element.clone();
        authority_element["version"] = 2.into();
        authority_element["x"] = 20.into();
        let authority = Scene::parse(&file(vec![authority_element])).unwrap();
        let mut disk_element = baseline_element.clone();
        disk_element["version"] = 2.into();
        disk_element["x"] = 30.into();
        assert!(merge_three_way(&baseline, &authority, &file(vec![disk_element])).is_err());

        let deleted = Scene::parse(&file(vec![])).unwrap();
        let mut edited = baseline_element.clone();
        edited["version"] = 2.into();
        edited["x"] = 30.into();
        assert!(merge_three_way(&baseline, &deleted, &file(vec![edited])).is_err());

        let duplicate_disk = file(vec![baseline_element.clone(), baseline_element]);
        assert!(merge_three_way(&baseline, &authority, &duplicate_disk).is_err());
    }

    // ---- the LWW rule ----

    #[test]
    fn push_lww_matches_the_dist_rule() {
        // Stored: version 5, nonce 10.
        let base = || scene_of(vec![el("x", 5, 10, "a1")]);

        // Lower incoming version: stored wins.
        let mut s = base();
        let applied = s
            .apply_push(vec![with_text(el("x", 4, 99, "a1"), "in")], None, None)
            .unwrap();
        assert!(applied.elements.is_empty());
        assert_eq!(versions(&s, "x"), (5, 10, false));

        // Higher incoming version: incoming wins.
        let mut s = base();
        let applied = s
            .apply_push(vec![with_text(el("x", 6, 1, "a1"), "in")], None, None)
            .unwrap();
        assert_eq!(applied.elements.len(), 1);
        assert_eq!(versions(&s, "x"), (6, 1, false));
        assert_eq!(s.element("x").unwrap().value["text"], "in");

        // Version tie, stored nonce lower: stored wins.
        let mut s = base();
        let applied = s
            .apply_push(vec![with_text(el("x", 5, 11, "a1"), "in")], None, None)
            .unwrap();
        assert!(applied.elements.is_empty());
        assert_eq!(versions(&s, "x"), (5, 10, false));

        // Version tie, stored nonce higher: incoming wins.
        let mut s = base();
        let applied = s
            .apply_push(vec![with_text(el("x", 5, 9, "a1"), "in")], None, None)
            .unwrap();
        assert_eq!(applied.elements.len(), 1);
        assert_eq!(versions(&s, "x"), (5, 9, false));

        // Version and nonce both tie: incoming wins (dist semantics:
        // discard only on a strictly lower incoming nonce).
        let mut s = base();
        let applied = s
            .apply_push(vec![with_text(el("x", 5, 10, "a1"), "in")], None, None)
            .unwrap();
        assert_eq!(applied.elements.len(), 1);
        assert_eq!(s.element("x").unwrap().value["text"], "in");
    }

    #[test]
    fn push_resolves_same_id_sequentially_within_one_batch() {
        let mut s = Scene::empty();
        let applied = s
            .apply_push(vec![el("x", 5, 1, "a1"), el("x", 6, 1, "a1")], None, None)
            .unwrap();
        assert_eq!(applied.elements.len(), 2, "second beats the staged first");
        assert_eq!(versions(&s, "x"), (6, 1, false));

        let applied = s
            .apply_push(vec![el("x", 8, 1, "a1"), el("x", 7, 1, "a1")], None, None)
            .unwrap();
        assert_eq!(
            applied.elements.len(),
            1,
            "second loses to the staged first"
        );
        assert_eq!(versions(&s, "x"), (8, 1, false));
    }

    #[test]
    fn push_stores_tombstones_snapshot_carries_them_file_omits_them() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1"), el("y", 1, 1, "a2")]);
        let mut dead = el("y", 2, 1, "a2");
        dead.as_object_mut()
            .unwrap()
            .insert("isDeleted".into(), true.into());
        s.apply_push(vec![dead], None, None).unwrap();

        assert_eq!(versions(&s, "y"), (2, 1, true));
        let snapshot = s.elements_snapshot();
        assert_eq!(snapshot.len(), 2, "snapshot includes tombstones");
        let file: Value = serde_json::from_str(&s.serialize_file()).unwrap();
        let ids: Vec<&str> = file["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x"], "file form excludes tombstones");
    }

    #[test]
    fn push_rejects_malformed_payloads_untouched() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1")]);
        let before = s.clone();

        for (payload, app_state, files) in [
            (vec![json!("not an object")], None, None),
            (vec![json!({"type": "rectangle"})], None, None),
            (vec![json!({"id": 7})], None, None),
            (vec![], Some(json!([1, 2])), None),
            (vec![], None, Some(json!("nope"))),
        ] {
            let err = s.apply_push(payload, app_state, files).unwrap_err();
            assert!(matches!(err, SceneError::Invalid(_)), "{err}");
            assert_eq!(s, before, "failed push must not touch the scene");
        }
    }

    #[test]
    fn push_appstate_is_whole_object_lww_and_files_are_additive() {
        let mut s = Scene::empty();
        let applied = s
            .apply_push(
                vec![],
                Some(json!({"viewBackgroundColor": "#fff", "gridSize": 20})),
                None,
            )
            .unwrap();
        assert!(applied.app_state.is_some());

        // The next appState replaces the whole object, not a merge.
        let applied = s
            .apply_push(vec![], Some(json!({"gridSize": 40})), None)
            .unwrap();
        assert_eq!(applied.app_state, Some(json!({"gridSize": 40})));
        assert_eq!(s.app_state().len(), 1);
        assert!(s.app_state().get("viewBackgroundColor").is_none());

        // Absent and null appState both mean "not carried".
        let applied = s.apply_push(vec![], Some(Value::Null), None).unwrap();
        assert!(applied.app_state.is_none());
        assert_eq!(s.app_state().len(), 1);

        // Echoing the stored appState back is not a mutation: nothing
        // fans, so two live canvases can never ping-pong the object.
        let applied = s
            .apply_push(vec![], Some(json!({"gridSize": 40})), None)
            .unwrap();
        assert!(applied.app_state.is_none(), "equal appState never re-fans");
        assert!(applied.is_empty());

        // Files: a known id is immutable; only new entries land + fan.
        let f1 = json!({"mimeType": "image/png", "dataURL": "data:image/png;base64,AAAA"});
        s.apply_push(vec![], None, Some(json!({ "f1": f1 })))
            .unwrap();
        let applied = s
            .apply_push(
                vec![],
                None,
                Some(json!({"f1": {"dataURL": "data:tampered"}, "f2": {"dataURL": "data:new"}})),
            )
            .unwrap();
        assert_eq!(applied.files.len(), 1, "only the unknown entry is new");
        assert!(applied.files.contains_key("f2"));
        assert_eq!(s.files()["f1"], f1, "known entry untouched");
    }

    #[test]
    fn push_growth_cap_rejects_atomically() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1")]);
        let before = s.clone();
        let big = "y".repeat(TEXT_WRITE_LIMIT as usize);
        let err = s
            .apply_push(vec![with_text(el("big", 1, 1, "a2"), &big)], None, None)
            .unwrap_err();
        assert!(matches!(err, SceneError::TooLarge { .. }));
        assert_eq!(s, before, "over-cap push must not land partially");

        // Growth accumulates: two pushes that fit alone can trip the
        // cap together.
        let half = "z".repeat(TEXT_WRITE_LIMIT as usize * 3 / 5);
        s.apply_push(vec![with_text(el("a", 1, 1, "a3"), &half)], None, None)
            .unwrap();
        let err = s
            .apply_push(vec![with_text(el("b", 1, 1, "a4"), &half)], None, None)
            .unwrap_err();
        assert!(matches!(err, SceneError::TooLarge { .. }));
    }

    // ---- parse ----

    #[test]
    fn parse_accepts_empty_minimal_and_full_envelopes() {
        assert_eq!(Scene::parse("").unwrap(), Scene::empty());
        assert_eq!(Scene::parse(" \n\t").unwrap(), Scene::empty());
        assert_eq!(Scene::parse("{}").unwrap(), Scene::empty());

        let s = Scene::parse(
            r#"{"type":"excalidraw","version":2,"source":"https://excalidraw.com",
                "elements":[{"id":"x","version":3,"versionNonce":7,"index":"a1","isDeleted":false}],
                "appState":{"gridSize":20},"files":{"f1":{"dataURL":"data:x"}}}"#,
        )
        .unwrap();
        assert_eq!(versions(&s, "x"), (3, 7, false));
        assert_eq!(s.app_state()["gridSize"], 20);
        assert_eq!(s.files()["f1"]["dataURL"], "data:x");
    }

    #[test]
    fn parse_normalizes_missing_merge_metadata() {
        let s = Scene::parse(r#"{"elements":[{"id":"x","type":"rectangle"}]}"#).unwrap();
        assert_eq!(versions(&s, "x"), (0, 0, false));
        let snap = s.elements_snapshot();
        assert_eq!(snap[0]["version"], 0, "defaults materialized in the value");
        assert_eq!(snap[0]["versionNonce"], 0);
        assert_eq!(snap[0]["isDeleted"], false);
    }

    #[test]
    fn parse_keeps_the_first_of_duplicate_ids() {
        let s = Scene::parse(
            r#"{"elements":[
                {"id":"x","version":1,"versionNonce":1,"tag":"first"},
                {"id":"x","version":9,"versionNonce":9,"tag":"second"}]}"#,
        )
        .unwrap();
        assert_eq!(s.element("x").unwrap().value["tag"], "first");
    }

    #[test]
    fn parse_rejects_malformed_scenes() {
        for text in [
            "{oops",
            "[1,2]",
            "\"str\"",
            r#"{"elements":{}}"#,
            r#"{"elements":[42]}"#,
            r#"{"elements":[{"type":"rectangle"}]}"#,
            r#"{"appState":[]}"#,
            r#"{"files":7}"#,
        ] {
            assert!(
                matches!(Scene::parse(text), Err(SceneError::Invalid(_))),
                "should reject {text}"
            );
        }
    }

    // ---- replace semantics ----

    #[test]
    fn replace_hand_edit_bumps_past_stored_with_fresh_nonce() {
        let mut s = scene_of(vec![with_text(el("x", 5, 10, "a1"), "old")]);
        let (mut nonce, at) = counting_nonce();

        // The on-disk edit kept the flushed version but changed content.
        let body = json!({"elements": [with_text(el("x", 5, 10, "a1"), "edited")]}).to_string();
        let applied = s.apply_replace(&body, &mut nonce).unwrap();
        assert_eq!(applied.elements.len(), 1);
        assert_eq!(
            versions(&s, "x"),
            (6, at(1), false),
            "max(stored+1, incoming)"
        );
        assert_eq!(s.element("x").unwrap().value["text"], "edited");
        assert_eq!(
            applied.elements[0]["version"], 6,
            "fan value carries the bump"
        );
    }

    #[test]
    fn replace_keeps_a_higher_incoming_version() {
        let mut s = scene_of(vec![with_text(el("x", 5, 10, "a1"), "old")]);
        let (mut nonce, at) = counting_nonce();
        let body = json!({"elements": [with_text(el("x", 9, 1, "a1"), "edited")]}).to_string();
        s.apply_replace(&body, &mut nonce).unwrap();
        assert_eq!(versions(&s, "x"), (9, at(1), false));
    }

    #[test]
    fn replace_of_identical_content_is_silent() {
        let mut s = scene_of(vec![
            with_text(el("x", 5, 10, "a1"), "unicode \u{1f600} body"),
            el("y", 2, 3, "a2"),
        ]);
        s.apply_push(
            vec![],
            Some(json!({"viewBackgroundColor": "#123"})),
            Some(json!({"f1": {"dataURL": "data:x"}})),
        )
        .unwrap();
        // Tombstone one element; the file form will not carry it.
        let mut dead = el("y", 3, 3, "a2");
        dead.as_object_mut()
            .unwrap()
            .insert("isDeleted".into(), true.into());
        s.apply_push(vec![dead], None, None).unwrap();

        let before = s.clone();
        let (mut nonce, _) = counting_nonce();
        let text = s.serialize_file();
        let applied = s.apply_replace(&text, &mut nonce).unwrap();
        assert!(applied.is_empty(), "flush echo must be silent: {applied:?}");
        assert_eq!(s, before, "no restamps, tombstone kept, files kept");
    }

    #[test]
    fn replace_tombstones_absent_elements_and_never_resurrects_them() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1"), el("y", 4, 2, "a2")]);
        let (mut nonce, at) = counting_nonce();

        let body_only_x = json!({"elements": [el("x", 1, 1, "a1")]}).to_string();
        let applied = s.apply_replace(&body_only_x, &mut nonce).unwrap();
        assert_eq!(applied.elements.len(), 1, "only the tombstone fans");
        assert_eq!(applied.elements[0]["id"], "y");
        assert_eq!(applied.elements[0]["isDeleted"], true);
        assert_eq!(versions(&s, "y"), (5, at(1), true));

        // The same tombstone-less body again: the delete stays a
        // delete and nothing re-fans.
        let applied = s.apply_replace(&body_only_x, &mut nonce).unwrap();
        assert!(applied.is_empty());
        assert_eq!(versions(&s, "y"), (5, at(1), true));
    }

    #[test]
    fn replace_resurrects_an_id_the_body_readds() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1"), el("y", 4, 2, "a2")]);
        let (mut nonce, at) = counting_nonce();
        s.apply_replace(
            &json!({"elements": [el("x", 1, 1, "a1")]}).to_string(),
            &mut nonce,
        )
        .unwrap();
        assert_eq!(versions(&s, "y"), (5, at(1), true));

        // A body that re-adds y (say, restored from an old copy).
        let body =
            json!({"elements": [el("x", 1, 1, "a1"), with_text(el("y", 1, 9, "a2"), "back")]})
                .to_string();
        let applied = s.apply_replace(&body, &mut nonce).unwrap();
        assert_eq!(applied.elements.len(), 1);
        assert_eq!(
            versions(&s, "y"),
            (6, at(2), false),
            "bumped past the tombstone"
        );
        assert_eq!(s.element("y").unwrap().value["text"], "back");
    }

    #[test]
    fn replace_stores_new_elements_verbatim_and_adopts_appstate_and_files() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1")]);
        s.apply_push(vec![], None, Some(json!({"f1": {"dataURL": "data:kept"}})))
            .unwrap();
        let (mut nonce, _) = counting_nonce();
        let body = json!({
            "elements": [el("x", 1, 1, "a1"), el("z", 3, 7, "a0")],
            "appState": {"gridSize": 5},
            "files": {"f2": {"dataURL": "data:new"}},
        })
        .to_string();
        let applied = s.apply_replace(&body, &mut nonce).unwrap();

        // New element: no stored counterpart, stored verbatim (no bump).
        assert_eq!(versions(&s, "z"), (3, 7, false));
        // Changed list is ordered by (index, id): z at a0 before any
        // tombstone work; x unchanged so absent.
        assert_eq!(applied.elements.len(), 1);
        assert_eq!(applied.elements[0]["id"], "z");
        // appState adopted wholesale, files additive (f1 survives a
        // body that does not carry it).
        assert_eq!(applied.app_state, Some(json!({"gridSize": 5})));
        assert_eq!(s.app_state()["gridSize"], 5);
        assert_eq!(applied.files.len(), 1);
        assert!(s.files().contains_key("f1"));
        assert!(s.files().contains_key("f2"));
    }

    #[test]
    fn replace_rejects_bad_bodies_and_over_cap_growth_untouched() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1")]);
        let before = s.clone();
        let (mut nonce, _) = counting_nonce();

        for text in ["{nope", r#"{"elements":[{"noid":1}]}"#] {
            assert!(matches!(
                s.apply_replace(text, &mut nonce),
                Err(SceneError::Invalid(_))
            ));
            assert_eq!(s, before);
        }

        let big = "y".repeat(TEXT_WRITE_LIMIT as usize + 16);
        let body = json!({"elements": [with_text(el("big", 1, 1, "a2"), &big)]}).to_string();
        assert!(matches!(
            s.apply_replace(&body, &mut nonce),
            Err(SceneError::TooLarge { .. })
        ));
        assert_eq!(s, before);
    }

    // ---- ordering and the file form ----

    #[test]
    fn ordering_is_index_then_id_with_indexless_last() {
        let mut indexless = json!({"id": "m", "version": 1, "versionNonce": 1});
        indexless
            .as_object_mut()
            .unwrap()
            .insert("isDeleted".into(), false.into());
        let s = scene_of(vec![
            el("b", 1, 1, "a2"),
            el("a", 1, 1, "a2"),
            el("z", 1, 1, "a1"),
            indexless,
        ]);
        let ids: Vec<String> = s
            .elements_snapshot()
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, ["z", "a", "b", "m"]);
    }

    #[test]
    fn serialize_file_pins_envelope_order_pretty_form_and_file_filtering() {
        let mut s = scene_of(vec![el("x", 1, 1, "a1")]);
        let mut img = el("img", 1, 1, "a2");
        img.as_object_mut()
            .unwrap()
            .insert("fileId".into(), "f-live".into());
        let mut dead_img = el("gone", 2, 1, "a3");
        let dead_obj = dead_img.as_object_mut().unwrap();
        dead_obj.insert("fileId".into(), "f-dead".into());
        dead_obj.insert("isDeleted".into(), true.into());
        s.apply_push(
            vec![img, dead_img],
            Some(json!({"gridSize": 20})),
            Some(json!({
                "f-live": {"dataURL": "data:live"},
                "f-dead": {"dataURL": "data:dead"},
                "f-orphan": {"dataURL": "data:orphan"},
            })),
        )
        .unwrap();

        let text = s.serialize_file();
        assert!(
            text.starts_with(
                "{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"chan\","
            ),
            "envelope key order and 2-space pretty form: {text}"
        );

        let file: Value = serde_json::from_str(&text).unwrap();
        let ids: Vec<&str> = file["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x", "img"], "ordered, tombstone excluded");
        let files = file["files"].as_object().unwrap();
        assert_eq!(
            files.keys().collect::<Vec<_>>(),
            ["f-live"],
            "only files a live element references are written"
        );
        // The in-memory map keeps everything (resurrection safety).
        assert_eq!(s.files().len(), 3);
    }

    #[test]
    fn file_form_round_trips_through_parse_and_replace_silently() {
        let mut s = scene_of(vec![
            with_text(
                el("x", 5, 10, "a1"),
                "emoji \u{1f469}\u{200d}\u{1f469} text",
            ),
            el("y", 1, 2, "a2"),
        ]);
        s.apply_push(vec![], Some(json!({"viewBackgroundColor": "#abc"})), None)
            .unwrap();

        let text = s.serialize_file();
        let reparsed = Scene::parse(&text).unwrap();
        assert_eq!(reparsed.serialize_file(), text, "parse/serialize fixpoint");

        let (mut nonce, _) = counting_nonce();
        let applied = s.apply_replace(&text, &mut nonce).unwrap();
        assert!(applied.is_empty(), "own file form must replace silently");
    }
}
