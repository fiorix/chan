// Team Work bootstrap orchestrator.
//
// Lead-first flow: the Team Work Lead terminal ALREADY EXISTS when this
// runs (App.svelte created it at Cmd+P via `createTeamWorkLeadTerminal`,
// and the dialog handed us its tab + pane id). Bootstrap:
//
//   1. Save/update the chan-team.toml at the dialog's config path.
//   2. Launch the LEAD agent FIRST into the existing lead tab, then
//      the workers into new tabs (split-pane or tabs-in-Hybrid per
//      the dialog's real estate).
//   3. Each agent's identity is its `CHAN_TAB_NAME` env var.
//   4. Place the identity prompt into the LEAD's embedded editor.
//   5. Broadcast: deselect ALL terminals first, then enable ONLY the
//      lead + workers set.

import { api, type TeamConfigWire, type TeamMemberWire } from "../api/client";
import { notify } from "./notify.svelte";
import { teamConfigDir } from "./teamConfigPath";
import { isCanonicalAgentHandle } from "./teamDialog.svelte";
import {
  allTerminalTabs,
  buildSplitGrid,
  layout,
  openTerminalInPane,
  primeTeamWork,
  renameTerminalTab,
  setActivePane,
  setTerminalBroadcastEnabled,
  setTerminalBroadcastTarget,
  type TerminalTab,
} from "./tabs.svelte";
import type { TeamDialogConfig, TeamMemberDraft } from "./teamDialog.svelte";

/// Context the dialog hands the orchestrator: the EXISTING Team Work
/// Lead terminal tab + the pane it lives in. The lead is never
/// respawned; the orchestrator launches the lead agent INTO this
/// tab.
export interface TeamBootstrapContext {
  leadTabId: string;
  leadPaneId: string;
}

/// Parse the dialog's free-form env field ("KEY=VALUE"
/// newline-separated) into a Record. Empty lines + surrounding
/// whitespace stripped. Invalid lines throw so the orchestrator can
/// bail with a message.
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!text) return env;
  for (const [idx, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`env line ${idx + 1} must be KEY=value`);
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`env line ${idx + 1} has an invalid key`);
    }
    env[key] = line.slice(eq + 1);
  }
  return env;
}

/// Compute the handle the way the dialog's `handleOf` helper does:
/// the legacy autoPrefix flag no longer repairs non-canonical names.
export function memberHandle(member: TeamMemberDraft, autoPrefix: boolean): string {
  void autoPrefix;
  return member.name;
}

export function isValidTeamName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/// Translate the SPA's camelCase `TeamDialogConfig` into the
/// snake_case `TeamConfigWire` shape persisted to chan-team.toml.
/// `created_at` is the call time (ISO 8601 UTC). Each member's env
/// is parsed into a Record; `CHAN_TAB_NAME=<handle>` is auto-injected
/// unless the user supplied an override (the per-tab env var IS the
/// agent's identity inside the PTY).
///
/// Real estate round-trips through the per-member `position`
/// (row/col) field that chan-team.toml already carries: a member in
/// split-cell `i` of an RxC grid gets `position = {row, col}`;
/// tabs-mode members get no position. `wireToDialog` reconstructs the
/// dialog's `realEstate` from these positions, so Load restores the
/// same layout the user saw on save.
export function translateConfig(config: TeamDialogConfig): TeamConfigWire {
  const teamName = teamNameFromPath(config.configPath);
  const hostHandle = memberHandle(
    { name: config.hostName, command: "", env: "", isLead: false },
    config.autoPrefix,
  );
  if (!isValidTeamName(teamName)) {
    throw new Error("team_name must match [A-Za-z0-9_-]+");
  }
  if (!isCanonicalAgentHandle(hostHandle)) {
    throw new Error("host handle must be canonical @@Name");
  }
  const positions = memberPositions(config);
  const members: TeamMemberWire[] = config.members.map((m, idx) => {
    const env = parseEnvLines(m.env);
    const handle = memberHandle(m, config.autoPrefix);
    if (!isCanonicalAgentHandle(handle)) {
      throw new Error("member handles must be canonical @@Name");
    }
    env.CHAN_TEAM_NAME = teamName;
    env.CHAN_TAB_NAME = handle;
    const member: TeamMemberWire = {
      handle,
      command: m.command,
      env,
      is_lead: m.isLead,
    };
    const pos = positions[idx];
    if (pos) member.position = pos;
    return member;
  });
  return {
    team_name: teamName,
    host_name: config.hostName,
    host_handle: hostHandle,
    auto_prefix_at: false,
    created_at: new Date().toISOString(),
    members,
  };
}

/// Map each member index to its split-grid `{row, col}` position.
/// Returns an array aligned with `config.members`; entries are
/// undefined in tabs mode (no position persisted).
function memberPositions(
  config: TeamDialogConfig,
): (TeamMemberWire["position"] | undefined)[] {
  const out: (TeamMemberWire["position"] | undefined)[] = config.members.map(
    () => undefined,
  );
  if (config.realEstate.kind !== "split") return out;
  const { grid, slots } = config.realEstate;
  for (let cellIdx = 0; cellIdx < slots.length; cellIdx += 1) {
    const row = Math.floor(cellIdx / grid.cols);
    const col = cellIdx % grid.cols;
    for (const memberIdx of slots[cellIdx] ?? []) {
      if (memberIdx >= 0 && memberIdx < out.length) {
        out[memberIdx] = { row, col };
      }
    }
  }
  return out;
}

/// chan-team.toml carries `team_name`; derive a stable name from the
/// config's directory (e.g. `/tmp/new-team-1/chan-team.toml` ->
/// `new-team-1`). Keeps the persisted config self-describing without
/// re-adding a "Team name" field to the dialog.
export function teamNameFromPath(path: string): string {
  const dir = teamConfigDir(path);
  const lastSlash = dir.lastIndexOf("/");
  const base = lastSlash >= 0 ? dir.slice(lastSlash + 1) : dir;
  const candidate = base.trim();
  return isValidTeamName(candidate) ? candidate : "team";
}

/// Inverse of `translateConfig`: map the snake_case wire shape back
/// into the dialog's camelCase `TeamDialogConfig` so the Load flow
/// opens the dialog populated from chan-team.toml. The user edits,
/// hits Bootstrap, and the config is re-saved with their changes.
///
/// `env` Records serialise back to "KEY=VALUE\n" lines;
/// `CHAN_TAB_NAME` is dropped from the visible env field
/// (`translateConfig` re-injects it on save, so showing it would
/// create a duplicate on round-trip). Real estate is reconstructed
/// from member positions.
export function wireToDialog(
  wire: TeamConfigWire,
  configPath: string,
): TeamDialogConfig {
  if (!isValidTeamName(wire.team_name)) {
    throw new Error("team_name must match [A-Za-z0-9_-]+");
  }
  if (!isCanonicalAgentHandle(wire.host_handle)) {
    throw new Error("host_handle must be canonical @@Name");
  }
  const members: TeamMemberDraft[] = wire.members.map((m) => {
    if (!isCanonicalAgentHandle(m.handle)) {
      throw new Error("member handles must be canonical @@Name");
    }
    const envText = Object.entries(m.env)
      .filter(([k]) => k !== "CHAN_TEAM_NAME" && k !== "CHAN_TAB_NAME")
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    return {
      name: m.handle,
      command: m.command,
      env: envText,
      isLead: m.is_lead,
    };
  });
  const size = Math.max(members.length, 1);
  return {
    hostName: wire.host_handle,
    configMode: "load",
    configPath,
    size,
    autoPrefix: false,
    members,
    realEstate: realEstateFromWire(wire, size),
  };
}

/// Rebuild the dialog's `realEstate` from member positions. When no
/// member carries a position, the team is tabs-in-current-Hybrid.
/// Otherwise derive the grid from the max row/col seen + map each
/// positioned member into its row-major cell.
function realEstateFromWire(
  wire: TeamConfigWire,
  size: number,
): TeamDialogConfig["realEstate"] {
  const positioned = wire.members
    .map((m, idx) => ({ pos: m.position, idx }))
    .filter((e): e is { pos: NonNullable<TeamMemberWire["position"]>; idx: number } =>
      Boolean(e.pos),
    );
  if (positioned.length === 0) return { kind: "tabs" };
  let maxRow = 0;
  let maxCol = 0;
  for (const { pos } of positioned) {
    maxRow = Math.max(maxRow, pos.row);
    maxCol = Math.max(maxCol, pos.col);
  }
  const grid = { rows: maxRow + 1, cols: maxCol + 1 };
  const slots: number[][] = Array.from(
    { length: grid.rows * grid.cols },
    () => [],
  );
  for (const { pos, idx } of positioned) {
    if (idx >= size) continue;
    const cellIdx = pos.row * grid.cols + pos.col;
    if (cellIdx >= 0 && cellIdx < slots.length) slots[cellIdx].push(idx);
  }
  return { kind: "split", grid, slots };
}

/// Build the `# Team work` identity prompt placed in the lead's
/// embedded editor. `$CHAN_TAB_NAME` is intentionally NOT escaped:
/// the lead's shell expands it to the env-var value when the agent
/// reads the prompt. The team size, host handle, lead handle, and
/// worker handles substitute in literally.
export function identityPrompt(
  size: number,
  hostHandle: string,
  leadHandle: string,
  workerHandles: string[],
): string {
  const uniqueWorkers = [...new Set(workerHandles)];
  const bullets =
    uniqueWorkers.length > 0
      ? uniqueWorkers.map((h) => `- ${h}`).join("\n")
      : "- (no other agents)";
  return (
    `# Team work\n` +
    `We are a team of ${size}. Our host is ${hostHandle} and the team lead ` +
    `is ${leadHandle}.\n` +
    `You are $CHAN_TAB_NAME. Identify yourself and call list_agent_tasks ` +
    `once on startup to catch retained work. Store latest_id as your next ` +
    `cursor if your host supports persistent memory.\n\n` +
    `Before handing work to another agent, create or update a workspace task ` +
    `file, then call send_agent_task(to, context_path). The inbox stores only ` +
    `the context_path; receivers read that file with workspace MCP tools.\n\n` +
    `If the terminal receives a standalone line "poke", call list_agent_tasks ` +
    `over MCP and read each returned context_path.\n\n` +
    `Teammates:\n` +
    bullets
  );
}

/// Locate a terminal tab by id within a specific pane. Used to pin
/// the existing Team Work Lead tab the dialog handed us.
function leadTabIn(paneId: string, tabId: string): TerminalTab | null {
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return null;
  const tab = node.tabs.find((t) => t.id === tabId);
  return tab && tab.kind === "terminal" ? tab : null;
}

/// Launch the lead agent INTO the existing lead tab. The tab already
/// holds a shell PTY from Cmd+P; restart it with the lead's command +
/// env so the agent runs in place. When the PTY hasn't attached yet
/// (no session id), best-effort renames the tab so its
/// `CHAN_TAB_NAME` is correct when the WS handshake eventually
/// spawns the shell, the orchestrator's restart is skipped and the
/// user re-runs the command if needed.
async function launchLead(
  leadTab: TerminalTab,
  lead: TeamMemberWire,
): Promise<void> {
  renameTerminalTab(leadTab, lead.handle);
  if (!leadTab.terminalSessionId) {
    // No PTY yet: the rename is enough; the agent command can't be
    // injected without a session. This is an edge case (the user
    // would have to Bootstrap faster than the WS handshake).
    return;
  }
  await api.restartTerminal(leadTab.terminalSessionId, {
    name: lead.handle,
    command: lead.command,
    env: lead.env,
  });
}

/// Resolve the target pane for each worker (by member index) +
/// confirm the lead's pane. Tabs mode: every worker shares the lead's
/// pane (stacked as tabs). Split mode: build the RxC grid rooted at
/// the lead's pane (cell 0 = lead) and map each worker to its
/// assigned cell; unassigned workers fall back to the lead's pane.
function resolveWorkerPanes(
  config: TeamDialogConfig,
  leadPaneId: string,
): (string | undefined)[] {
  if (config.realEstate.kind === "tabs") {
    return config.members.map(() => leadPaneId);
  }
  const { grid, slots } = config.realEstate;
  const cells = buildSplitGrid(leadPaneId, grid.rows, grid.cols);
  const fallback = cells[0] ?? leadPaneId;
  const panes: (string | undefined)[] = config.members.map(() => undefined);
  for (let cellIdx = 0; cellIdx < slots.length; cellIdx += 1) {
    for (const memberIdx of slots[cellIdx] ?? []) {
      if (memberIdx < 0 || memberIdx >= panes.length) continue;
      panes[memberIdx] = cells[cellIdx] ?? fallback;
    }
  }
  for (let i = 0; i < panes.length; i += 1) {
    if (!panes[i]) panes[i] = fallback;
  }
  return panes;
}

/// Run the lead-first bootstrap chain. Throws on a step's failure so
/// the dialog can surface the error inline; the caller closes the
/// dialog on success.
export async function runTeamBootstrap(
  config: TeamDialogConfig,
  ctx: TeamBootstrapContext,
): Promise<void> {
  const wire = translateConfig(config);

  const leadEntries = wire.members.filter((m) => m.is_lead);
  if (leadEntries.length !== 1) throw new Error("config must have exactly one lead member");

  // 1. Save/update the chan-team.toml at the user's config path.
  //    This is app-level orchestration config written outside the
  //    workspace sandbox (see api.writeTeamConfigFile).
  await api.writeTeamConfigFile(config.configPath, wire);

  const leadEntry = leadEntries[0];
  const workerEntries = wire.members.filter((m) => !m.is_lead);

  // 2a. Launch the LEAD FIRST into the existing lead tab.
  const leadTab = leadTabIn(ctx.leadPaneId, ctx.leadTabId);
  if (!leadTab) throw new Error("lead terminal not found");
  await launchLead(leadTab, leadEntry);

  // 2b. Resolve real estate + spawn the workers into new tabs.
  const workerPanes = resolveWorkerPanes(config, ctx.leadPaneId);
  const workerTabs: TerminalTab[] = [];
  for (let i = 0; i < config.members.length; i += 1) {
    const m = wire.members[i];
    if (m.is_lead) continue;
    try {
      const response = await api.spawnTerminal({
        name: m.handle,
        command: m.command,
        env: m.env,
      });
      const paneId = workerPanes[i] ?? ctx.leadPaneId;
      const tab = openTerminalInPane(paneId, {
        sessionId: response.session,
        title: response.tab_label,
      });
      if (tab) {
        renameTerminalTab(tab, m.handle);
        workerTabs.push(tab);
      }
    } catch (err) {
      notify(`spawn failed for ${m.handle}: ${(err as Error).message ?? err}`);
    }
  }

  // 3 + 4. Place the identity prompt in the lead's embedded editor.
  //    `$CHAN_TAB_NAME` is each agent's identity (env var, step 3).
  const prompt = identityPrompt(
    wire.members.length,
    wire.host_handle,
    leadEntry.handle,
    workerEntries.map((m) => m.handle),
  );
  primeTeamWork(leadTab, prompt);

  // Restore focus to the lead's pane so the editor lands there.
  setActivePane(ctx.leadPaneId);

  // 5. Broadcast membership. First force-clear EVERY terminal's
  //    broadcast (the spec's "Deselect all" equivalent) so no
  //    pre-existing broadcast group leaks into the new team. Then
  //    enable ONLY the lead + workers set. We use the
  //    setTerminalBroadcast* primitives (force-clear+set), not the
  //    toggle helper, so the final membership is deterministic.
  for (const tab of allTerminalTabs()) {
    setTerminalBroadcastEnabled(tab, false);
  }
  setTerminalBroadcastEnabled(leadTab, true);
  for (const tab of workerTabs) {
    setTerminalBroadcastTarget(leadTab, tab.id, true);
  }

  notify(`Team "${wire.team_name}" bootstrapped.`);
}
