use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::registry::library;

/// Run chan-llm's MCP server on stdio against `path`. Spawned by
/// external MCP clients through config files; not user-facing.
///
/// We deliberately do NOT auto-register the workspace here: the host
/// (chan-server) has already registered the workspace for
/// this workspace when the session started, and the MCP subprocess
/// inherits that registry. If the workspace isn't registered when the
/// agent invokes the subcommand, that's a wiring bug worth
/// surfacing rather than silently fixing.
pub(super) async fn cmd_mcp(path: PathBuf) -> Result<()> {
    let workspace = library()?
        .open_workspace(&path)
        .with_context(|| format!("opening workspace {}", path.display()))?;
    chan_llm::mcp::Server::new(workspace)
        .serve_stdio()
        .await
        .context("running MCP server")
}

/// Bridge between the agent subprocess and the MCP server hosted in
/// chan-server. Connects to the server's MCP transport (a Unix-domain
/// socket on unix, a named pipe on Windows) and pipes stdin -> socket and
/// socket -> stdout concurrently. Returns when either direction closes,
/// which is the normal end of a session.
pub(super) async fn cmd_mcp_proxy(socket: PathBuf) -> Result<()> {
    chan_server::run_mcp_stdio_proxy(socket)
        .await
        .context("running MCP proxy")
}
