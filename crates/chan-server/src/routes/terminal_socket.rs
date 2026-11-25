use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};

use super::*;

const MAX_PENDING_REPLIES: usize = 32;
// A complete queue preview can contain 100 bodies of 4096 bytes, plus JSON
// escaping and prompt identities. Keep room for that ordinary response.
const MAX_PENDING_REPLY_BYTES: usize = 8 * 1024 * 1024;

type CwdReading = (Option<String>, Option<String>);
type CwdFuture = Pin<Box<dyn Future<Output = CwdReading> + Send>>;

#[cfg(test)]
#[path = "terminal_socket_tests.rs"]
mod tests;

/// The reader stays runnable while a single, retained send waits for the peer.
/// Replies wait for the current event or attach prelude to finish, preserving
/// their ordering without an unbounded second output queue.
pub(super) struct TerminalSocket {
    sink: SplitSink<WebSocket, Message>,
    pub(super) stream: SplitStream<WebSocket>,
    pub(super) input: InputState,
    state: Arc<AppState>,
    /// A wait outside the socket loop ran out its view's stall, so the
    /// socket ends with the stall close.
    stalled: bool,
}

pub(super) struct InputState {
    client: chan_library::client_sessions::ClientConnection,
    pub(super) size: Option<PtySize>,
    pub(super) size_conditional: bool,
    pub(super) focus: Option<u64>,
    pub(super) queue_details: bool,
    /// Text frames read from the client. Only the page's script sends
    /// them, so a count that moves shows the page runs; a stopped page's
    /// network stack can still answer protocol pings.
    pub(super) frames: u64,
    /// The wait of a view that needs recovery, kept where the client's
    /// frames are read.
    pub(super) stall: Option<Stall>,
    replies: VecDeque<(usize, Message)>,
    reply_bytes: usize,
    cwd: Option<CwdFuture>,
}

impl TerminalSocket {
    pub(super) fn new(
        socket: WebSocket,
        state: Arc<AppState>,
        client: chan_library::client_sessions::ClientConnection,
        size: Option<PtySize>,
        size_conditional: bool,
    ) -> Self {
        let (sink, stream) = socket.split();
        Self {
            sink,
            stream,
            input: InputState {
                client,
                size,
                size_conditional,
                focus: None,
                queue_details: false,
                frames: 0,
                stall: None,
                replies: VecDeque::new(),
                reply_bytes: 0,
                cwd: None,
            },
            state,
            stalled: false,
        }
    }

    pub(super) async fn send(
        &mut self,
        session: &AttachHandle,
        message: Message,
    ) -> Result<(), ()> {
        #[cfg(all(test, unix))]
        let (binary_bytes, text_bytes) = match &message {
            Message::Binary(bytes) => (bytes.len(), 0),
            Message::Text(text) => (0, text.len()),
            _ => (0, 0),
        };
        let send = self.sink.send(message);
        tokio::pin!(send);
        let mut shutdown = self.state.shutdown_rx.clone();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => return Err(()),
                result = std::future::poll_fn(|cx| {
                    let result = std::future::Future::poll(send.as_mut(), cx);
                    #[cfg(all(test, unix))]
                    if result.is_pending() {
                        streamlag_tests::send_pending(session.id(), binary_bytes);
                        if text_bytes > 0 {
                            streamlag_tests::text_send_pending(session.id(), text_bytes);
                        }
                    }
                    result
                }) => return result.map_err(|_| ()),
                result = self.input.next_cwd() => self.input.complete_cwd(result)?,
                message = self.stream.next() => {
                    self.input.receive(&self.state, session, message)?;
                }
            }
        }
    }

    /// How many raw bytes the client's window allows now, waiting for an
    /// acknowledgement when it is full. Input stays live during the wait. An
    /// end of the session ends the wait with an error: the socket drops and
    /// the client redials into the outcome the server retained. So does the
    /// stall of a view released during the wait, which marks the socket for
    /// the stall close: the wait never returns to the loop that polls it.
    pub(super) async fn output_credit(&mut self, session: &AttachHandle) -> Result<usize, ()> {
        let Some(progress) = session.output_progress() else {
            return Ok(usize::MAX);
        };
        let mut lifecycle = session.lifecycle_rx.clone();
        let mut shutdown = self.state.shutdown_rx.clone();
        loop {
            match progress.send_credit() {
                None => return Ok(usize::MAX),
                Some(credit) if credit > 0 => return Ok(credit),
                Some(_) => {}
            }
            if matches!(
                &*lifecycle.borrow_and_update(),
                Some(SessionLifecycle::Closed(_) | SessionLifecycle::Restarted)
            ) {
                return Err(());
            }
            let stall_deadline = self.input.stall.as_ref().and_then(|stall| stall.deadline);
            tokio::select! {
                biased;
                _ = shutdown.changed() => return Err(()),
                changed = lifecycle.changed() => changed.map_err(|_| ())?,
                // Above the client's frames, as in the socket loop.
                () = tokio::time::sleep_until(
                    stall_deadline.unwrap_or_else(tokio::time::Instant::now)
                ), if stall_deadline.is_some() => {
                    self.stalled = true;
                    return Err(());
                }
                result = self.input.next_cwd() => self.input.complete_cwd(result)?,
                message = self.stream.next() => {
                    self.input.receive(&self.state, session, message)?;
                }
            }
        }
    }

    pub(super) async fn frame(
        &mut self,
        session: &AttachHandle,
        frame: ServerFrame,
    ) -> Result<(), ()> {
        self.send(session, frame_message(frame)).await
    }

    pub(super) fn receive(
        &mut self,
        session: &AttachHandle,
        message: Option<Result<Message, axum::Error>>,
    ) -> Result<(), ()> {
        self.input.receive(&self.state, session, message)
    }

    pub(super) async fn cwd(&mut self, session: &AttachHandle) -> Result<CwdReading, ()> {
        let reading = terminal_cwd_payload_blocking(
            self.state.try_workspace().ok(),
            session.blocking_cwd_probe(),
        );
        tokio::pin!(reading);
        let mut shutdown = self.state.shutdown_rx.clone();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => return Err(()),
                result = &mut reading => return Ok(result),
                result = self.input.next_cwd() => self.input.complete_cwd(result)?,
                message = self.stream.next() => {
                    self.input.receive(&self.state, session, message)?;
                }
            }
        }
    }

    pub(super) fn observe(&self, session: &AttachHandle) {
        self.input.client.observe(
            Some(session.id()),
            self.input.size.map(|size| (size.cols, size.rows)),
        );
    }

    pub(super) async fn flush_replies(&mut self, session: &AttachHandle) -> Result<(), ()> {
        // A peer continually sending requests still leaves output a turn.
        for _ in 0..self.input.replies.len() {
            let Some((bytes, message)) = self.input.replies.pop_front() else {
                break;
            };
            self.input.reply_bytes -= bytes;
            self.send(session, message).await?;
        }
        Ok(())
    }

    pub(super) async fn finish(self, code: u16, reason: Utf8Bytes) {
        if let Ok(socket) = self.sink.reunite(self.stream) {
            finish_socket(socket, code, reason).await;
        }
    }

    /// End the socket with `finish`, or with the stall close when a wait
    /// outside the socket loop ran out its view's stall, or else drop it.
    pub(super) async fn end(self, finish: Option<(u16, &'static str)>) {
        if let Some((code, reason)) = finish.or(self.stalled.then_some(STALL_CLOSE)) {
            self.finish(code, reason.into()).await;
        }
    }
}

impl InputState {
    pub(super) fn cancel_cwd(&mut self) {
        self.cwd = None;
    }

    pub(super) async fn next_cwd(&mut self) -> CwdReading {
        match &mut self.cwd {
            Some(reading) => reading.await,
            None => std::future::pending().await,
        }
    }

    pub(super) fn complete_cwd(&mut self, (cwd, cwd_rel): CwdReading) -> Result<(), ()> {
        self.cwd = None;
        self.reply(ServerFrame::Cwd { cwd, cwd_rel })
    }

    fn reply(&mut self, frame: ServerFrame) -> Result<(), ()> {
        let message = frame_message(frame);
        let bytes = match &message {
            Message::Text(text) => text.len(),
            _ => unreachable!("a server control frame is text"),
        };
        if self.replies.len() == MAX_PENDING_REPLIES
            || bytes > MAX_PENDING_REPLY_BYTES.saturating_sub(self.reply_bytes)
        {
            return Err(());
        }
        self.reply_bytes += bytes;
        self.replies.push_back((bytes, message));
        Ok(())
    }

    fn receive(
        &mut self,
        state: &AppState,
        session: &AttachHandle,
        message: Option<Result<Message, axum::Error>>,
    ) -> Result<(), ()> {
        let Some(Ok(message)) = message else {
            return Err(());
        };
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => return Err(()),
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => return Ok(()),
        };
        let progress = session.output_progress();
        // The first text frame read after a release starts the stall clock
        // wherever the socket reads it, also inside a send that was pending
        // at the release, where the loop does not see the release. The
        // wait starts before the frame counts, and the update follows the
        // frame's own ack, so an ack that advances restarts it instead.
        if self.stall.is_none() {
            if let Some(progress) = progress.as_ref().filter(|progress| progress.needs_replay()) {
                self.stall = Some(Stall::new(progress.acked(), self.frames));
            }
        }
        self.frames += 1;
        self.client.observe(Some(session.id()), None);
        let applied = self.apply(state, session, &text);
        if let (Some(stall), Some(progress)) = (self.stall.as_mut(), progress) {
            stall.update(progress.acked(), self.frames);
        }
        applied
    }

    fn apply(&mut self, state: &AppState, session: &AttachHandle, text: &str) -> Result<(), ()> {
        match serde_json::from_str::<ClientFrame>(text) {
            Ok(frame @ (ClientFrame::Input { .. } | ClientFrame::BroadcastInput { .. })) => {
                let Some(data) = client_input_bytes(&frame) else {
                    return self.reply(ServerFrame::Error {
                        message:
                            "invalid terminal frame: binary input holds a character above U+00FF"
                                .into(),
                        reason: None,
                    });
                };
                if matches!(&frame, ClientFrame::Input { .. }) {
                    session.send_input(&data);
                } else {
                    state
                        .terminal_sessions
                        .broadcast_input_cross_window(session.id(), &data);
                }
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::Resize { cols, rows }) => {
                let size = pty_size(Some(cols), Some(rows));
                self.client
                    .observe(Some(session.id()), Some((size.cols, size.rows)));
                session.resize(size);
                self.size = Some(size);
                self.size_conditional = false;
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::Cwd) => {
                if self.cwd.is_none() {
                    self.cwd = Some(Box::pin(terminal_cwd_payload_blocking(
                        state.try_workspace().ok(),
                        session.blocking_cwd_probe(),
                    )));
                }
            }
            Ok(ClientFrame::Focus { focused }) => {
                self.focus = session.set_focused(focused);
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::TmuxRequest { request }) => {
                let hopped = session.tmux_pane().is_some_and(|pane| {
                    state
                        .terminal_sessions
                        .tmux_request_for(&pane, request.clone())
                });
                if !hopped {
                    session.tmux_request(request);
                }
            }
            Ok(ClientFrame::TmuxAnswer { answer }) => {
                session.answer_tmux(answer);
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::SetBroadcast { on }) => {
                session.set_broadcast(on);
                state.terminal_sessions.notify_roster_change();
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::Placement {
                pane_id,
                side,
                tab_id,
            }) => {
                state.terminal_sessions.update_session_layout(
                    session.id(),
                    pane_id.and_then(|id| normalize_label(&id, MAX_ID_CHARS)),
                    side,
                    tab_id.and_then(|id| normalize_label(&id, MAX_ID_CHARS)),
                );
            }
            Ok(ClientFrame::Rename { name, group }) => {
                let frame = match rename_terminal_session(
                    &state.terminal_sessions,
                    session.id(),
                    &name,
                    group.as_deref(),
                ) {
                    Ok(metadata) => ServerFrame::Renamed {
                        name: metadata.name.expect("settled terminal rename has a name"),
                        group: metadata.group,
                    },
                    Err(message) => ServerFrame::RenameFailed { message },
                };
                self.reply(frame)?;
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::Close) => {
                state
                    .terminal_sessions
                    .close(session.id(), CloseReason::Explicit);
            }
            Ok(ClientFrame::Prompt { data, agent, id }) => {
                let submit = SubmitAgent::from_agent_name(agent.as_deref().unwrap_or("claude"))
                    .map(ResolvedSubmit::resolve);
                let outcome = session.enqueue_prompt(data, submit, id.clone());
                if let Some(id) = id {
                    self.reply(ServerFrame::PromptAck {
                        id,
                        queued: outcome.is_some(),
                        depth: outcome.unwrap_or_else(|| session.queue_depth()),
                    })?;
                }
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::QueueDetails { enabled }) => {
                self.queue_details = enabled;
                if enabled {
                    self.reply(ServerFrame::QueueDetails {
                        messages: session.queued_message_previews(),
                    })?;
                }
            }
            Ok(ClientFrame::CancelPrompt { id }) => {
                let removed = session.cancel_prompt(&id);
                self.reply(ServerFrame::PromptCancelled { id, removed })?;
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Ok(ClientFrame::Ack { generation, seq }) => {
                if generation == session.generation {
                    if let Some(progress) = session.output_progress() {
                        progress.acknowledge(seq);
                    }
                }
            }
            Ok(ClientFrame::Ping) => {
                self.reply(ServerFrame::Pong)?;
                state
                    .last_activity
                    .store(now_unix_secs(), Ordering::Relaxed);
            }
            Err(error) => {
                self.reply(ServerFrame::Error {
                    message: format!("invalid terminal frame: {error}"),
                    reason: None,
                })?;
            }
        }
        Ok(())
    }
}
