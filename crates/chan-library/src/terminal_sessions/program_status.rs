//! OSC 7501 program reports, retained independently of the output broadcast.

use std::sync::Arc;

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::program_status_query::Terminator;

/// Origin of a status record; ids are unique only within this source.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProgramStatusSource {
    Program,
    Chan,
}

/// A retained program state. Clear is an action, never a stored state.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProgramState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

/// What a blocked program needs from the user.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProgramStatusKind {
    Permission,
    Question,
    Auth,
}

/// One complete report. Text is decoded, bounded UTF-8; it remains untrusted.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProgramStatusRecord {
    pub source: ProgramStatusSource,
    /// None identifies the root, not an empty id.
    pub id: Option<String>,
    pub state: ProgramState,
    pub kind: Option<ProgramStatusKind>,
    pub progress: Option<u8>,
    /// The reported value, before any display-time ancestor inheritance.
    pub app: Option<String>,
    pub title: Option<String>,
    pub msg: Option<String>,
    pub seen: bool,
    /// Strictly increasing replacement order; a seen change preserves it.
    pub update_order: u64,
}

/// The current set in increasing update order, including an empty set.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProgramStatusSnapshot {
    pub revision: u64,
    pub records: Vec<ProgramStatusRecord>,
}

/// Program records and framing captured at the restart manifest's byte position.
/// Chan-owned requests, foreground attribution and query state are not persisted.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct StoredProgramStatus {
    revision: u64,
    next_update_order: u64,
    records: Vec<StoredProgramRecord>,
    framing: Framing,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct StoredProgramRecord {
    id: Option<String>,
    state: ProgramState,
    kind: Option<ProgramStatusKind>,
    progress: Option<u8>,
    app: Option<String>,
    title: Option<String>,
    msg: Option<String>,
    seen: bool,
    update_order: u64,
}

#[cfg(target_os = "linux")]
impl From<ProgramStatusRecord> for StoredProgramRecord {
    fn from(record: ProgramStatusRecord) -> Self {
        Self {
            id: record.id,
            state: record.state,
            kind: record.kind,
            progress: record.progress,
            app: record.app,
            title: record.title,
            msg: record.msg,
            seen: record.seen,
            update_order: record.update_order,
        }
    }
}

#[cfg(target_os = "linux")]
impl From<StoredProgramRecord> for ProgramStatusRecord {
    fn from(record: StoredProgramRecord) -> Self {
        Self {
            source: ProgramStatusSource::Program,
            id: record.id,
            state: record.state,
            kind: record.kind,
            progress: record.progress,
            app: record.app,
            title: record.title,
            msg: record.msg,
            seen: record.seen,
            update_order: record.update_order,
        }
    }
}

pub(super) const MAX_SEQUENCE_BYTES: usize = 4096;
pub(super) const MAX_BODY_BYTES: usize = MAX_SEQUENCE_BYTES - 9;
pub(super) const MAX_KEY_BYTES: usize = 16;
pub(super) const MAX_MSG_ENCODED_BYTES: usize = 2732;
pub(super) const MAX_MSG_BYTES: usize = 2048;
pub(super) const MAX_TITLE_ENCODED_BYTES: usize = 256;
pub(super) const MAX_TITLE_BYTES: usize = 192;
pub(super) const MAX_APP_BYTES: usize = 32;
pub(super) const MAX_ID_BYTES: usize = 128;
pub(super) const MAX_ID_SEGMENT_BYTES: usize = 32;
pub(super) const MAX_ID_DEPTH: usize = 8;
pub(super) const RECORD_CAP: usize = 64;
const REQUEST_CAP: usize = 16;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReportError {
    TooLong,
    InvalidId,
    InvalidText,
    InvalidState,
}

#[derive(Debug)]
pub(super) enum Report {
    Replace(ProgramStatusRecord),
    Clear(Option<String>),
}

fn whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | 0x09..=0x0d)
}

fn trim(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(|b| whitespace(*b)) {
        bytes = &bytes[1..];
    }
    while bytes.last().is_some_and(|b| whitespace(*b)) {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

fn name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'+' | b'-')
}

fn name(bytes: &[u8]) -> bool {
    !bytes.is_empty() && bytes.iter().copied().all(name_byte)
}

fn validate_id(value: &[u8]) -> Result<(), ReportError> {
    if value.len() > MAX_ID_BYTES {
        return Err(ReportError::TooLong);
    }
    let mut depth = 0;
    for segment in value.split(|b| *b == b'/') {
        depth += 1;
        if depth > MAX_ID_DEPTH || segment.len() > MAX_ID_SEGMENT_BYTES {
            return Err(ReportError::TooLong);
        }
        if !name(segment) {
            return Err(ReportError::InvalidId);
        }
    }
    Ok(())
}

fn progress(value: &[u8]) -> Option<u8> {
    if value.is_empty() {
        return None;
    }
    let mut n = 0u16;
    for &byte in value {
        if !byte.is_ascii_digit() {
            return None;
        }
        n = n * 10 + u16::from(byte - b'0');
        if n > 100 {
            return None;
        }
    }
    Some(n as u8)
}

pub(super) fn decode_text(encoded: &[u8], limit: usize) -> Result<Option<String>, ReportError> {
    if encoded.is_empty() {
        return Ok(None);
    }
    let engine = if encoded.ends_with(b"=") {
        STANDARD
    } else {
        STANDARD_NO_PAD
    };
    let decoded = engine
        .decode(encoded)
        .map_err(|_| ReportError::InvalidText)?;
    if decoded.len() > limit {
        return Err(ReportError::TooLong);
    }
    let text = String::from_utf8(decoded).map_err(|_| ReportError::InvalidText)?;
    if text
        .chars()
        .any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}'))
    {
        return Err(ReportError::InvalidText);
    }
    Ok(Some(text))
}

/// Validate every pair of an unframed report before producing an action.
/// Framing and query handling belong to callers.
pub(super) fn parse_report(body: &[u8]) -> Result<Report, ReportError> {
    if body.len() > MAX_BODY_BYTES {
        return Err(ReportError::TooLong);
    }
    for pair in body.split(|b| *b == b':') {
        let Some(eq) = pair.iter().position(|b| *b == b'=') else {
            continue;
        };
        // Key size applies even when a malformed value will be skipped.
        if trim(&pair[..eq]).len() > MAX_KEY_BYTES {
            return Err(ReportError::TooLong);
        }
    }
    let mut state = None;
    let mut id = None;
    let mut kind = None;
    let mut percentage = None;
    let mut app = None;
    let mut title = None;
    let mut msg = None;
    for pair in body.split(|b| *b == b':') {
        let Some(eq) = pair.iter().position(|b| *b == b'=') else {
            continue;
        };
        let key = trim(&pair[..eq]);
        let value = trim(&pair[eq + 1..]);
        if key.is_empty()
            || !value
                .iter()
                .all(|b| name_byte(*b) || matches!(b, b',' | b'/' | b'='))
        {
            continue;
        }
        match key {
            b"state" => state = Some(value),
            b"id" => {
                validate_id(value)?;
                id = Some(value);
            }
            b"kind" => kind = Some(value),
            b"progress" => percentage = Some(value),
            b"app" => {
                if value.len() > MAX_APP_BYTES {
                    return Err(ReportError::TooLong);
                }
                app = Some(value);
            }
            b"title" => {
                if value.len() > MAX_TITLE_ENCODED_BYTES {
                    return Err(ReportError::TooLong);
                }
                title = Some(value);
            }
            b"msg" => {
                if value.len() > MAX_MSG_ENCODED_BYTES {
                    return Err(ReportError::TooLong);
                }
                msg = Some(value);
            }
            _ => {}
        }
    }
    let title = decode_text(title.unwrap_or_default(), MAX_TITLE_BYTES)?;
    let msg = decode_text(msg.unwrap_or_default(), MAX_MSG_BYTES)?;
    // Every retained non-text value has passed the ASCII value alphabet.
    let ascii = |v: &[u8]| String::from_utf8(v.to_vec()).expect("validated ASCII status value");
    let id = id.map(ascii);
    let state = match state {
        Some(b"idle") => ProgramState::Idle,
        Some(b"working") => ProgramState::Working,
        Some(b"done") => ProgramState::Done,
        Some(b"blocked") => ProgramState::Blocked,
        Some(b"error") => ProgramState::Error,
        Some(b"clear") => return Ok(Report::Clear(id)),
        _ => return Err(ReportError::InvalidState),
    };
    let kind = if state == ProgramState::Blocked {
        match kind {
            Some(b"permission") => Some(ProgramStatusKind::Permission),
            Some(b"question") => Some(ProgramStatusKind::Question),
            Some(b"auth") => Some(ProgramStatusKind::Auth),
            _ => None,
        }
    } else {
        None
    };
    let percentage = if matches!(state, ProgramState::Working | ProgramState::Blocked) {
        percentage.and_then(progress)
    } else {
        None
    };
    Ok(Report::Replace(ProgramStatusRecord {
        source: ProgramStatusSource::Program,
        id,
        state,
        kind,
        progress: percentage,
        app: app.filter(|v| name(v)).map(ascii),
        title,
        msg,
        seen: false,
        update_order: 0,
    }))
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum OscCommand {
    ProgramStatus,
    Prompt,
}

/// Enough state to continue any unfinished sequence after a sealed restart.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(super) enum Framing {
    #[default]
    Ground,
    Escape,
    EscapeIntermediate,
    Csi,
    OscIdentifier {
        identifier: Vec<u8>,
    },
    OscBody {
        command: OscCommand,
        body: Vec<u8>,
    },
    OscDiscard,
    String {
        bel_ends: bool,
    },
}

enum Dispatch {
    Osc(OscCommand, Vec<u8>, Terminator),
    Reset,
}

impl Framing {
    fn unchanged_prefix(&self, bytes: &[u8]) -> usize {
        match self {
            Self::Ground => memchr::memchr(0x1b, bytes).unwrap_or(bytes.len()),
            Self::OscDiscard | Self::String { bel_ends: true } => {
                let boundary = memchr::memchr3(0x1b, 0x18, 0x1a, bytes).unwrap_or(bytes.len());
                memchr::memchr(0x07, &bytes[..boundary]).unwrap_or(boundary)
            }
            Self::String { bel_ends: false } => {
                memchr::memchr3(0x1b, 0x18, 0x1a, bytes).unwrap_or(bytes.len())
            }
            _ => 0,
        }
    }

    fn advance(&mut self, byte: u8) -> Option<Dispatch> {
        if matches!(byte, 0x18 | 0x1a) {
            *self = Self::Ground;
            return None;
        }
        if byte == 0x1b {
            let dispatch = match self {
                Self::OscBody { command, body } => Some(Dispatch::Osc(
                    *command,
                    std::mem::take(body),
                    Terminator::Escape,
                )),
                _ => None,
            };
            *self = Self::Escape;
            return dispatch;
        }
        match self {
            Self::Ground => {}
            Self::Escape => {
                *self = match byte {
                    b'[' => Self::Csi,
                    b']' => Self::OscIdentifier {
                        identifier: Vec::new(),
                    },
                    b'P' | b'X' | b'^' | b'_' => Self::String { bel_ends: false },
                    b'c' => {
                        *self = Self::Ground;
                        return Some(Dispatch::Reset);
                    }
                    0x20..=0x2f => Self::EscapeIntermediate,
                    0x00..=0x1f => Self::Escape,
                    _ => Self::Ground,
                };
            }
            Self::EscapeIntermediate => {
                if byte > 0x2f {
                    *self = Self::Ground;
                }
            }
            Self::Csi => {
                if byte > 0x3f {
                    *self = Self::Ground;
                }
            }
            Self::OscIdentifier { identifier } => {
                if byte == 0x07 {
                    *self = Self::Ground;
                } else if byte == b';' {
                    *self = match identifier.as_slice() {
                        b"7501" => Self::OscBody {
                            command: OscCommand::ProgramStatus,
                            body: Vec::new(),
                        },
                        b"133" => Self::OscBody {
                            command: OscCommand::Prompt,
                            body: Vec::new(),
                        },
                        _ => Self::OscDiscard,
                    };
                } else {
                    identifier.push(byte);
                    if !b"7501".starts_with(identifier) && !b"133".starts_with(identifier) {
                        *self = Self::OscDiscard;
                    }
                }
            }
            Self::OscBody { command, body } => {
                if byte == 0x07 {
                    let dispatch = Dispatch::Osc(*command, std::mem::take(body), Terminator::Bell);
                    *self = Self::Ground;
                    return Some(dispatch);
                } else if body.len() == MAX_BODY_BYTES {
                    *self = Self::OscDiscard;
                } else {
                    body.push(byte);
                }
            }
            Self::OscDiscard => {
                if byte == 0x07 {
                    *self = Self::Ground;
                }
            }
            Self::String { bel_ends } => {
                if *bel_ends && byte == 0x07 {
                    *self = Self::Ground;
                }
            }
        }
        None
    }
}

#[derive(Debug)]
struct StoredRecord {
    record: ProgramStatusRecord,
    /// Ephemeral attribution, never included in the wire or restart state.
    #[cfg(unix)]
    foreground_group: Option<u32>,
}

#[derive(Debug)]
pub(super) struct ProgramStatus {
    pub(super) published: watch::Sender<Arc<ProgramStatusSnapshot>>,
    records: Vec<StoredRecord>,
    requests: Vec<ProgramStatusRecord>,
    next_request_token: u64,
    revision: u64,
    next_update_order: u64,
    pub(super) framing: Framing,
    finalized: bool,
    sealed: bool,
    #[cfg(test)]
    pub(super) publications: usize,
}

impl Default for ProgramStatus {
    fn default() -> Self {
        Self {
            published: watch::channel(Arc::new(ProgramStatusSnapshot::default())).0,
            records: Vec::new(),
            requests: Vec::new(),
            next_request_token: 0,
            revision: 0,
            next_update_order: 0,
            framing: Framing::Ground,
            finalized: false,
            sealed: false,
            #[cfg(test)]
            publications: 0,
        }
    }
}

impl ProgramStatus {
    pub(super) fn reserve_request(&mut self, prefix: &str) -> Option<String> {
        if self.finalized || self.sealed {
            return None;
        }
        self.next_request_token = self.next_request_token.checked_add(1)?;
        Some(format!("{prefix}/{:016x}", self.next_request_token))
    }

    pub(super) fn set_request(&mut self, mut record: ProgramStatusRecord) -> bool {
        if self.finalized || self.sealed {
            return false;
        }
        let Some(revision) = self.revision.checked_add(1) else {
            return false;
        };
        let Some(order) = self.next_update_order.checked_add(1) else {
            return false;
        };
        let replaced = self.requests.iter().position(|old| old.id == record.id);
        let removed = replaced.or_else(|| {
            (self.requests.len() == REQUEST_CAP)
                .then(|| {
                    self.requests
                        .iter()
                        .position(|r| r.seen && r.state == ProgramState::Error)
                })
                .flatten()
        });
        if let Some(index) = removed {
            self.requests.remove(index);
        } else if self.requests.len() == REQUEST_CAP {
            return false;
        }
        record.update_order = order;
        self.requests.push(record);
        self.next_update_order = order;
        let before = self.revision;
        self.revision = revision;
        self.publish_if_changed(before);
        true
    }

    pub(super) fn remove_request(&mut self, id: &str) {
        if self.finalized || self.sealed {
            return;
        }
        let before = self.revision;
        let Some(revision) = before.checked_add(1) else {
            return;
        };
        let len = self.requests.len();
        self.requests
            .retain(|record| record.id.as_deref() != Some(id));
        if self.requests.len() != len {
            self.revision = revision;
        }
        self.publish_if_changed(before);
    }

    pub(super) fn clear_requests(&mut self) {
        if self.sealed || self.requests.is_empty() {
            return;
        }
        let before = self.revision;
        let Some(revision) = before.checked_add(1) else {
            return;
        };
        self.requests.clear();
        self.revision = revision;
        self.publish_if_changed(before);
    }

    #[cfg(target_os = "linux")]
    pub(super) fn seal(&mut self) {
        self.sealed = true;
    }

    #[cfg(target_os = "linux")]
    pub(super) fn stored(&self) -> StoredProgramStatus {
        StoredProgramStatus {
            revision: self.revision,
            next_update_order: self.next_update_order,
            records: self
                .records
                .iter()
                .filter(|stored| stored.record.source == ProgramStatusSource::Program)
                .map(|stored| stored.record.clone().into())
                .collect(),
            framing: self.framing.clone(),
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn restored(stored: StoredProgramStatus) -> Self {
        let Some(revision) = stored.revision.checked_add(1) else {
            return Self::default();
        };
        let mut status = Self {
            records: stored
                .records
                .into_iter()
                .map(|record| StoredRecord {
                    record: record.into(),
                    foreground_group: None,
                })
                .collect(),
            revision,
            next_update_order: stored.next_update_order,
            framing: stored.framing,
            ..Self::default()
        };
        status.publish_if_changed(stored.revision);
        status
    }

    pub(super) fn feed(
        &mut self,
        bytes: &[u8],
        focused: bool,
        mut foreground_group: impl FnMut() -> Option<u32>,
        mut query: impl FnMut(Terminator),
    ) {
        if self.finalized || self.sealed {
            return;
        }
        let before = self.revision;
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let unchanged = self.framing.unchanged_prefix(remaining);
            remaining = &remaining[unchanged..];
            let Some((&byte, rest)) = remaining.split_first() else {
                break;
            };
            remaining = rest;
            match self.framing.advance(byte) {
                Some(Dispatch::Osc(OscCommand::ProgramStatus, body, end)) if body == b"?" => {
                    query(end)
                }
                Some(Dispatch::Osc(OscCommand::ProgramStatus, body, _)) => {
                    if let Ok(mut report) = parse_report(&body) {
                        if let Report::Replace(record) = &mut report {
                            record.seen = focused
                                && matches!(record.state, ProgramState::Done | ProgramState::Error);
                        }
                        let group = match &report {
                            Report::Replace(record)
                                if matches!(
                                    record.state,
                                    ProgramState::Idle
                                        | ProgramState::Working
                                        | ProgramState::Blocked
                                ) =>
                            {
                                foreground_group()
                            }
                            _ => None,
                        };
                        self.apply(report, group);
                    }
                }
                Some(Dispatch::Reset) => self.apply(Report::Clear(None), None),
                Some(Dispatch::Osc(OscCommand::Prompt, body, _))
                    if body == b"A" || body.starts_with(b"A;") =>
                {
                    self.drop_transient();
                }
                Some(Dispatch::Osc(OscCommand::Prompt, _, _)) | None => {}
            }
        }
        self.publish_if_changed(before);
    }

    pub(super) fn apply_control(
        &mut self,
        mut report: Report,
        focused: bool,
        foreground_group: impl FnOnce() -> Option<u32>,
    ) -> Result<(), &'static str> {
        if self.finalized || self.sealed {
            return Err("terminal session no longer accepts program status");
        }
        if self.revision == u64::MAX
            || (matches!(report, Report::Replace(_)) && self.next_update_order == u64::MAX)
        {
            return Err("program status counter limit reached");
        }
        let group = match &mut report {
            Report::Replace(record) => {
                let completion = matches!(record.state, ProgramState::Done | ProgramState::Error);
                record.seen = focused && completion;
                if completion {
                    None
                } else {
                    foreground_group()
                }
            }
            Report::Clear(_) => None,
        };
        let before = self.revision;
        self.apply(report, group);
        self.publish_if_changed(before);
        Ok(())
    }

    pub(super) fn mark_seen(&mut self) {
        if self.sealed {
            return;
        }
        let before = self.revision;
        let Some(revision) = before.checked_add(1) else {
            return;
        };
        let len = self.requests.len();
        self.requests
            .retain(|record| record.state != ProgramState::Error);
        if self.requests.len() != len {
            self.revision = revision;
        }
        for record in &mut self.records {
            let record = &mut record.record;
            if !record.seen && matches!(record.state, ProgramState::Done | ProgramState::Error) {
                record.seen = true;
                self.revision = revision;
            }
        }
        self.publish_if_changed(before);
    }

    fn drop_transient(&mut self) {
        let Some(revision) = self.revision.checked_add(1) else {
            return;
        };
        let before = self.records.len();
        self.records.retain(|stored| {
            stored.record.source != ProgramStatusSource::Program
                || matches!(
                    stored.record.state,
                    ProgramState::Done | ProgramState::Error
                )
        });
        if before != self.records.len() {
            self.revision = revision;
        }
    }

    pub(super) fn finalize(&mut self) {
        if self.finalized || self.sealed {
            return;
        }
        self.finalized = true;
        let before = self.revision;
        if !self.requests.is_empty() {
            if let Some(revision) = self.revision.checked_add(1) {
                self.requests.clear();
                self.revision = revision;
            }
        }
        self.drop_transient();
        self.publish_if_changed(before);
    }

    #[cfg(unix)]
    pub(super) fn tagged_records(&self) -> Vec<(u64, u32)> {
        self.records
            .iter()
            .filter_map(|stored| {
                stored
                    .foreground_group
                    .map(|group| (stored.record.update_order, group))
            })
            .collect()
    }

    #[cfg(unix)]
    pub(super) fn remove_gone_groups(&mut self, orders: &[u64]) {
        if self.sealed {
            return;
        }
        let before = self.revision;
        let Some(revision) = before.checked_add(1) else {
            return;
        };
        let len = self.records.len();
        self.records
            .retain(|stored| !orders.contains(&stored.record.update_order));
        if self.records.len() != len {
            self.revision = revision;
        }
        self.publish_if_changed(before);
    }

    fn publish_if_changed(&mut self, before: u64) {
        if self.revision != before {
            let mut records: Vec<_> = self
                .records
                .iter()
                .map(|stored| stored.record.clone())
                .chain(self.requests.iter().cloned())
                .collect();
            records.sort_unstable_by_key(|record| record.update_order);
            self.published.send_replace(Arc::new(ProgramStatusSnapshot {
                revision: self.revision,
                records,
            }));
            #[cfg(test)]
            {
                self.publications += 1;
            }
        }
    }

    fn apply(&mut self, report: Report, foreground_group: Option<u32>) {
        #[cfg(not(unix))]
        let _ = foreground_group;
        let Some(revision) = self.revision.checked_add(1) else {
            return;
        };
        match report {
            Report::Replace(mut record) => {
                let Some(order) = self.next_update_order.checked_add(1) else {
                    return;
                };
                self.records
                    .retain(|existing| existing.record.id != record.id);
                if self.records.len() == RECORD_CAP {
                    self.records.remove(0);
                }
                record.update_order = order;
                #[cfg(unix)]
                let foreground_group =
                    if matches!(record.state, ProgramState::Done | ProgramState::Error) {
                        None
                    } else {
                        foreground_group
                    };
                self.records.push(StoredRecord {
                    record,
                    #[cfg(unix)]
                    foreground_group,
                });
                self.next_update_order = order;
            }
            Report::Clear(id) => {
                let before = self.records.len();
                self.records.retain(
                    |stored| match (id.as_deref(), stored.record.id.as_deref()) {
                        (None, _) => false,
                        (Some(_), None) => true,
                        (Some(parent), Some(child)) => {
                            child != parent
                                && !child
                                    .strip_prefix(parent)
                                    .is_some_and(|suffix| suffix.starts_with('/'))
                        }
                    },
                );
                if self.records.len() == before {
                    return;
                }
            }
        }
        self.revision = revision;
    }
}
