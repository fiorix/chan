use std::fmt;

/// A protocol failure. Every variant is final for the decoder that raised it:
/// the stream has lost its framing or its bounds, and the connection is ended
/// rather than guessed at. Variants carry no stream bytes, so an error is safe
/// to log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// A line grew past [`Limits::max_line`](crate::Limits::max_line).
    LineTooLong,
    /// A reply block grew past its byte or line bound.
    BlockTooLarge,
    /// A command reply arrived with no command waiting for it.
    UnexpectedReply,
    /// A reply did not have the row count its command promised.
    ReplyShape,
    /// A notification the decoder knows by name did not parse.
    Malformed(&'static str),
    /// More commands are waiting for a reply than the bound allows.
    TooManyPending,
    /// A command was submitted before the server announced a session.
    NotReady,
    /// The decoder already failed; it takes no more input.
    Poisoned,
    /// A command argument cannot be sent as one command line.
    BadArgument(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::LineTooLong => f.write_str("tmux control line exceeds the length bound"),
            Error::BlockTooLarge => f.write_str("tmux reply block exceeds its size bound"),
            Error::UnexpectedReply => f.write_str("tmux sent a reply no command was waiting for"),
            Error::ReplyShape => f.write_str("tmux reply does not have the promised row count"),
            Error::Malformed(what) => write!(f, "malformed tmux notification: {what}"),
            Error::TooManyPending => f.write_str("too many tmux commands waiting for a reply"),
            Error::NotReady => f.write_str("tmux has not announced a session yet"),
            Error::Poisoned => f.write_str("tmux control stream already failed"),
            Error::BadArgument(what) => write!(f, "tmux command argument refused: {what}"),
        }
    }
}

impl std::error::Error for Error {}
