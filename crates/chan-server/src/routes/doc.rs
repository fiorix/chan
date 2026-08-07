//! Live co-editing document sessions: the `/api/doc/ws` WebSocket route.
//!
//! One duplex socket per (editor mount, document) attachment, modeled on
//! the terminal route rather than the tenant-wide `/ws` broadcast: doc
//! traffic is keystroke-scale and per-path, and a lost or reordered frame
//! permanently desyncs a peer, so every attachment gets its own lossless
//! per-socket FIFO. chan-server is the central authority in the
//! `@codemirror/collab` update-log model: clients push `{version,
//! updates}`, the authority accepts a push only at a matching version
//! (a stale push rebases client-side and retries), and never transforms.
//!
//! The frame enums below ARE the wire contract the SPA's docSync layer
//! builds against; the serde tests in this module pin every tag, field
//! name, and shape. Change a pin only together with the client.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::doc_sessions::changes::{ApplyError, UpdateJson};
use crate::doc_sessions::PushError;
use crate::signal::now_unix_secs;
use crate::state::AppState;

/// Query parameters for `GET /api/doc/ws`.
#[derive(Debug, Deserialize)]
pub struct DocQuery {
    /// Workspace-relative POSIX path of the document to attach.
    path: String,
    /// The attaching window's `window_id`. Presence only: it labels this
    /// attachment's cursor via the session roster. Collab identity is the
    /// per-attachment `clientID` inside `push` frames, never `w` (two
    /// panes of one window may attach the same doc).
    w: String,
    /// Reconnect hint: the client's confirmed version. At or above the
    /// session's log base it earns an incremental `updates` catch-up;
    /// below the base or absent it earns a fresh `snapshot`.
    version: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientFrame {
    /// Submit local updates on top of `version` (the client's confirmed
    /// version). Accepted only when it matches the authority's current
    /// version. ONE push in flight per client at a time. Update entries
    /// are `{clientID, changes}` (`doc_sessions::changes::UpdateJson`,
    /// which tolerates and drops a client `effects` field): the
    /// ChangeSet section grammar is enforced by that type's serde, so a
    /// malformed `changes` fails the frame decode and the error+close
    /// path fires before the session is ever touched.
    #[serde(rename = "push")]
    Push {
        version: u64,
        updates: Vec<UpdateJson>,
    },
    /// Explicit catch-up request from `version`.
    #[serde(rename = "pull")]
    Pull { version: u64 },
    /// Local selection moved. UTF-16 doc offsets, client-throttled; the
    /// server clamps, stamps the current version, and fans to the other
    /// attachments without rebasing.
    #[serde(rename = "cursor")]
    Cursor { anchor: u64, head: u64 },
}

/// A peer cursor as other attachments see it. `id` is the server attach
/// id, NOT the window id (two panes of one window may attach the same
/// doc); `w` is the owning window, resolved to a display name through the
/// session roster; `version` is the doc version the offsets were stamped
/// against.
#[derive(Debug, Serialize)]
pub(crate) struct PeerCursor {
    pub(crate) id: u64,
    pub(crate) w: String,
    pub(crate) anchor: u64,
    pub(crate) head: u64,
    pub(crate) version: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub(crate) enum ServerFrame {
    /// Full document state: answers an attach without a usable
    /// `?version=`, and any hard resync. `mtime_ns` is the
    /// flushed-to-disk CAS token as a decimal string (the `/api/files`
    /// convention: nanosecond epoch timestamps overflow JS number
    /// precision), null when the disk state is unknown. `conflicted`
    /// mirrors the retained disk-conflict state so a fresh attach can
    /// surface the resolve UI immediately.
    #[serde(rename = "snapshot")]
    Snapshot {
        path: String,
        version: u64,
        doc: String,
        dirty: bool,
        conflicted: bool,
        mtime_ns: Option<String>,
        cursors: Vec<PeerCursor>,
    },
    /// Committed updates, broadcast to every attachment INCLUDING the
    /// sender: the own-clientID echo is the sender's confirmation
    /// (standard `@codemirror/collab` pattern). `version` is the base the
    /// first update applies to; each socket sees strictly increasing,
    /// gapless versions.
    #[serde(rename = "updates")]
    Updates {
        version: u64,
        updates: Vec<UpdateJson>,
    },
    /// The in-flight push committed; `version` is the authority version
    /// after the commit.
    #[serde(rename = "push-ok")]
    PushOk { version: u64 },
    /// The in-flight push's base version did not match; `version` is the
    /// authority's current version. The missed `updates` frames are
    /// already in flight on this same socket: rebase through them and
    /// re-push.
    #[serde(rename = "push-stale")]
    PushStale { version: u64 },
    /// A peer's cursor moved. Same fields as a `snapshot.cursors` entry.
    #[serde(rename = "cursor")]
    Cursor {
        id: u64,
        w: String,
        anchor: u64,
        head: u64,
        version: u64,
    },
    /// A peer detached; drop its cursor.
    #[serde(rename = "cursor-gone")]
    CursorGone { id: u64 },
    /// The authority flushed to disk (`dirty: false` plus the fresh
    /// `mtime_ns` token) or repeatedly failed to (an `error` message; the
    /// session stays live and the content is safe in memory and in every
    /// client). Clients stamp `savedMtimeNs` from `mtime_ns`: that token
    /// is what keeps the classic autosave CAS correct after a
    /// degradation.
    #[serde(rename = "flush")]
    Flush {
        dirty: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        mtime_ns: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// The session entered (`active: true`) or left (`active: false`)
    /// retained disk-conflict state: an external disk write and live
    /// edits diverged irreconcilably, the authority paused flushing,
    /// and both sides are held for explicit resolution through
    /// `/api/session-conflicts/resolve`. A retained-side refresh (the
    /// disk moved again mid-conflict) re-announces with `active: true`.
    /// `disk_mtime_ns` is the retained disk token, same encoding as
    /// `mtime_ns` elsewhere.
    #[serde(rename = "conflict")]
    Conflict {
        active: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        disk_mtime_ns: Option<String>,
    },
    /// The file vanished on disk. The client routes into its
    /// missing-file machinery; the server keeps the session but stops
    /// flushing (a deliberate delete is never resurrected by a flush).
    #[serde(rename = "removed")]
    Removed,
    /// Protocol error (malformed frame, bad changeset, oversized doc),
    /// followed by the server closing this attachment: a garbled frame
    /// means a desynced peer, so this route errors loudly, unlike `/ws`'s
    /// silent drop.
    #[serde(rename = "error")]
    Error {
        message: String,
        reason: &'static str,
    },
    /// Registry-initiated teardown (storage reset, shutdown).
    #[serde(rename = "closed")]
    Closed { reason: &'static str },
}

pub async fn api_doc_ws(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DocQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // A missing workspace (e.g. a dial racing a storage reset's cell
    // swap) still upgrades and answers an error FRAME before closing,
    // symmetric with attach failures: a zero-frame handshake failure
    // on the page load's first dial would latch the SPA's capability
    // probe to "no doc sync" for the whole page load.
    let workspace = state.try_workspace();
    ws.on_upgrade(move |mut socket| async move {
        match workspace {
            Ok(workspace) => doc_ws(socket, state, workspace, query).await,
            Err(e) => error_close(&mut socket, &e.to_string(), "no-workspace").await,
        }
    })
    .into_response()
}

async fn doc_ws(
    mut socket: WebSocket,
    state: Arc<AppState>,
    workspace: Arc<chan_workspace::Workspace>,
    query: DocQuery,
) {
    state
        .last_activity
        .store(now_unix_secs(), Ordering::Relaxed);
    let mut handle = match state
        .doc_sessions
        .attach(&workspace, &query.path, &query.w, query.version)
        .await
    {
        Ok(handle) => handle,
        Err(e) => {
            // The error FRAME must precede the close: the SPA's
            // capability probe reads a close-before-any-frame as "old
            // server, no doc sync" and would latch docSync off
            // module-wide over a mere bad path.
            error_close(&mut socket, &e.to_string(), "attach-failed").await;
            return;
        }
    };
    let mut frames = handle.take_frames();
    let mut shutdown_rx = state.shutdown_rx.clone();

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => {
                // The flusher's shutdown pass flushes every session and
                // fans `closed{shutdown}`; this socket just says goodbye.
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1001,
                        reason: "server shutdown".into(),
                    })))
                    .await;
                break;
            }
            msg = socket.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    Ok(Message::Text(text)) => match serde_json::from_str::<ClientFrame>(&text) {
                        Ok(ClientFrame::Push { version, updates }) => {
                            state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            // A stale base is not an error: the session
                            // already answered `push-stale` on the outbox.
                            if let Err(e) = handle.push(version, updates) {
                                error_close(&mut socket, &e.to_string(), push_error_reason(&e))
                                    .await;
                                break;
                            }
                        }
                        Ok(ClientFrame::Pull { version }) => handle.pull(version),
                        Ok(ClientFrame::Cursor { anchor, head }) => {
                            state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            handle.cursor(anchor, head);
                        }
                        Err(e) => {
                            // A frame this route cannot parse means a
                            // desynced or drifted peer: per the contract,
                            // error loudly and close, never a silent drop.
                            error_close(
                                &mut socket,
                                &format!("invalid doc frame: {e}"),
                                "malformed-frame",
                            )
                            .await;
                            break;
                        }
                    },
                    // The contract is JSON text frames only; binary is a
                    // drifted peer, same loud path as malformed JSON.
                    Ok(Message::Binary(_)) => {
                        error_close(
                            &mut socket,
                            "binary frames are not in the doc contract",
                            "malformed-frame",
                        )
                        .await;
                        break;
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                    Err(_) => break,
                }
            }
            frame = frames.recv() => {
                match frame {
                    // Frames are pre-serialized under the session state
                    // lock; forward verbatim so per-socket order stays
                    // version-consistent.
                    Some(raw) => {
                        if socket.send(Message::text(raw)).await.is_err() {
                            break;
                        }
                    }
                    // Outbox senders gone: registry teardown (`closed`
                    // was the final frame) or this attach was evicted.
                    None => {
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: 1000,
                                reason: "doc session closed".into(),
                            })))
                            .await;
                        break;
                    }
                }
            }
        }
    }
    // Dropping `handle` detaches: cursor-gone fan; a 1->0 transition
    // stamps the detach grace and requests a prompt flush.
}

/// Map a rejected push onto the contract's `error.reason` values.
fn push_error_reason(e: &PushError) -> &'static str {
    match e {
        PushError::ReservedClientId(_) => "reserved-client-id",
        PushError::Apply(ApplyError::DocTooLarge { .. }) => "doc-too-large",
        PushError::Apply(_) => "bad-changeset",
        PushError::Closed => "session-closed",
    }
}

/// The contract's loud goodbye: an `error` frame naming the reason,
/// then a policy-violation close. Send failures are ignored (the peer
/// may already be gone); dropping the attach handle afterwards is what
/// actually detaches.
async fn error_close(socket: &mut WebSocket, message: &str, reason: &'static str) {
    let frame = ServerFrame::Error {
        message: message.to_string(),
        reason,
    };
    let _ = socket
        .send(Message::text(serde_json::to_string(&frame).unwrap_or_else(
            |e| format!(r#"{{"type":"error","message":"serialize failed: {e}"}}"#),
        )))
        .await;
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: reason.into(),
        })))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc_sessions::changes::{apply_all, replace_diff, utf16_len};
    use crate::doc_sessions::{flush_session, DocAttachHandle, DocRegistry};
    use crate::self_writes::SelfWrites;
    use chan_workspace::{WatchEvent, WatchKind, Workspace};
    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    fn enc(frame: &ServerFrame) -> String {
        serde_json::to_string(frame).expect("serialize server frame")
    }

    fn fixture(files: &[(&str, &str)]) -> (TempDir, TempDir, Arc<Workspace>, Arc<DocRegistry>) {
        let cfg = TempDir::new().expect("temp config");
        let root = TempDir::new().expect("temp workspace");
        for (path, content) in files {
            let abs = root.path().join(path);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(abs, content).unwrap();
        }
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace, Arc::new(DocRegistry::new()))
    }

    /// A scripted collab client over the same attach-handle surface the
    /// ws pump drives. Frames are enqueued synchronously inside the
    /// `attach`/`push` calls, so a drain right after a call observes
    /// exactly what a socket would; the fold mirrors what the SPA does
    /// through `receiveUpdates`.
    struct FakeClient {
        handle: DocAttachHandle,
        frames: mpsc::UnboundedReceiver<String>,
        id: &'static str,
        doc: String,
        len16: u64,
        version: u64,
    }

    impl FakeClient {
        /// `resume`: `Some((version, text))` models a `?version=`
        /// reconnect of a client whose confirmed state is `text`.
        async fn attach(
            registry: &Arc<DocRegistry>,
            workspace: &Arc<Workspace>,
            path: &str,
            w: &str,
            id: &'static str,
            resume: Option<(u64, &str)>,
        ) -> Self {
            let mut handle = registry
                .attach(workspace, path, w, resume.map(|(v, _)| v))
                .await
                .expect("attach");
            let frames = handle.take_frames();
            let (version, doc) = match resume {
                Some((v, text)) => (v, text.to_string()),
                None => (0, String::new()),
            };
            let len16 = utf16_len(&doc);
            FakeClient {
                handle,
                frames,
                id,
                doc,
                len16,
                version,
            }
        }

        /// Drain every queued frame, folding `snapshot`/`updates` into
        /// the local doc; returns the raw frames for shape asserts.
        fn drain(&mut self) -> Vec<Value> {
            let mut out = Vec::new();
            while let Ok(raw) = self.frames.try_recv() {
                let v: Value = serde_json::from_str(&raw).expect("frame json");
                match v["type"].as_str().expect("frame type") {
                    "snapshot" => {
                        self.doc = v["doc"].as_str().unwrap().to_string();
                        self.len16 = utf16_len(&self.doc);
                        self.version = v["version"].as_u64().unwrap();
                    }
                    "updates" => {
                        // Strict per-socket order: every broadcast's base
                        // version matches this client's confirmed version,
                        // gaplessly.
                        assert_eq!(
                            v["version"].as_u64().unwrap(),
                            self.version,
                            "updates base must match the confirmed version"
                        );
                        let updates: Vec<UpdateJson> =
                            serde_json::from_value(v["updates"].clone()).unwrap();
                        self.version += updates.len() as u64;
                        let applied = apply_all(&self.doc, self.len16, &updates).expect("apply");
                        self.doc = applied.text;
                        self.len16 = applied.len16;
                    }
                    _ => {}
                }
                out.push(v);
            }
            out
        }

        /// Compose the whole-doc edit confirmed -> `target` and push it
        /// at the confirmed version: what a client whose latest intent
        /// is `target` does, both first-try and after a stale rebase.
        fn push_to(&mut self, target: &str) -> Result<(), PushError> {
            let changes = replace_diff(&self.doc, target);
            self.handle.push(
                self.version,
                vec![UpdateJson {
                    client_id: self.id.to_string(),
                    changes,
                }],
            )
        }
    }

    fn types(frames: &[Value]) -> Vec<&str> {
        frames.iter().map(|v| v["type"].as_str().unwrap()).collect()
    }

    #[tokio::test]
    async fn two_fake_clients_converge_through_a_stale_collision() {
        let (_cfg, _root, workspace, registry) = fixture(&[("notes/a.md", "base\n")]);
        let mut a = FakeClient::attach(
            &registry,
            &workspace,
            "notes/a.md",
            "win-a",
            "client-a",
            None,
        )
        .await;
        let mut b = FakeClient::attach(
            &registry,
            &workspace,
            "notes/a.md",
            "win-b",
            "client-b",
            None,
        )
        .await;
        assert_eq!(types(&a.drain()), ["snapshot"]);
        assert_eq!(types(&b.drain()), ["snapshot"]);
        assert_eq!(a.doc, "base\n");

        // A lands first; B composes against the same base version, a
        // deliberate stale collision. Multibyte content on A's side
        // exercises the UTF-16 path through the whole stack.
        a.push_to("base\nalpha é🙂\n").unwrap();
        b.push_to("Base\n").unwrap();

        // Sender confirmation order: own echo, then push-ok.
        assert_eq!(types(&a.drain()), ["updates", "push-ok"]);
        // The collider: the missed broadcast is already in flight on the
        // same socket, then the stale verdict naming the current version.
        let fb = b.drain();
        assert_eq!(types(&fb), ["updates", "push-stale"]);
        assert_eq!(fb[1]["version"].as_u64(), Some(1));
        assert_eq!(b.doc, "base\nalpha é🙂\n");

        // Rebase: recompose the intent on the caught-up text, re-push.
        b.push_to("Base\nalpha é🙂\n").unwrap();
        assert_eq!(types(&b.drain()), ["updates", "push-ok"]);
        assert_eq!(types(&a.drain()), ["updates"]);

        assert_eq!(a.doc, b.doc);
        assert_eq!(a.version, b.version);
        assert_eq!(a.doc, "Base\nalpha é🙂\n");
        let (authority, _) = a.handle.session().authority_view();
        assert_eq!(authority, a.doc, "clients and authority converge");
    }

    #[tokio::test]
    async fn current_version_resume_gets_flush_state_promptly() {
        // The SPA counts a dial FAILED when no frame arrives inside its
        // attach timeout, INCLUDING a `?version=` resume with nothing to
        // catch up on. An accepted attach must never be silent: the
        // nothing-to-send path answers with at least the flush-state
        // frame, or healthy sockets would cycle every timeout.
        let (_cfg, _root, workspace, registry) = fixture(&[("a.md", "hi")]);
        let mut a =
            FakeClient::attach(&registry, &workspace, "a.md", "win-a", "client-a", None).await;
        a.drain();
        a.push_to("hi there").unwrap();
        a.drain();
        assert_eq!(a.version, 1);

        // Fully-current resume: no snapshot (delta path), no updates to
        // send, but never zero frames.
        let mut b = FakeClient::attach(
            &registry,
            &workspace,
            "a.md",
            "win-b",
            "client-b",
            Some((1, "hi there")),
        )
        .await;
        let fb = b.drain();
        assert!(!fb.is_empty(), "an accepted attach must answer promptly");
        let t = types(&fb);
        assert!(t.contains(&"flush"), "flush state is the minimum: {t:?}");
        assert!(
            !t.contains(&"snapshot"),
            "resume takes the delta path: {t:?}"
        );

        // Behind-by-one resume: incremental catch-up plus flush state,
        // still no snapshot; the fold lands on the current text.
        let mut c = FakeClient::attach(
            &registry,
            &workspace,
            "a.md",
            "win-c",
            "client-c",
            Some((0, "hi")),
        )
        .await;
        let fc = c.drain();
        let t = types(&fc);
        assert!(t.contains(&"updates") && t.contains(&"flush"), "{t:?}");
        assert!(!t.contains(&"snapshot"), "{t:?}");
        assert_eq!(c.doc, "hi there");
        assert_eq!(c.version, 1);
    }

    #[tokio::test]
    async fn reserved_client_id_push_rejects_with_the_pinned_reason() {
        let (_cfg, _root, workspace, registry) = fixture(&[("a.md", "hi")]);
        let mut a =
            FakeClient::attach(&registry, &workspace, "a.md", "win-a", "client-a", None).await;
        a.drain();
        let changes = replace_diff("hi", "hi!");
        let err = a
            .handle
            .push(
                0,
                vec![UpdateJson {
                    client_id: "$disk".into(),
                    changes,
                }],
            )
            .unwrap_err();
        assert!(matches!(err, PushError::ReservedClientId(_)), "{err:?}");
        assert_eq!(push_error_reason(&err), "reserved-client-id");
    }

    #[tokio::test]
    async fn close_all_fans_closed_then_drops_the_outbox() {
        // Storage-reset teardown as the pump sees it: `closed` is the
        // final frame on the outbox, then the channel disconnects,
        // which is the pump's break-and-close path.
        let (_cfg, _root, workspace, registry) = fixture(&[("a.md", "hi")]);
        let mut a =
            FakeClient::attach(&registry, &workspace, "a.md", "win-a", "client-a", None).await;
        a.drain();
        registry
            .close_all("reset", Some(&workspace), &SelfWrites::new())
            .await;
        let frames = a.drain();
        let t = types(&frames);
        assert_eq!(t.last(), Some(&"closed"));
        assert_eq!(frames.last().unwrap()["reason"].as_str(), Some("reset"));
        assert!(matches!(
            a.frames.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }

    #[tokio::test]
    async fn reconcile_merges_external_write_and_ignores_own_flush_echo() {
        let (_cfg, root, workspace, registry) = fixture(&[("a.md", "one\n")]);
        let self_writes = SelfWrites::new();
        let mut a =
            FakeClient::attach(&registry, &workspace, "a.md", "win-a", "client-a", None).await;
        a.drain();
        let session = a.handle.session().clone();

        // Own-flush echo: push an edit, flush it, then feed the
        // resulting watcher event back in. The disk token matches the
        // session token, so nothing fans.
        a.push_to("two\n").unwrap();
        a.drain();
        flush_session(&session, &workspace, &self_writes).await;
        a.drain();
        registry
            .reconcile_event(
                &workspace,
                WatchEvent::file(
                    WatchKind::Modified,
                    "a.md",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        assert!(a.drain().is_empty(), "own flush echo must not fan");

        // External write: merged in as a `$disk` update, token adopted,
        // client text converges on the disk content with NO banner path.
        std::fs::write(root.path().join("a.md"), "two\nagent line\n").unwrap();
        registry
            .reconcile_event(
                &workspace,
                WatchEvent::file(
                    WatchKind::Modified,
                    "a.md",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        let frames = a.drain();
        let updates: Vec<&Value> = frames.iter().filter(|f| f["type"] == "updates").collect();
        assert_eq!(updates.len(), 1, "{frames:?}");
        assert_eq!(updates[0]["updates"][0]["clientID"], "$disk");
        assert_eq!(a.doc, "two\nagent line\n");
        assert_eq!(session.authority_view().0, "two\nagent line\n");
    }

    #[tokio::test]
    async fn reconcile_removed_stops_flush_and_next_edit_recreates() {
        let (_cfg, root, workspace, registry) = fixture(&[("a.md", "one\n")]);
        let self_writes = SelfWrites::new();
        let mut a =
            FakeClient::attach(&registry, &workspace, "a.md", "win-a", "client-a", None).await;
        a.drain();
        let session = a.handle.session().clone();

        // Delete the file while the session is clean. Dirty deletion
        // is a conflict and is covered in doc_sessions.
        std::fs::remove_file(root.path().join("a.md")).unwrap();
        registry
            .reconcile_event(
                &workspace,
                WatchEvent::file(
                    WatchKind::Removed,
                    "a.md",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        // Absence corroborates across two observations before the
        // removal fans.
        session.test_backdate_pending_removal();
        registry.reconcile_pending(&workspace).await;
        let frames = a.drain();
        assert!(types(&frames).contains(&"removed"), "{frames:?}");
        assert_eq!(session.token(), None);

        // Removed stopped the debounce clock: a flush pass must NOT
        // resurrect a deliberate delete.
        flush_session(&session, &workspace, &self_writes).await;
        assert!(
            !root.path().join("a.md").exists(),
            "delete must not be resurrected"
        );

        // The next client edit re-dirties; the CAS-None flush recreates.
        a.push_to("three\n").unwrap();
        a.drain();
        flush_session(&session, &workspace, &self_writes).await;
        assert_eq!(
            std::fs::read_to_string(root.path().join("a.md")).unwrap(),
            "three\n"
        );
    }

    // ---- client -> server ----------------------------------------------

    #[test]
    fn client_push_decodes_the_pinned_shape() {
        // { type: "push", version, updates: [{clientID, changes}] }. The
        // `clientID` casing is CodeMirror's `Update.clientID`; a Rust-side
        // rename would break every SPA push with a green build, so pin the
        // decode.
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"push","version":7,"updates":[
                {"clientID":"a-1","changes":[1,[0,"x"],3]},
                {"clientID":"a-1","changes":[[5]]}
            ]}"#,
        )
        .unwrap();
        match frame {
            ClientFrame::Push { version, updates } => {
                assert_eq!(version, 7);
                assert_eq!(updates.len(), 2);
                assert_eq!(updates[0].client_id, "a-1");
                assert_eq!(
                    serde_json::to_value(&updates[0].changes).unwrap(),
                    serde_json::json!([1, [0, "x"], 3])
                );
                assert_eq!(
                    serde_json::to_value(&updates[1].changes).unwrap(),
                    serde_json::json!([[5]])
                );
            }
            other => panic!("expected Push, got {other:?}"),
        }
    }

    #[test]
    fn client_push_rejects_malformed_changes_grammar() {
        // `changes` deserializes through the ChangeSetJson grammar
        // (doc_sessions::changes), so a section that is not a bare
        // retain, `[del]`, or `[del, lines...]` fails the WHOLE frame
        // decode: the route answers `error` + close without the session
        // ever seeing the push.
        for bad in [
            r#"{"type":"push","version":0,"updates":[{"clientID":"a","changes":[true]}]}"#,
            r#"{"type":"push","version":0,"updates":[{"clientID":"a","changes":[["x"]]}]}"#,
            r#"{"type":"push","version":0,"updates":[{"clientID":"a","changes":[[1,2]]}]}"#,
            r#"{"type":"push","version":0,"updates":[{"clientID":"a","changes":{"del":1}}]}"#,
            r#"{"type":"push","version":0,"updates":[{"clientID":"a","changes":[-1]}]}"#,
        ] {
            assert!(
                serde_json::from_str::<ClientFrame>(bad).is_err(),
                "must reject: {bad}"
            );
        }
    }

    #[test]
    fn client_push_requires_the_client_id_casing() {
        // snake_case / lowercase spellings are NOT the contract; reject
        // them so a drifted client fails loudly instead of pushing
        // anonymous updates.
        for bad in [
            r#"{"type":"push","version":0,"updates":[{"client_id":"a","changes":[]}]}"#,
            r#"{"type":"push","version":0,"updates":[{"clientid":"a","changes":[]}]}"#,
        ] {
            assert!(
                serde_json::from_str::<ClientFrame>(bad).is_err(),
                "must reject: {bad}"
            );
        }
    }

    #[test]
    fn client_push_tolerates_and_drops_effects() {
        // CM's `Update.toJSON()` may carry `effects`; the contract
        // tolerates the field on input and never rebroadcasts it.
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"push","version":1,"updates":[{"clientID":"a","changes":[[0,"hi"]],"effects":["e"]}]}"#,
        )
        .unwrap();
        let ClientFrame::Push { version, updates } = frame else {
            panic!("expected Push");
        };
        let echo = enc(&ServerFrame::Updates { version, updates });
        assert!(!echo.contains("effects"), "echo must drop effects: {echo}");
    }

    #[test]
    fn client_pull_and_cursor_decode() {
        let pull: ClientFrame = serde_json::from_str(r#"{"type":"pull","version":42}"#).unwrap();
        match pull {
            ClientFrame::Pull { version } => assert_eq!(version, 42),
            other => panic!("expected Pull, got {other:?}"),
        }
        let cursor: ClientFrame =
            serde_json::from_str(r#"{"type":"cursor","anchor":3,"head":9}"#).unwrap();
        match cursor {
            ClientFrame::Cursor { anchor, head } => {
                assert_eq!(anchor, 3);
                assert_eq!(head, 9);
            }
            other => panic!("expected Cursor, got {other:?}"),
        }
    }

    #[test]
    fn client_unknown_or_malformed_frames_reject() {
        // Unknown tags and missing fields are protocol errors (the route
        // answers `error` + close, never a silent drop), so the decode
        // itself must fail.
        for bad in [
            r#"{"type":"nope"}"#,
            r#"{"version":1}"#,
            r#"{"type":"push","updates":[]}"#,
            r#"{"type":"pull"}"#,
            r#"{"type":"cursor","anchor":1}"#,
        ] {
            assert!(
                serde_json::from_str::<ClientFrame>(bad).is_err(),
                "must reject: {bad}"
            );
        }
    }

    // ---- server -> client ----------------------------------------------

    #[test]
    fn server_snapshot_pins_the_wire_shape() {
        let full = ServerFrame::Snapshot {
            path: "notes/a.md".into(),
            version: 3,
            doc: "hi".into(),
            dirty: false,
            conflicted: false,
            mtime_ns: Some("1751234567890123456".into()),
            cursors: vec![PeerCursor {
                id: 7,
                w: "win-1".into(),
                anchor: 2,
                head: 5,
                version: 3,
            }],
        };
        assert_eq!(
            enc(&full),
            r#"{"type":"snapshot","path":"notes/a.md","version":3,"doc":"hi","dirty":false,"conflicted":false,"mtime_ns":"1751234567890123456","cursors":[{"id":7,"w":"win-1","anchor":2,"head":5,"version":3}]}"#
        );
        // Disk state unknown (e.g. after `removed`): mtime_ns is null, not
        // omitted; the client stamps savedMtimeNs unconditionally.
        let unknown = ServerFrame::Snapshot {
            path: "a".into(),
            version: 0,
            doc: String::new(),
            dirty: true,
            conflicted: true,
            mtime_ns: None,
            cursors: vec![],
        };
        assert_eq!(
            enc(&unknown),
            r#"{"type":"snapshot","path":"a","version":0,"doc":"","dirty":true,"conflicted":true,"mtime_ns":null,"cursors":[]}"#
        );
    }

    #[test]
    fn server_conflict_pins_the_wire_shape() {
        let active = ServerFrame::Conflict {
            active: true,
            disk_mtime_ns: Some("1751234567890123456".into()),
        };
        assert_eq!(
            enc(&active),
            r#"{"type":"conflict","active":true,"disk_mtime_ns":"1751234567890123456"}"#
        );
        // A conflict against a vanished/unknown disk side omits the token.
        let inactive = ServerFrame::Conflict {
            active: false,
            disk_mtime_ns: None,
        };
        assert_eq!(enc(&inactive), r#"{"type":"conflict","active":false}"#);
    }

    #[test]
    fn server_updates_and_push_acks_pin_the_wire_shape() {
        // Round-trip through UpdateJson: the broadcast serialization must
        // stay byte-identical to the client's `ChangeSet.toJSON()` form.
        let entry: UpdateJson =
            serde_json::from_value(serde_json::json!({"clientID":"$disk","changes":[2,[1,"z"]]}))
                .unwrap();
        let updates = ServerFrame::Updates {
            version: 4,
            updates: vec![entry],
        };
        assert_eq!(
            enc(&updates),
            r#"{"type":"updates","version":4,"updates":[{"clientID":"$disk","changes":[2,[1,"z"]]}]}"#
        );
        assert_eq!(
            enc(&ServerFrame::PushOk { version: 5 }),
            r#"{"type":"push-ok","version":5}"#
        );
        assert_eq!(
            enc(&ServerFrame::PushStale { version: 9 }),
            r#"{"type":"push-stale","version":9}"#
        );
    }

    #[test]
    fn server_cursor_frames_pin_the_wire_shape() {
        let moved = ServerFrame::Cursor {
            id: 7,
            w: "win-1".into(),
            anchor: 10,
            head: 10,
            version: 6,
        };
        assert_eq!(
            enc(&moved),
            r#"{"type":"cursor","id":7,"w":"win-1","anchor":10,"head":10,"version":6}"#
        );
        assert_eq!(
            enc(&ServerFrame::CursorGone { id: 7 }),
            r#"{"type":"cursor-gone","id":7}"#
        );
    }

    #[test]
    fn server_flush_pins_success_and_failure_shapes() {
        let clean = ServerFrame::Flush {
            dirty: false,
            mtime_ns: Some("1751234567890123456".into()),
            error: None,
        };
        assert_eq!(
            enc(&clean),
            r#"{"type":"flush","dirty":false,"mtime_ns":"1751234567890123456"}"#
        );
        let failed = ServerFrame::Flush {
            dirty: true,
            mtime_ns: None,
            error: Some("write failed".into()),
        };
        assert_eq!(
            enc(&failed),
            r#"{"type":"flush","dirty":true,"error":"write failed"}"#
        );
    }

    #[test]
    fn server_lifecycle_frames_pin_the_wire_shape() {
        assert_eq!(enc(&ServerFrame::Removed), r#"{"type":"removed"}"#);
        assert_eq!(
            enc(&ServerFrame::Error {
                message: "bad changeset".into(),
                reason: "bad-changeset",
            }),
            r#"{"type":"error","message":"bad changeset","reason":"bad-changeset"}"#
        );
        assert_eq!(
            enc(&ServerFrame::Closed { reason: "reset" }),
            r#"{"type":"closed","reason":"reset"}"#
        );
    }

    #[test]
    fn doc_query_decodes_path_w_and_optional_version() {
        // Axum's Query extractor deserializes through serde exactly like
        // this; pin the parameter names the SPA puts in the URL.
        let q: DocQuery =
            serde_json::from_str(r#"{"path":"notes/a.md","w":"win-1","version":12}"#).unwrap();
        assert_eq!(q.path, "notes/a.md");
        assert_eq!(q.w, "win-1");
        assert_eq!(q.version, Some(12));
        let q: DocQuery = serde_json::from_str(r#"{"path":"a","w":"win-1"}"#).unwrap();
        assert_eq!(q.version, None);
        // Both path and w are required; a client that omits either never
        // gets a socket.
        assert!(serde_json::from_str::<DocQuery>(r#"{"path":"a"}"#).is_err());
        assert!(serde_json::from_str::<DocQuery>(r#"{"w":"win-1"}"#).is_err());
    }

    #[test]
    fn recovery_persistence_stays_off_ack_path_and_never_rejects_mutation() {
        let doc = include_str!("doc.rs");
        let scene = include_str!("scene.rs");
        let files = include_str!("files.rs");
        let ack_path_write = ["persist", "recovery"].join("_");
        assert!(!doc.contains("\"recovery-write\""));
        assert!(!scene.contains("\"recovery-write\""));
        assert!(!doc.contains(&ack_path_write));
        assert!(!scene.contains(&ack_path_write));
        assert!(!files.contains("persist document conflict resolution"));
        assert!(!files.contains("persist scene conflict resolution"));
    }
}
