//! Incarnation-bound status for requests owned by the control server.

use std::sync::{atomic::Ordering, Arc, Weak};

use super::{
    ProgramState, ProgramStatusKind, ProgramStatusRecord, ProgramStatusSource, Registry, Session,
};

/// A control request whose lifetime is visible in its caller's terminal.
pub enum ChanRequestStatus<'a> {
    /// Blocked on a question, using the survey's optional title.
    Survey(&'a str),
    /// Working while a renderer handles the export.
    Export,
    /// A tunnel is invisible until its listener is acknowledged.
    Tunnel,
}

/// Removes one request's mark on drop, without addressing a replacement session.
/// A tunnel failure can instead leave an error until the terminal is seen.
pub struct ChanStatusLease {
    session: Weak<Session>,
    id: String,
    enabled: bool,
}

impl Registry {
    /// Mark a request against the named live incarnation. Missing identity or
    /// exhausted status capacity never prevents the underlying request.
    pub fn lease_request_status(
        &self,
        session_id: Option<&str>,
        request: ChanRequestStatus<'_>,
    ) -> Option<ChanStatusLease> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let session = sessions.get(session_id?)?;
        let mut output = session.output.lock().expect("terminal output poisoned");
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        let prefix = match request {
            ChanRequestStatus::Survey(_) => "survey",
            ChanRequestStatus::Export => "export",
            ChanRequestStatus::Tunnel => "tunnel",
        };
        let id = output.status.reserve_request(prefix)?;
        let record = match request {
            ChanRequestStatus::Survey(title) => Some(request_record(
                &id,
                ProgramState::Blocked,
                Some(ProgramStatusKind::Question),
                Some(title),
                None,
            )),
            ChanRequestStatus::Export => Some(request_record(
                &id,
                ProgramState::Working,
                None,
                Some("Export"),
                None,
            )),
            ChanRequestStatus::Tunnel => None,
        };
        if record.is_some_and(|record| !output.status.set_request(record)) {
            return None;
        }
        Some(ChanStatusLease {
            session: Arc::downgrade(session),
            id,
            enabled: true,
        })
    }
}

impl ChanStatusLease {
    /// Publish the acknowledged listener and its destination. A full own set
    /// disables this lease, including any later failure mark.
    pub fn tunnel_ready(&mut self, bound: &str, devserver_port: u16) {
        let message = format!(
            "desktop {} -> devserver 127.0.0.1:{devserver_port}",
            clip_text(bound, super::program_status::MAX_MSG_BYTES)
        );
        self.set(ProgramState::Working, &message);
    }

    /// Retain a fixed error until seen, instead of removing it on drop.
    pub fn tunnel_failed(mut self, was_ready: bool) {
        self.set(
            ProgramState::Error,
            if was_ready {
                "Tunnel closed by the desktop"
            } else {
                "Tunnel could not be opened"
            },
        );
        self.enabled = false;
    }

    fn set(&mut self, state: ProgramState, message: &str) {
        if !self.enabled {
            return;
        }
        let Some(session) = self.session.upgrade() else {
            return;
        };
        let mut output = session.output.lock().expect("terminal output poisoned");
        if session.closed.load(Ordering::Relaxed) {
            return;
        }
        if state == ProgramState::Error && session.focus_epoch.load(Ordering::Relaxed) != 0 {
            output.status.remove_request(&self.id);
            return;
        }
        self.enabled = output.status.set_request(request_record(
            &self.id,
            state,
            None,
            Some("Tunnel"),
            Some(message),
        ));
    }
}

impl Drop for ChanStatusLease {
    fn drop(&mut self) {
        if !self.enabled {
            return;
        }
        if let Some(session) = self.session.upgrade() {
            let mut output = session.output.lock().expect("terminal output poisoned");
            if !session.closed.load(Ordering::Relaxed) {
                output.status.remove_request(&self.id);
            }
        }
    }
}

fn request_record(
    id: &str,
    state: ProgramState,
    kind: Option<ProgramStatusKind>,
    title: Option<&str>,
    msg: Option<&str>,
) -> ProgramStatusRecord {
    ProgramStatusRecord {
        source: ProgramStatusSource::Chan,
        id: Some(id.into()),
        state,
        kind,
        progress: None,
        app: Some("cs".into()),
        title: title
            .map(|s| clip_text(s, super::program_status::MAX_TITLE_BYTES))
            .filter(|s| !s.is_empty()),
        msg: msg
            .map(|s| clip_text(s, super::program_status::MAX_MSG_BYTES))
            .filter(|s| !s.is_empty()),
        seen: false,
        update_order: 0,
    }
}

fn clip_text(text: &str, limit: usize) -> String {
    let mut output = String::new();
    for ch in text.chars() {
        let ch = if matches!(ch, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}') {
            '\u{fffd}'
        } else {
            ch
        };
        if output.len() + ch.len_utf8() > limit {
            break;
        }
        output.push(ch);
    }
    output
}
