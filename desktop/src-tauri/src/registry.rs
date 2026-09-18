//! Location of the chan workspace registry.
//!
//! chan persists its registry of known workspaces at `~/.chan/config.toml`
//! (see `chan_workspace::registry`). chan-desktop watches that file for
//! changes; mutation routes through the embedded host's shared
//! `chan_workspace::Library`, never through this module.

use std::path::PathBuf;

/// Absolute path to the chan registry file. By default this is
/// `~/.chan/config.toml` when the OS resolves a home directory. Routed through
/// `chan_workspace::paths::global_config_path` (the single config-dir
/// authority) so a `CHAN_HOME` override isolates a smoke instance. When the OS
/// cannot resolve a home directory, the file lives under `/var/tmp/chan-<uid>`
/// on Unix and `C:\ProgramData\chan` on Windows.
pub fn path() -> PathBuf {
    chan_workspace::paths::global_config_path()
}
