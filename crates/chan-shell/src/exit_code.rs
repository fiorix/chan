//! Named process exit codes for the `cs` client, and the typed error that
//! carries one up to the dispatch edge.
//!
//! A `cs terminal write --submit` answered with `ControlResponse::SubmitRefused`
//! exits [`SUBMIT_REFUSED`] (69). The bytes remain accepted into the
//! asynchronous queue; the client carries the refusal as a
//! [`ControlSubmitRefused`] so the terminal-write dispatch edge can preserve
//! the acknowledgement and report that the requested submit did not happen.
//!
//! A current devserver never sends it: the agent named in `--submit` selects
//! the chord and is always encoded. This path exists for a `cs` talking to an
//! OLDER devserver, which derived the chord from the target's spawn command
//! and refused when that named no agent.
//!
//! A bounded blocking request that gets no reply within its window exits
//! [`CONTROL_TIMEOUT`] (124): a `cs terminal survey` whose `--timeout`
//! elapsed, or a `cs copy` / `cs paste` whose clipboard round-trip got no
//! window reply. The server answers such a request with
//! `ControlResponse::Timeout`; [`crate::control::send_control_request`] turns
//! that into a [`ControlTimeout`], and the command's dispatch edge downcasts
//! it, prints the elapsed-window line, and exits with [`CONTROL_TIMEOUT`],
//! so a caller can tell "no answer in time" apart from a real error (exit 1)
//! and from a delivered reply (exit 0).

use std::error::Error;
use std::fmt;

/// A requested hands-free submit was unavailable for at least one target.
/// This matches `sysexits.h` `EX_UNAVAILABLE` (69). Only an older devserver
/// produces it, from back when a target whose spawn command named no agent
/// could not be submitted to at all.
pub(crate) const SUBMIT_REFUSED: i32 = 69;

/// A bounded blocking request elapsed with no reply. Matches GNU
/// `timeout(1)`, which exits 124 when the command it guards times out.
pub(crate) const CONTROL_TIMEOUT: i32 = 124;

/// A control request the server answered with
/// `ControlResponse::SubmitRefused`. The message is still the full queue
/// acknowledgement because the bytes were accepted, while the typed error
/// lets the dispatch edge exit 69 without parsing that prose.
#[derive(Debug)]
pub(crate) struct ControlSubmitRefused {
    pub(crate) message: String,
}

impl fmt::Display for ControlSubmitRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for ControlSubmitRefused {}

/// A control request the server answered with `ControlResponse::Timeout` (a
/// blocking `cs terminal survey` whose `--timeout` window elapsed, or a
/// `cs copy` / `cs paste` clipboard round-trip nothing replied to). Carried
/// as an `anyhow` error so the dispatch edge can downcast it to a distinct
/// exit code instead of the generic exit-1 failure path. The message is the
/// server's elapsed-window line (e.g. `no reply within 600s`).
#[derive(Debug)]
pub(crate) struct ControlTimeout {
    pub(crate) message: String,
}

impl fmt::Display for ControlTimeout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for ControlTimeout {}
