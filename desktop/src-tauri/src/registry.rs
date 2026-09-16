//! Location of the chan workspace registry.
//!
//! chan persists its registry of known workspaces at `~/.chan/config.toml`
//! (see `chan_workspace::registry`). chan-desktop watches that file for
//! changes; mutation routes through the embedded host's shared
//! `chan_workspace::Library`, never through this module.

use std::path::PathBuf;

/// Absolute path to the chan registry file. `~/.chan/config.toml` on every
/// desktop target. Routed through `chan_workspace::paths::global_config_path`
/// (the single config-dir authority) so a `CHAN_HOME` override isolates a smoke
/// instance -- byte-identical to the old inlined `~/.chan/config.toml`, including
/// the home-unresolvable fallback (`.chan/config.toml`), when `CHAN_HOME` is unset.
pub fn path() -> PathBuf {
    chan_workspace::paths::global_config_path()
}
