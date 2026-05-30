export type TerminalWsPathOpts = {
  cols: number;
  rows: number;
  tabName: string;
  windowId?: string | null;
  sessionId?: string | null;
  lastSeq?: number | null;
  mcpEnv?: boolean | null;
  cwd?: string | null;
};

export function terminalWsPath(opts: TerminalWsPathOpts): string {
  const params = new URLSearchParams({
    cols: String(opts.cols),
    rows: String(opts.rows),
    tab_name: opts.tabName,
  });
  const windowId = opts.windowId?.trim();
  if (windowId) params.set("window_id", windowId);
  const sessionId = opts.sessionId?.trim();
  if (sessionId) {
    params.set("session", sessionId);
    params.set("since", String(Math.max(0, Math.floor(opts.lastSeq ?? 0))));
  } else {
    const cwd = opts.cwd?.trim();
    if (cwd) params.set("cwd", cwd);
    if (opts.mcpEnv === false) params.set("mcp_env", "off");
  }
  return `/api/terminal/ws?${params.toString()}`;
}
