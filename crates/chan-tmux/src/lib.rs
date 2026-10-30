//! tmux control mode (`tmux -CC` and `tmux -C`): the protocol, with no I/O.
//!
//! A [`Client`] turns the bytes tmux writes into [`Event`]s and the commands
//! a caller submits into the bytes to write back. Nothing here reads a
//! socket, spawns a process or keeps a clock, so the same code serves a PTY
//! on a server, a pipe in a test and a replayed capture.
//!
//! Everything tmux sends is untrusted: pane output is whatever the program
//! printed, and a reply to `capture-pane` carries pane rows verbatim. See
//! [`decode`] for how reply blocks are framed so that those rows cannot end
//! a block early.

#![forbid(unsafe_code)]

mod client;
mod command;
pub mod decode;
mod error;
pub mod escape;
mod ids;
pub mod layout;
mod message;

pub use client::{Client, Event, Token};
pub use command::{
    parse_created_id, parse_list_panes, parse_list_windows, parse_pane_state, Command, PaneInfo,
    PaneState, Version, WindowInfo, MAX_KEY_BYTES,
};
pub use decode::{Block, Decoder, Expect, Frame, Limits};
pub use error::Error;
pub use ids::{PaneId, SessionId, WindowId};
pub use layout::{parse_layout, Cell, Kind, Layout, LayoutError};
pub use message::{parse_message, Message};
