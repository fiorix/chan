// Global Team Work dialog request bus.
//
// The dialog renders at the App root so it's free of every parent
// stacking context (the Team Work editor is absolute / z-index:20;
// panes are overflow-hidden; Hybrid Nav adds a filter to non-focused
// panes - any of those can clip a position:fixed dialog).
//
// Cmd+P / the Hybrid menu first creates the Team Work Lead terminal
// (the terminal with the embedded editor), THEN opens this dialog over
// it. The dialog carries the lead tab + pane id so:
//   * Cancel/dismiss deletes that exact lead terminal tab + restores
//     the previous state.
//   * Bootstrap runs the lead-first orchestrator against the EXISTING
//     lead tab (it is never respawned).

import { TEAM_DIR_DEFAULT } from "./teamConfigPath";

/// Submit-encoding target for a member's terminal. `"none"` is a shell
/// member (no submit chord, plain Enter); the named values map to the
/// server-owned `SubmitAgent` map so a poke or the lead composer applies
/// that agent's submit chord. Mirrors
/// the picker type in TeamWork.svelte; the wire form drops `"none"` and
/// omits the field entirely (`TeamMemberWire.agent?`).
export type AgentTarget =
  | "none"
  | "agy"
  | "claude"
  | "codex"
  | "gemini"
  | "kimi"
  | "opencode";

/// Derive a member's submit-encoding agent from its spawn command. The match
/// is intentionally LOOSE: it recognizes agy/claude/codex/gemini/kimi/
/// opencode anywhere in the command as a whole word, not just the first
/// token, so wrappers like
/// `my-claude.sh`, `/usr/local/bin/codex-cli`, or `claude --resume` still
/// resolve (the `\b` boundaries keep `claudette` from matching). Anything
/// unrecognized falls back to `"none"` (a shell member, plain Enter); set
/// `CHAN_AGENT` in the member's env to override (see `agentForMember`).
export function agentForCommand(command: string): AgentTarget {
  const c = command.toLowerCase();
  if (/\bagy\b/.test(c)) return "agy";
  if (/\bclaude\b/.test(c)) return "claude";
  if (/\bcodex\b/.test(c)) return "codex";
  if (/\bgemini\b/.test(c)) return "gemini";
  if (/\bkimi\b/.test(c)) return "kimi";
  if (/\bopencode\b/.test(c)) return "opencode";
  return "none";
}

/// A member's submit-encoding agent, replacing the old manual dropdown. An
/// explicit `CHAN_AGENT=<agy|claude|codex|gemini|kimi|opencode|none|shell>`
/// in the member's env
/// WINS - the escape hatch for unorthodox setups (custom launcher scripts a
/// command sniff can't recognize). Otherwise derive loosely from the command.
/// An unrecognized CHAN_AGENT value is ignored (falls through to the command).
export function agentForMember(command: string, envText: string): AgentTarget {
  const m = envText.match(/^[ \t]*CHAN_AGENT[ \t]*=[ \t]*(\S+)/m);
  if (m) {
    const v = m[1].toLowerCase();
    if (
      v === "agy" ||
      v === "claude" ||
      v === "codex" ||
      v === "gemini" ||
      v === "kimi" ||
      v === "opencode"
    ) {
      return v;
    }
    if (v === "none" || v === "shell") return "none";
  }
  return agentForCommand(command);
}

/// One agent in the team being bootstrapped. Position in
/// `TeamDialogConfig.members` is stable (positional id used by the
/// airplane-grid for drag&drop slot assignment).
export interface TeamMemberDraft {
  /// Display name without the `@@` prefix. If
  /// `TeamDialogConfig.autoPrefix` is true the rendered handle is
  /// `@@<name>`; otherwise raw.
  name: string;
  /// Spawn command + flags (e.g. `claude` / `claude --resume`).
  /// Free-form so users can pick whatever agent runtime.
  command: string;
  /// Additional `KEY=VALUE` env vars (one per line). The orchestrator
  /// auto-injects `CHAN_TAB_NAME=<name>` separately so users don't
  /// have to remember it.
  env: string;
  /// Exactly one member must be flagged as lead; the lead lands on
  /// the existing Team Work Lead terminal, the others on new tabs.
  /// The submit-encoding agent is no longer stored here: it is derived
  /// from `command` (loosely) + a `CHAN_AGENT` env override at wire time
  /// (see `agentForMember`).
  isLead: boolean;
}

/// The pane real-estate strategy for the team's terminals.
///
/// `tabs`: all team terminals spawn as tabs in the host's current
/// Hybrid (single pane).
///
/// `split`: a grid of panes; each pane holds one or more terminals
/// (multi-robot per cell = tabs in that pane). `grid` locks the
/// row/col shape; `slots` is a flattened row-major array where
/// `slots[i]` is the list of member indexes assigned to cell `i`.
export type TeamRealEstate =
  | { kind: "tabs" }
  | { kind: "split"; grid: GridShape; slots: number[][] };

/// A grid shape (rows x cols). Capacity (`rows * cols`) is what
/// determines how many cells the grid offers; users can leave cells
/// empty OR stack multiple robots in a single cell.
export interface GridShape {
  rows: number;
  cols: number;
}

/// Available grid shapes for a given team size. Returns a list in
/// display order (most-balanced first). Sizes without a good factor
/// pair fall back to 1xN (e.g. size 5 -> just 1x5).
export function gridShapesForSize(size: number): GridShape[] {
  if (size <= 1) return [{ rows: 1, cols: Math.max(1, size) }];
  const shapes: GridShape[] = [];
  const seen = new Set<string>();
  const push = (rows: number, cols: number): void => {
    if (rows * cols < size) return;
    const key = `${rows}x${cols}`;
    if (seen.has(key)) return;
    seen.add(key);
    shapes.push({ rows, cols });
  };
  // Most-balanced shape: smallest perimeter-ish RxC that still fits.
  // Walk R from floor(sqrt(size)) outward and pick the best C.
  const root = Math.floor(Math.sqrt(size));
  for (let r = root; r >= 1; r -= 1) {
    const c = Math.ceil(size / r);
    push(r, c);
  }
  // Transpose pairs (so 2x3 + 3x2 both show).
  for (const s of [...shapes]) {
    if (s.rows !== s.cols) push(s.cols, s.rows);
  }
  // Always include the linear fallbacks (1xN + Nx1).
  push(1, size);
  push(size, 1);
  return shapes;
}

/// Default grid shape for a given size: most-balanced (the first
/// entry in `gridShapesForSize`). 5 -> 1x5; 6 -> 2x3; etc.
export function defaultGridForSize(size: number): GridShape {
  const shapes = gridShapesForSize(size);
  return shapes[0] ?? { rows: 1, cols: Math.max(1, size) };
}

/// Empty slots arena sized for `grid.rows * grid.cols`. Each cell
/// starts empty; drag&drop populates the inner arrays.
export function emptySlotsForGrid(grid: GridShape): number[][] {
  const cells = Math.max(1, grid.rows * grid.cols);
  return Array.from({ length: cells }, () => []);
}

/// The two Team configuration modes the dialog toggles between.
/// `new` starts from a blank/default config persisted to a fresh
/// team directory; `load` reads an existing team's config.toml back
/// to prepopulate the form (after which the user is editing a
/// pre-populated New form).
export type TeamConfigMode = "new" | "load";

export interface TeamDialogConfig {
  hostName: string;
  /// Team configuration source mode: "new" or "load". Controls whether
  /// the dialog writes or reads the team's config.toml.
  configMode: TeamConfigMode;
  /// Workspace-relative team directory (e.g. `new-team-1`). New: where
  /// the team files are created. Load: where the config is read from.
  /// Defaults to `TEAM_DIR_DEFAULT`. The config lives inside the
  /// workspace at `{teamDir}/config.toml`.
  teamDir: string;
  /// Terminal tab-group every team terminal joins ($CHAN_TAB_GROUP).
  /// Defaults to the team-dir basename (via `defaultTabGroupFromPath`);
  /// the orchestrator resolves a `-N` suffix at Bootstrap if it collides
  /// with a live group, so the dialog just carries the desired base name.
  tabGroup: string;
  /// Total agents (lead + workers). 1-9.
  size: number;
  /// When true, all member names render with `@@` prefix.
  autoPrefix: boolean;
  /// When true, the team's terminals start with the chan MCP env vars
  /// (CHAN_MCP_*) exposed. Default OFF: agents still reach `cs search` +
  /// friends via the control socket; opt in only when an agent consumes the
  /// MCP env directly. Mirrors `chan_workspace::TeamConfig.mcp_env`.
  mcpEnv: boolean;
  /// Length must equal `size`. Exactly one member has `isLead: true`.
  members: TeamMemberDraft[];
  realEstate: TeamRealEstate;
  /// Optional brief Markdown folded VERBATIM into the generated
  /// `bootstrap.md` (its own section after the Roster), so a round's custom
  /// operating instructions survive a normal regenerate. Empty -> the generic
  /// bootstrap. The dialog holds the brief TEXT (not a path): the server has
  /// no access to the client filesystem, mirroring the CLI's `--brief`. Not
  /// part of the persisted `config.toml`; it travels alongside it.
  brief: string;
}

/// The dialog request object. App.svelte creates the Team Work Lead
/// terminal at Cmd+P FIRST, then opens the dialog passing that exact
/// tab + pane id. Cancel deletes `{leadPaneId, leadTabId}`; Bootstrap
/// runs the lead-first orchestrator against it.
export interface TeamDialogRequest {
  leadTabId: string;
  leadPaneId: string;
}

export const teamDialogState = $state<{ request: TeamDialogRequest | null }>({
  request: null,
});

export function openTeamDialog(request: TeamDialogRequest): void {
  teamDialogState.request = request;
}

export function closeTeamDialog(): void {
  teamDialogState.request = null;
}

/// Team size limits. One agent is allowed and is the lead by
/// definition. The host is not counted; they sit in the Team Work
/// Lead terminal alongside the lead agent.
export const TEAM_MIN_SIZE = 1;
export const TEAM_MAX_SIZE = 9;

/// Derive the default terminal tab-group name from a team directory:
/// its last path segment (basename). A trailing slash is stripped
/// (`new-team-1/` -> `new-team-1`; `teams/alpha` -> `alpha`). Falls
/// back to `chan-team` when the dir has no usable basename.
export function defaultTabGroupFromPath(teamDir: string): string {
  const trimmed = teamDir.replace(/\/+$/, "");
  const base = trimmed.split("/").pop() ?? "";
  return base || "chan-team";
}

/// Auto-assign: distribute every member NOT already placed in a cell
/// across the split grid's cells, filling the least-populated cell each time
/// (so empty cells fill first, then it balances). Members already dropped into
/// a cell stay put. Pure: returns a fresh slots array, the input untouched.
/// Backs the team dialog's auto-assign button next to the layout-shape picker.
export function autoAssignSlots(
  slots: number[][],
  memberCount: number,
): number[][] {
  const next = slots.map((cell) => [...cell]);
  if (next.length === 0) return next;
  const placed = new Set<number>();
  for (const cell of next) for (const m of cell) placed.add(m);
  for (let m = 0; m < memberCount; m += 1) {
    if (placed.has(m)) continue;
    // Least-populated cell; ties resolve to the lowest index, so empty cells
    // fill in row-major order before any cell takes a second robot.
    let target = 0;
    for (let i = 1; i < next.length; i += 1) {
      if (next[i].length < next[target].length) target = i;
    }
    next[target].push(m);
    placed.add(m);
  }
  return next;
}

/// Default team config used as the dialog's initial state. One lead
/// member, auto-prefix on, New mode, real estate defaults to tabs.
export function defaultTeamConfig(): TeamDialogConfig {
  return {
    hostName: "Neo",
    configMode: "new",
    teamDir: TEAM_DIR_DEFAULT,
    tabGroup: defaultTabGroupFromPath(TEAM_DIR_DEFAULT),
    size: TEAM_MIN_SIZE,
    autoPrefix: true,
    mcpEnv: false,
    members: [
      { name: "Lead", command: "claude", env: "", isLead: true },
    ],
    realEstate: { kind: "tabs" },
    brief: "",
  };
}

/// Returns the first validation issue with the supplied config, or
/// null when valid. Used by the dialog to enable/disable the
/// Bootstrap button + surface inline errors.
export function validateTeamConfig(cfg: TeamDialogConfig): string | null {
  // Copy uses the dialog-visible labels so the user knows which
  // input to fix.
  if (!cfg.hostName.trim()) return "Your name required";
  if (!cfg.teamDir.trim()) return "Team directory required";
  // The team dir is workspace-relative; reject a leading `/` so the
  // config lands inside the workspace sandbox, not at an absolute path.
  if (cfg.teamDir.trim().startsWith("/")) {
    return "Team directory must be a path inside the workspace";
  }
  if (!cfg.tabGroup.trim()) return "Terminal tab group name required";
  if (cfg.size < TEAM_MIN_SIZE) {
    return `agent count must be at least ${TEAM_MIN_SIZE}`;
  }
  if (cfg.size > TEAM_MAX_SIZE) {
    return `agent count must be at most ${TEAM_MAX_SIZE}`;
  }
  if (cfg.members.length !== cfg.size) {
    return "member count must match agent count";
  }
  const leadCount = cfg.members.filter((m) => m.isLead).length;
  if (leadCount === 0) return "one member must be marked as lead";
  if (leadCount > 1) return "exactly one member can be marked as lead";
  if (cfg.members.some((m) => !m.name.trim())) {
    return "every member needs a name";
  }
  return null;
}

/// Switch the real-estate strategy while preserving any
/// previously-configured split grid (so the user can toggle tabs <->
/// split without losing their arrangement). When switching INTO
/// `split`, picks the default grid for the team size + empty slots.
export function switchRealEstate(
  cfg: TeamDialogConfig,
  kind: TeamRealEstate["kind"],
): TeamDialogConfig {
  if (kind === "tabs") return { ...cfg, realEstate: { kind: "tabs" } };
  if (cfg.realEstate.kind === "split") return cfg;
  const grid = defaultGridForSize(cfg.size);
  return {
    ...cfg,
    realEstate: { kind: "split", grid, slots: emptySlotsForGrid(grid) },
  };
}

/// Reshape the active split grid + reset slots to empty.
export function reshapeSplitGrid(
  cfg: TeamDialogConfig,
  grid: GridShape,
): TeamDialogConfig {
  if (cfg.realEstate.kind !== "split") return cfg;
  return {
    ...cfg,
    realEstate: { kind: "split", grid, slots: emptySlotsForGrid(grid) },
  };
}

/// Assign a member index to a split grid cell. If the member was
/// previously assigned elsewhere, remove from the prior cell first.
/// Same-cell drop is a no-op (idempotent). Multiple members per cell
/// are allowed (they materialise as tabs in that pane).
export function assignMemberToCell(
  cfg: TeamDialogConfig,
  memberIdx: number,
  cellIdx: number,
): TeamDialogConfig {
  if (cfg.realEstate.kind !== "split") return cfg;
  const slots = cfg.realEstate.slots.map((cell, i) => {
    const filtered = cell.filter((m) => m !== memberIdx);
    if (i === cellIdx && !filtered.includes(memberIdx)) {
      return [...filtered, memberIdx];
    }
    return filtered;
  });
  return {
    ...cfg,
    realEstate: { kind: "split", grid: cfg.realEstate.grid, slots },
  };
}

/// Remove a member from every split-grid cell. Used by the
/// member-row "drag-me" affordance + by `resizeTeamMembers` to clean
/// up after a shrink removed the member entirely.
export function unassignMember(
  cfg: TeamDialogConfig,
  memberIdx: number,
): TeamDialogConfig {
  if (cfg.realEstate.kind !== "split") return cfg;
  const slots = cfg.realEstate.slots.map((cell) =>
    cell.filter((m) => m !== memberIdx),
  );
  return {
    ...cfg,
    realEstate: { kind: "split", grid: cfg.realEstate.grid, slots },
  };
}

/// Resize `cfg.members` to match `cfg.size`. Truncates from the end
/// when shrinking; appends fresh `WorkerN` entries when growing.
/// Preserves the lead designation across the resize.
export function resizeTeamMembers(cfg: TeamDialogConfig): TeamDialogConfig {
  let out = { ...cfg, members: [...cfg.members] };
  while (out.members.length < out.size) {
    const n = out.members.length;
    out.members.push({
      name: `Worker${n}`,
      command: "claude",
      env: "",
      isLead: false,
    });
  }
  while (out.members.length > out.size) {
    out.members.pop();
  }
  // Ensure exactly one lead survives the resize (the original lead
  // may have been popped). Default the lead to slot 0 when the
  // resize drops the prior lead.
  if (!out.members.some((m) => m.isLead) && out.members.length > 0) {
    out.members[0] = { ...out.members[0], isLead: true };
  }
  // When `realEstate.kind === "split"`, re-pick the default grid for
  // the new size + migrate slot assignments that still reference
  // valid members; drop assignments for members beyond the new
  // count. Keep the split mode; the user explicitly picked it.
  if (out.realEstate.kind === "split") {
    const grid = defaultGridForSize(out.size);
    const memberCount = out.members.length;
    const slots = emptySlotsForGrid(grid);
    let cellCursor = 0;
    for (const cell of out.realEstate.slots) {
      for (const memberIdx of cell) {
        if (memberIdx >= memberCount) continue;
        if (cellCursor >= slots.length) break;
        slots[cellCursor].push(memberIdx);
      }
      cellCursor = Math.min(cellCursor + 1, slots.length - 1);
    }
    out = { ...out, realEstate: { kind: "split", grid, slots } };
  }
  return out;
}
