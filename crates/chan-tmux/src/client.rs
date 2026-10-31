//! The protocol state machine: a [`Decoder`] plus the queue that pairs each
//! reply with the command that asked for it.

use std::collections::VecDeque;

use crate::command::{parse_pane_state, Command, PaneState, MAX_SIZE};
use crate::decode::{Decoder, Expect, Frame, Limits};
use crate::error::Error;
use crate::message::{parse_message, Message};

/// Most reply blocks waiting at once.
const MAX_PENDING: usize = 256;

/// Names a submitted command in the [`Event`] that answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Token(pub u64);

/// What a [`Client`] reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Bytes outside control mode: ordinary terminal output.
    Passthrough(Vec<u8>),
    /// Control mode began.
    Entered,
    Message(Message),
    /// The reply to a submitted command. `Err` carries an `%error` block's
    /// rows, which are tmux's message.
    Reply {
        token: Token,
        result: Result<Vec<Vec<u8>>, Vec<Vec<u8>>>,
    },
    /// The reply to a [`Command::CapturePane`]: the pane's state and the
    /// rows it promised, read in one go.
    Capture {
        token: Token,
        state: PaneState,
        rows: Vec<Vec<u8>>,
    },
    /// A reply to a command the server issued itself.
    Unsolicited {
        ok: bool,
        lines: Vec<Vec<u8>>,
    },
    /// A line that is neither a notification nor part of a reply.
    Stray(Vec<u8>),
    /// Control mode ended. `dropped` are the commands that will never be
    /// answered.
    Exited {
        reason: Option<String>,
        dropped: Vec<Token>,
    },
}

/// Which reply block of a command a pending entry waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    /// The command's one reply.
    Whole,
    /// The pane state that opens a capture.
    CaptureState,
    /// The rows that close a capture.
    CaptureRows,
}

#[derive(Debug)]
pub struct Client {
    decoder: Decoder,
    pending: VecDeque<(Token, Part)>,
    /// The state half of the capture whose rows are next.
    capture: Option<(Token, PaneState)>,
    next: u64,
    ready: bool,
    failed: bool,
}

impl Client {
    /// A client for `tmux -CC`: plain until armed and the marker arrives.
    pub fn new(limits: Limits) -> Self {
        Self::with(Decoder::new(limits))
    }

    /// A client for `tmux -C`, which starts in control mode with no marker.
    pub fn in_control(limits: Limits) -> Self {
        Self::with(Decoder::in_control(limits))
    }

    fn with(decoder: Decoder) -> Self {
        Self {
            decoder,
            pending: VecDeque::new(),
            capture: None,
            next: 0,
            ready: false,
            failed: false,
        }
    }

    /// Allow the entry marker. See [`Decoder::new`].
    pub fn arm(&mut self, armed: bool) {
        self.decoder.arm(armed);
    }

    /// Whether the entry marker is recognized.
    pub fn armed(&self) -> bool {
        self.decoder.armed()
    }

    pub fn in_control_mode(&self) -> bool {
        self.decoder.in_control_mode()
    }

    /// Whether the server has announced a session, after which commands may
    /// be sent.
    pub fn ready(&self) -> bool {
        self.ready
    }

    /// Reply blocks still to come. A capture counts two.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// Queue a command and return the bytes to write to tmux.
    ///
    /// A refusal leaves the client as it was: the command was not queued and
    /// nothing is owed. Only [`feed`](Self::feed) can end the client.
    pub fn submit(&mut self, command: &Command) -> Result<(Token, Vec<u8>), Error> {
        if self.failed {
            return Err(Error::Poisoned);
        }
        if !self.decoder.in_control_mode() || !self.ready {
            return Err(Error::NotReady);
        }
        let expects = command.expects();
        if self.pending.len() + expects.len() > MAX_PENDING {
            return Err(Error::TooManyPending);
        }
        if let Command::CapturePane { history_rows, .. } = command {
            // The promise must fit the block bound at any pane height, or
            // the reply would end the stream instead of being refused here.
            let worst = *history_rows as usize + MAX_SIZE as usize;
            if worst > self.decoder.limits().max_block_lines {
                return Err(Error::BadArgument("capture exceeds the block bound"));
            }
        }
        let mut line = command.render()?.into_bytes();
        line.push(b'\n');
        let token = Token(self.next);
        self.next += 1;
        for expect in expects {
            let part = match expect {
                Expect::PaneState => Part::CaptureState,
                Expect::Capture { .. } => Part::CaptureRows,
                Expect::Any | Expect::Rows(_) => Part::Whole,
            };
            self.pending.push_back((token, part));
            self.decoder.expect_next(expect);
        }
        Ok((token, line))
    }

    /// End the client. A caller whose write of a submitted command failed or
    /// stopped short calls this: the command's reply is still expected, so
    /// every later reply would pair with the wrong command.
    pub fn fail(&mut self) {
        self.failed = true;
    }

    /// Decode bytes read from tmux.
    ///
    /// Any error ends the client: later calls return [`Error::Poisoned`].
    /// Events decoded before the failure are dropped with it, because a
    /// stream that lost its framing cannot vouch for them.
    pub fn feed(&mut self, input: &[u8]) -> Result<Vec<Event>, Error> {
        if self.failed {
            return Err(Error::Poisoned);
        }
        let mut frames = Vec::new();
        let decoded = self.decoder.feed(input, &mut frames);
        let mut events = Vec::with_capacity(frames.len());
        let result = frames
            .into_iter()
            .try_for_each(|frame| self.event(frame, &mut events))
            .and(decoded);
        match result {
            Ok(()) => Ok(events),
            Err(e) => {
                self.failed = true;
                Err(e)
            }
        }
    }

    fn event(&mut self, frame: Frame, out: &mut Vec<Event>) -> Result<(), Error> {
        match frame {
            Frame::Passthrough(bytes) => out.push(Event::Passthrough(bytes)),
            Frame::Entered => {
                self.ready = false;
                self.pending.clear();
                self.capture = None;
                out.push(Event::Entered);
            }
            Frame::Line(line) => match parse_message(&line) {
                Ok(message) => {
                    if matches!(message, Message::SessionChanged { .. }) {
                        self.ready = true;
                    }
                    out.push(Event::Message(message));
                }
                Err(_) if line.first() != Some(&b'%') => out.push(Event::Stray(line)),
                Err(e) => return Err(e),
            },
            Frame::Block(block) => {
                if !block.solicited {
                    out.push(Event::Unsolicited {
                        ok: block.ok,
                        lines: block.lines,
                    });
                    return Ok(());
                }
                let (token, part) = self.pending.pop_front().ok_or(Error::UnexpectedReply)?;
                let result = if block.ok {
                    Ok(block.lines)
                } else {
                    Err(block.lines)
                };
                match (part, result) {
                    (Part::Whole, result) => out.push(Event::Reply { token, result }),
                    (Part::CaptureState, Ok(lines)) => {
                        self.capture = Some((token, parse_pane_state(&lines)?));
                    }
                    (Part::CaptureRows, Ok(rows)) => match self.capture.take() {
                        Some((t, state)) if t == token => {
                            out.push(Event::Capture { token, state, rows });
                        }
                        _ => return Err(Error::NoPaneState),
                    },
                    // A failed half fails the capture; the decoder ends the
                    // stream at the rows of a capture whose state failed.
                    (Part::CaptureState | Part::CaptureRows, Err(lines)) => {
                        self.capture = None;
                        out.push(Event::Reply {
                            token,
                            result: Err(lines),
                        });
                    }
                }
            }
            Frame::Exit { reason } => {
                self.ready = false;
                self.capture = None;
                let mut dropped: Vec<Token> = Vec::new();
                for (token, _) in self.pending.drain(..) {
                    if dropped.last() != Some(&token) {
                        dropped.push(token);
                    }
                }
                out.push(Event::Exited { reason, dropped });
            }
        }
        Ok(())
    }
}
