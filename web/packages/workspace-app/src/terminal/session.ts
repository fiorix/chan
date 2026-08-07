export type TerminalWsPathOpts = {
  cols: number;
  rows: number;
  tabName: string;
  tabGroup?: string | null;
  windowId?: string | null;
  /// SPA layout coordinates of the view this terminal is mounted in, sent on
  /// every (re)attach so `cs terminal list` can trace the complete attachment.
  paneId?: string | null;
  side?: "a" | "b" | null;
  tabId?: string | null;
  sessionId?: string | null;
  /// Byte cursor to resume a reattach from, when the client primes a cached
  /// scrollback snapshot. Omitted -> a full replay from the ring head
  /// (the server reports any overflow loss via `missed_bytes`).
  since?: number | null;
  /// The session generation the cached snapshot belongs to. The server honors
  /// `since` only when this still matches the live session (a restart bumps it).
  generation?: number | null;
  agentEchoSince?: number | null;
  cwd?: string | null;
};

export function terminalWsPath(opts: TerminalWsPathOpts): string {
  const params = new URLSearchParams({
    cols: String(opts.cols),
    rows: String(opts.rows),
    tab_name: opts.tabName,
  });
  // Only non-default groups go on the wire; the server defaults the
  // per-session tab_group to "default" when absent, keeping the common
  // case's URL short.
  const tabGroup = opts.tabGroup?.trim();
  if (tabGroup && tabGroup !== "default") params.set("tab_group", tabGroup);
  const windowId = opts.windowId?.trim();
  if (windowId) params.set("window_id", windowId);
  // Pane/tab are the SPA's layout coordinates for this view; the server records
  // them on the live session for `cs terminal list` window->pane->tab tracing.
  // Sent for both a fresh spawn and a reattach (a terminal always lives in a
  // pane+tab); best-effort, so they ride the URL only when known.
  const paneId = opts.paneId?.trim();
  if (paneId) params.set("pane_id", paneId);
  if (opts.side === "a" || opts.side === "b") params.set("side", opts.side);
  const tabId = opts.tabId?.trim();
  if (tabId) params.set("tab_id", tabId);
  const sessionId = opts.sessionId?.trim();
  if (sessionId) {
    params.set("session", sessionId);
    // `since` defaults to the constant 0 (a full replay into a fresh empty
    // xterm). When the caller has a VALID cached scrollback snapshot it passes
    // the snapshot's byte cursor + generation instead, and the server replays
    // only the delta past it -- but ONLY when the generation still matches
    // (a restart resets the ring/seq). Explicit 0 (vs absent) makes the server
    // report ring-overflow loss via `missed_bytes` rather than silently
    // starting at the ring head. A bare cursor with no matching cached content
    // truncates the replay to the tail the server still holds, so the
    // cursor is only ever sent paired with a restored snapshot + generation.
    params.set("since", String(Math.max(0, Math.floor(opts.since ?? 0))));
    if (opts.generation != null) {
      params.set("generation", String(Math.max(0, Math.floor(opts.generation))));
    }
    params.set(
      "agent_echo_since",
      String(Math.max(0, Math.floor(opts.agentEchoSince ?? 0))),
    );
  } else {
    const cwd = opts.cwd?.trim();
    if (cwd) params.set("cwd", cwd);
    // MCP env injection is governed by the global `terminal.mcp_env`
    // server config (set from the Terminal Settings panel); the SPA
    // sends no per-terminal `?mcp_env=` override. The backend still
    // honours an explicit query for `cs terminal new` / team spawns.
  }
  return `/api/terminal/ws?${params.toString()}`;
}
