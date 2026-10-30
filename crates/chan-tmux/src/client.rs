//! The protocol state machine: a [`Decoder`] plus the queue that pairs each
//! reply with the command that asked for it.

use std::collections::VecDeque;

use crate::command::Command;
use crate::decode::{Decoder, Frame, Limits};
use crate::error::Error;
use crate::message::{parse_message, Message};

/// Most commands waiting for a reply at once.
const MAX_PENDING: usize = 256;

/// Names a submitted command in the [`Event::Reply`] that answers it.
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

#[derive(Debug)]
pub struct Client {
    decoder: Decoder,
    pending: VecDeque<Token>,
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
            next: 0,
            ready: false,
            failed: false,
        }
    }

    /// Allow the entry marker. See [`Decoder::new`].
    pub fn arm(&mut self, armed: bool) {
        self.decoder.arm(armed);
    }

    pub fn in_control_mode(&self) -> bool {
        self.decoder.in_control_mode()
    }

    /// Whether the server has announced a session, after which commands may
    /// be sent.
    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// Queue a command and return the bytes to write to tmux.
    pub fn submit(&mut self, command: &Command) -> Result<(Token, Vec<u8>), Error> {
        if self.failed {
            return Err(Error::Poisoned);
        }
        if !self.decoder.in_control_mode() || !self.ready {
            return Err(Error::NotReady);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(Error::TooManyPending);
        }
        let mut line = command.render()?.into_bytes();
        line.push(b'\n');
        let token = Token(self.next);
        self.next += 1;
        self.pending.push_back(token);
        self.decoder.expect_next(command.expect());
        Ok((token, line))
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
                if block.solicited {
                    let token = self.pending.pop_front().ok_or(Error::UnexpectedReply)?;
                    out.push(Event::Reply {
                        token,
                        result: if block.ok {
                            Ok(block.lines)
                        } else {
                            Err(block.lines)
                        },
                    });
                } else {
                    out.push(Event::Unsolicited {
                        ok: block.ok,
                        lines: block.lines,
                    });
                }
            }
            Frame::Exit { reason } => {
                self.ready = false;
                out.push(Event::Exited {
                    reason,
                    dropped: self.pending.drain(..).collect(),
                });
            }
        }
        Ok(())
    }
}
