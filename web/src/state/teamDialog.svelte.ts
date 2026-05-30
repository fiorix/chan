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

import { TEAM_CONFIG_DEFAULT_PATH } from "./teamConfigPath";

/// One agent in the team being bootstrapped. Position in
/// `TeamDialogConfig.members` is stable (positional id used by the
/// airplane-grid for drag&drop slot assignment).
export interface TeamMemberDraft {
  /// Canonical Team Work handle, e.g. `@@FullStackA`.
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
/// path; `load` reads an existing chan-team.toml back to prepopulate
/// the form (after which the user is editing a pre-populated New
/// form).
export type TeamConfigMode = "new" | "load";

export interface TeamDialogConfig {
  hostName: string;
  /// Team configuration source mode: "new" or "load". Controls whether
  /// the dialog writes or reads chan-team.toml.
  configMode: TeamConfigMode;
  /// Absolute path to the chan-team.toml. New: where it will be
  /// written. Load: where it is read from. Defaults to
  /// `/tmp/new-team-1/chan-team.toml`.
  configPath: string;
  /// Total agents (lead + workers). 1-9.
  size: number;
  /// Legacy field retained for wire compatibility. New saves keep it false.
  autoPrefix: boolean;
  /// Length must equal `size`. Exactly one member has `isLead: true`.
  members: TeamMemberDraft[];
  realEstate: TeamRealEstate;
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

/// Default team config used as the dialog's initial state. One lead
/// member, auto-prefix on, New mode, real estate defaults to tabs.
export function defaultTeamConfig(): TeamDialogConfig {
  return {
    hostName: "@@Neo",
    configMode: "new",
    configPath: TEAM_CONFIG_DEFAULT_PATH,
    size: TEAM_MIN_SIZE,
    autoPrefix: false,
    members: [{ name: "@@Lead", command: "claude", env: "", isLead: true }],
    realEstate: { kind: "tabs" },
  };
}

export function isCanonicalAgentHandle(value: string): boolean {
  return /^@@[A-Za-z0-9_-]+$/.test(value);
}

/// Returns the first validation issue with the supplied config, or
/// null when valid. Used by the dialog to enable/disable the
/// Bootstrap button + surface inline errors.
export function validateTeamConfig(cfg: TeamDialogConfig): string | null {
  // Copy uses the dialog-visible labels so the user knows which
  // input to fix.
  if (!cfg.hostName.trim()) return "Your name required";
  if (!isCanonicalAgentHandle(cfg.hostName.trim())) {
    return "Your handle must be canonical @@Name";
  }
  if (!cfg.configPath.trim()) return "Path to configuration required";
  if (!cfg.configPath.trim().startsWith("/")) {
    return "Path to configuration must be absolute";
  }
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
  if (cfg.members.some((m) => !isCanonicalAgentHandle(m.name.trim()))) {
    return "member handles must be canonical @@Name";
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
/// when shrinking; appends fresh `@@WorkerN` entries when growing.
/// Preserves the lead designation across the resize.
export function resizeTeamMembers(cfg: TeamDialogConfig): TeamDialogConfig {
  let out = { ...cfg, members: [...cfg.members] };
  while (out.members.length < out.size) {
    const n = out.members.length;
    out.members.push({
      name: `@@Worker${n}`,
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
