//! Stream framing: bytes in, frames out.
//!
//! The decoder owns the three things the byte stream gets wrong if a reader
//! is casual: where control mode starts and ends, where a reply block ends,
//! and what is a line at all.
//!
//! A reply block carries pane content raw (`capture-pane`), so a program in a
//! pane can print any line it likes into one, including `%exit` and a copy of
//! the block's own terminator. A terminator is therefore believed only when
//! the block's own header matches it exactly and, for a command that promised
//! a row count, only after exactly that many rows. Nothing inside a block is
//! ever read as a notification.

use std::collections::VecDeque;

use crate::error::Error;

/// `DCS 1000 p`, which `tmux -CC` prints once on entry.
const MARKER: &[u8] = b"\x1bP1000p";
const ESC: u8 = 0x1b;

/// Size bounds that keep a hostile or broken stream from growing memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Longest line, in bytes, without its line break.
    pub max_line: usize,
    /// Most bytes one reply block may hold.
    pub max_block_bytes: usize,
    /// Most lines one reply block may hold.
    pub max_block_lines: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_line: 256 * 1024,
            max_block_bytes: 16 * 1024 * 1024,
            max_block_lines: 200_000,
        }
    }
}

/// What a command's reply must look like to be believed.
pub type Expect = Option<usize>;

/// One unit of decoded stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// Bytes outside control mode, in order, to be handled as terminal output.
    Passthrough(Vec<u8>),
    /// Control mode began.
    Entered,
    /// A line outside any reply block, without its line break.
    Line(Vec<u8>),
    /// A completed reply block.
    Block(Block),
    /// `%exit` was read; the stream is back to plain bytes after its `ST`.
    Exit { reason: Option<String> },
}

/// A completed command reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    /// tmux's timestamp of the reply.
    pub time: u64,
    /// tmux's command number.
    pub number: u64,
    /// `false` when the server issued the command itself (flag bit 0 clear),
    /// as it does for the first reply after entry.
    pub solicited: bool,
    /// `%end` (`true`) or `%error` (`false`).
    pub ok: bool,
    /// Reply rows, without line breaks.
    pub lines: Vec<Vec<u8>>,
}

#[derive(Debug, PartialEq, Eq)]
enum State {
    Plain,
    Control,
    /// After `%exit`: the `ESC \` that closes the DCS.
    AwaitSt {
        esc: bool,
    },
}

#[derive(Debug)]
struct Open {
    /// `<time> <number> <flags>` exactly as tmux printed it.
    header: Vec<u8>,
    time: u64,
    number: u64,
    solicited: bool,
    expect: Expect,
    lines: Vec<Vec<u8>>,
    bytes: usize,
}

/// Incremental decoder. Feed it any split of the stream.
#[derive(Debug)]
pub struct Decoder {
    limits: Limits,
    state: State,
    armed: bool,
    /// Bytes of [`MARKER`] matched so far while plain.
    matched: usize,
    line: Vec<u8>,
    open: Option<Open>,
    expect: VecDeque<Expect>,
    poisoned: bool,
}

impl Decoder {
    /// A decoder that passes everything through until [`arm`](Self::arm) is
    /// called. Entry is never recognized unarmed: a program that prints the
    /// marker into an ordinary terminal must not be able to start a session.
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            state: State::Plain,
            armed: false,
            matched: 0,
            line: Vec::new(),
            open: None,
            expect: VecDeque::new(),
            poisoned: false,
        }
    }

    /// A decoder already in control mode, for `tmux -C`, which prints no
    /// marker.
    pub fn in_control(limits: Limits) -> Self {
        let mut d = Self::new(limits);
        d.state = State::Control;
        d
    }

    /// Allow or refuse recognizing the entry marker. The caller arms the
    /// decoder only when the user asked for control mode.
    pub fn arm(&mut self, armed: bool) {
        self.armed = armed;
        if !armed {
            // A half-matched marker stays in the stream as ordinary bytes the
            // next time they are flushed.
            self.matched = self.matched.min(MARKER.len() - 1);
        }
    }

    /// Whether the stream is inside control mode.
    pub fn in_control_mode(&self) -> bool {
        !matches!(self.state, State::Plain)
    }

    /// Register what the next solicited reply must look like. Replies come
    /// back in command order, so this is a queue.
    pub fn expect_next(&mut self, expect: Expect) {
        self.expect.push_back(expect);
    }

    /// Decode `input`, appending frames to `out`.
    ///
    /// On `Err` the decoder is poisoned and `out` holds what was decoded
    /// before the failure.
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<Frame>) -> Result<(), Error> {
        if self.poisoned {
            return Err(Error::Poisoned);
        }
        let result = self.feed_inner(input, out);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn feed_inner(&mut self, input: &[u8], out: &mut Vec<Frame>) -> Result<(), Error> {
        let mut pass: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < input.len() {
            match self.state {
                State::Plain if !self.armed && self.matched == 0 => {
                    pass.extend_from_slice(&input[i..]);
                    i = input.len();
                }
                State::Plain => {
                    self.plain_byte(input[i], &mut pass, out);
                    i += 1;
                }
                State::Control => {
                    let rest = &input[i..];
                    match rest.iter().position(|&b| b == b'\n') {
                        Some(n) => {
                            self.push_line_bytes(&rest[..n])?;
                            self.finish_line(out)?;
                            i += n + 1;
                        }
                        None => {
                            self.push_line_bytes(rest)?;
                            i = input.len();
                        }
                    }
                }
                State::AwaitSt { esc } => {
                    let b = input[i];
                    i += 1;
                    if !esc && b == ESC {
                        self.state = State::AwaitSt { esc: true };
                    } else if esc && b == b'\\' {
                        self.state = State::Plain;
                    } else {
                        // Not the closing ST: the stream is plain again and
                        // this byte (with the ESC before it) is ordinary.
                        self.state = State::Plain;
                        if esc {
                            self.plain_byte(ESC, &mut pass, out);
                        }
                        self.plain_byte(b, &mut pass, out);
                    }
                }
            }
        }
        flush(&mut pass, out);
        Ok(())
    }

    fn plain_byte(&mut self, b: u8, pass: &mut Vec<u8>, out: &mut Vec<Frame>) {
        if self.armed && b == MARKER[self.matched] {
            self.matched += 1;
            if self.matched == MARKER.len() {
                self.matched = 0;
                flush(pass, out);
                self.state = State::Control;
                self.line.clear();
                self.open = None;
                out.push(Frame::Entered);
            }
            return;
        }
        if self.matched > 0 {
            pass.extend_from_slice(&MARKER[..self.matched]);
            self.matched = 0;
            if self.armed && b == MARKER[0] {
                self.matched = 1;
                return;
            }
        }
        pass.push(b);
    }

    fn push_line_bytes(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if self.line.len() + bytes.len() > self.limits.max_line + 1 {
            return Err(Error::LineTooLong);
        }
        self.line.extend_from_slice(bytes);
        Ok(())
    }

    fn finish_line(&mut self, out: &mut Vec<Frame>) -> Result<(), Error> {
        let mut line = std::mem::take(&mut self.line);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > self.limits.max_line {
            return Err(Error::LineTooLong);
        }
        if self.open.is_some() {
            return self.block_line(line, out);
        }
        if let Some(rest) = line.strip_prefix(b"%begin ") {
            let (time, number, flags) = parse_header(rest).ok_or(Error::Malformed("begin"))?;
            let solicited = flags & 1 == 1;
            let expect = if solicited {
                self.expect.pop_front().ok_or(Error::UnexpectedReply)?
            } else {
                None
            };
            self.open = Some(Open {
                header: rest.to_vec(),
                time,
                number,
                solicited,
                expect,
                lines: Vec::new(),
                bytes: 0,
            });
            return Ok(());
        }
        if line == b"%exit" || line.starts_with(b"%exit ") {
            let reason = line
                .get(6..)
                .filter(|r| !r.is_empty())
                .map(|r| String::from_utf8_lossy(r).into_owned());
            self.state = State::AwaitSt { esc: false };
            self.expect.clear();
            out.push(Frame::Exit { reason });
            return Ok(());
        }
        out.push(Frame::Line(line));
        Ok(())
    }

    fn block_line(&mut self, line: Vec<u8>, out: &mut Vec<Frame>) -> Result<(), Error> {
        let open = self.open.as_mut().expect("checked by caller");
        let terminator = line
            .strip_prefix(b"%end ")
            .map(|h| (h, true))
            .or_else(|| line.strip_prefix(b"%error ").map(|h| (h, false)))
            .filter(|(h, _)| *h == open.header.as_slice());
        if let Some((_, ok)) = terminator {
            if open.expect.is_none_or(|n| n == open.lines.len()) {
                let open = self.open.take().expect("checked by caller");
                out.push(Frame::Block(Block {
                    time: open.time,
                    number: open.number,
                    solicited: open.solicited,
                    ok,
                    lines: open.lines,
                }));
                return Ok(());
            }
        }
        if let Some(n) = open.expect {
            if open.lines.len() >= n {
                return Err(Error::ReplyShape);
            }
        }
        open.bytes += line.len() + 1;
        if open.bytes > self.limits.max_block_bytes
            || open.lines.len() >= self.limits.max_block_lines
        {
            return Err(Error::BlockTooLarge);
        }
        open.lines.push(line);
        Ok(())
    }
}

fn flush(pass: &mut Vec<u8>, out: &mut Vec<Frame>) {
    if !pass.is_empty() {
        out.push(Frame::Passthrough(std::mem::take(pass)));
    }
}

fn parse_header(rest: &[u8]) -> Option<(u64, u64, u64)> {
    let text = std::str::from_utf8(rest).ok()?;
    let mut it = text.split(' ');
    let time = it.next()?.parse().ok()?;
    let number = it.next()?.parse().ok()?;
    let flags = it.next()?.parse().ok()?;
    it.next().is_none().then_some((time, number, flags))
}
