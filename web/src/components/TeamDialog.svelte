<script lang="ts">
  import { Bot, X } from "lucide-svelte";
  import { onMount } from "svelte";
  import { api } from "../api/client";
  import { closeTab } from "../state/tabs.svelte";
  import { teamConfigDir } from "../state/teamConfigPath";
  import {
    assignMemberToCell,
    closeTeamDialog,
    defaultTeamConfig,
    gridShapesForSize,
    reshapeSplitGrid,
    resizeTeamMembers,
    switchRealEstate,
    TEAM_MAX_SIZE,
    TEAM_MIN_SIZE,
    type GridShape,
    type TeamConfigMode,
    type TeamDialogConfig,
    type TeamDialogRequest,
    type TeamMemberDraft,
    unassignMember,
    validateTeamConfig,
  } from "../state/teamDialog.svelte";
  import { runTeamBootstrap, wireToDialog } from "../state/teamOrchestrator.svelte";

  /// Team Work dialog. Opens over the already-created Team Work Lead
  /// terminal (the dialog request
  /// carries that tab + pane id). Cancel deletes the lead tab;
  /// Bootstrap runs the lead-first orchestrator against it.

  let {
    request,
  }: {
    request: TeamDialogRequest;
  } = $props();

  // The dialog is unmounted + remounted across requests so this
  // single-shot capture is intended.
  // svelte-ignore state_referenced_locally
  let config: TeamDialogConfig = $state(defaultTeamConfig());
  let busy = $state(false);
  let submitError = $state<string | null>(null);
  // Load-mode path validation. `loadStatus` shows the resolved
  // config name on success; `loadError` carries the backend 400.
  let loadStatus = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let nameInputEl = $state<HTMLInputElement | undefined>();

  onMount(() => {
    queueMicrotask(() => nameInputEl?.focus());
  });

  const issue = $derived<string | null>(validateTeamConfig(config));

  // Info line for New mode: the dir the team management files land
  // in, derived from the config path.
  const configDir = $derived(teamConfigDir(config.configPath));

  function setMemberField<K extends keyof TeamMemberDraft>(
    idx: number,
    field: K,
    value: TeamMemberDraft[K],
  ): void {
    config = {
      ...config,
      members: config.members.map((m, i) =>
        i === idx ? { ...m, [field]: value } : m,
      ),
    };
  }

  function setLead(idx: number): void {
    config = {
      ...config,
      members: config.members.map((m, i) => ({ ...m, isLead: i === idx })),
    };
  }

  function onSizeChange(next: number): void {
    const clamped = Math.max(TEAM_MIN_SIZE, Math.min(TEAM_MAX_SIZE, next));
    config = resizeTeamMembers({ ...config, size: clamped });
  }

  function setConfigMode(mode: TeamConfigMode): void {
    if (config.configMode === mode) return;
    config = { ...config, configMode: mode };
    loadStatus = null;
    loadError = null;
  }

  /// Load mode: on path entry, read + validate the chan-team.toml
  /// via the backend. On success, prepopulate the form from the
  /// loaded config (the user is now in a pre-populated New form,
  /// still editable). On failure, surface the 400 message inline.
  async function validateAndLoad(): Promise<void> {
    loadStatus = null;
    loadError = null;
    const path = config.configPath.trim();
    if (!path) {
      loadError = "Path to configuration required";
      return;
    }
    busy = true;
    try {
      const wire = await api.readTeamConfigFile(path);
      const loaded = wireToDialog(wire, path);
      config = resizeTeamMembers(loaded);
      loadStatus = `Loaded "${wire.team_name}"`;
    } catch (err) {
      loadError = (err as Error).message ?? String(err);
    } finally {
      busy = false;
    }
  }

  // ---- split-pane airplane grid (drag&drop) ----------------------
  let draggingMember = $state<number | null>(null);

  function onMemberDragStart(idx: number, e: DragEvent): void {
    draggingMember = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `team-member-${idx}`);
    }
  }

  function onMemberDragEnd(): void {
    draggingMember = null;
  }

  function onCellDragOver(e: DragEvent): void {
    if (draggingMember === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function onCellDrop(cellIdx: number, e: DragEvent): void {
    e.preventDefault();
    if (draggingMember === null) return;
    config = assignMemberToCell(config, draggingMember, cellIdx);
    draggingMember = null;
  }

  function onUnassignClick(memberIdx: number): void {
    config = unassignMember(config, memberIdx);
  }

  function setRealEstate(kind: "tabs" | "split"): void {
    config = switchRealEstate(config, kind);
  }

  function onShapeClick(shape: GridShape): void {
    config = reshapeSplitGrid(config, shape);
  }

  function cellOfMember(memberIdx: number): number | null {
    if (config.realEstate.kind !== "split") return null;
    for (let i = 0; i < config.realEstate.slots.length; i += 1) {
      if (config.realEstate.slots[i].includes(memberIdx)) return i;
    }
    return null;
  }

  /// Render a member's handle as it'll appear in chan + the
  /// downstream agent's `CHAN_TAB_NAME`.
  function handleOf(member: TeamMemberDraft): string {
    return member.name;
  }

  async function onBootstrap(): Promise<void> {
    submitError = null;
    if (issue) {
      submitError = issue;
      return;
    }
    busy = true;
    try {
      await runTeamBootstrap(config, {
        leadTabId: request.leadTabId,
        leadPaneId: request.leadPaneId,
      });
      closeTeamDialog();
    } catch (err) {
      submitError = `bootstrap failed: ${(err as Error).message}`;
    } finally {
      busy = false;
    }
  }

  /// Cancel/dismiss: delete the exact Team Work Lead terminal tab
  /// that Cmd+P created, then dismiss the dialog (restoring the
  /// previous state).
  function onCancel(): void {
    void closeTab(request.leadPaneId, request.leadTabId, { force: true });
    closeTeamDialog();
  }

  function onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) onCancel();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      onCancel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="team-dialog-backdrop" onclick={onBackdropClick} role="presentation">
  <div
    class="team-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="team-dialog-title"
  >
    <header class="team-dialog-header">
      <h2 id="team-dialog-title">Spawn agents</h2>
      <button
        type="button"
        class="team-dialog-close"
        onclick={onCancel}
        aria-label="Close"
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </header>

    <div class="team-dialog-body">
      <label class="team-field">
        <span class="team-field-label">Your name</span>
        <input
          bind:this={nameInputEl}
          bind:value={config.hostName}
          type="text"
          placeholder="@@Neo"
          autocomplete="off"
        />
        <span class="team-field-hint">
          Renders as <code>{handleOf({ name: config.hostName || "(name)", command: "", env: "", isLead: false })}</code>
          when joining the team.
        </span>
      </label>

      <fieldset class="team-realestate">
        <legend>Team configuration</legend>
        <div
          class="team-realestate-toggle"
          role="radiogroup"
          aria-label="Team configuration source"
        >
          <button
            type="button"
            class="team-realestate-mode"
            class:on={config.configMode === "new"}
            onclick={() => setConfigMode("new")}
          >
            New
          </button>
          <button
            type="button"
            class="team-realestate-mode"
            class:on={config.configMode === "load"}
            onclick={() => setConfigMode("load")}
          >
            Load
          </button>
        </div>

        <label class="team-field">
          <span class="team-field-label">Path to configuration</span>
          <input
            bind:value={config.configPath}
            type="text"
            placeholder="/tmp/new-team-1/chan-team.toml"
            autocomplete="off"
            onchange={() => {
              if (config.configMode === "load") void validateAndLoad();
            }}
          />
          {#if config.configMode === "new"}
            <span class="team-field-hint">
              team management files will be created in <code>{configDir}</code>
            </span>
          {:else if loadError}
            <span class="team-field-hint team-load-error" role="alert">
              {loadError}
            </span>
          {:else if loadStatus}
            <span class="team-field-hint" role="status">{loadStatus}</span>
          {:else}
            <span class="team-field-hint">
              Enter a path to an existing <code>chan-team.toml</code> to load it.
            </span>
          {/if}
        </label>
      </fieldset>

      <label class="team-field">
        <span class="team-field-label">Number of agents</span>
        <select
          value={config.size}
          onchange={(e) =>
            onSizeChange(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          {#each Array.from({ length: TEAM_MAX_SIZE - TEAM_MIN_SIZE + 1 }, (_, i) => TEAM_MIN_SIZE + i) as n (n)}
            <option value={n}>{n}</option>
          {/each}
        </select>
      </label>

      <fieldset class="team-members">
        <legend>Members</legend>
        {#each config.members as member, idx (idx)}
          {@const assignedCell = cellOfMember(idx)}
          <div
            class="team-member-row"
            class:dragging={draggingMember === idx}
            draggable={config.realEstate.kind === "split"}
            ondragstart={(e) => onMemberDragStart(idx, e)}
            ondragend={onMemberDragEnd}
          >
            <span class="team-member-icon" aria-hidden="true">
              <Bot size={16} strokeWidth={1.75} />
            </span>
            <input
              class="team-member-name"
              bind:value={member.name}
              oninput={(e) =>
                setMemberField(idx, "name", (e.currentTarget as HTMLInputElement).value)}
              placeholder="Name"
              autocomplete="off"
            />
            <input
              class="team-member-command"
              bind:value={member.command}
              oninput={(e) =>
                setMemberField(idx, "command", (e.currentTarget as HTMLInputElement).value)}
              placeholder="claude --resume"
              autocomplete="off"
            />
            <input
              class="team-member-env"
              bind:value={member.env}
              oninput={(e) =>
                setMemberField(idx, "env", (e.currentTarget as HTMLInputElement).value)}
              placeholder="KEY=value"
              autocomplete="off"
            />
            <label class="team-member-lead">
              <input
                type="radio"
                name="team-lead"
                checked={member.isLead}
                onchange={() => setLead(idx)}
              />
              <span>Lead</span>
            </label>
            {#if config.realEstate.kind === "split"}
              {#if assignedCell !== null}
                <button
                  type="button"
                  class="team-member-cell-badge"
                  title="Unassign from cell"
                  onclick={() => onUnassignClick(idx)}
                >
                  cell {assignedCell + 1}
                </button>
              {:else}
                <span class="team-member-cell-badge unassigned">drag-me</span>
              {/if}
            {/if}
          </div>
        {/each}
      </fieldset>

      <fieldset class="team-realestate">
        <legend>Real estate</legend>
        <div class="team-realestate-toggle" role="radiogroup" aria-label="Real estate">
          <button
            type="button"
            class="team-realestate-mode"
            class:on={config.realEstate.kind === "tabs"}
            onclick={() => setRealEstate("tabs")}
          >
            Tabs in current Hybrid
          </button>
          <button
            type="button"
            class="team-realestate-mode"
            class:on={config.realEstate.kind === "split"}
            onclick={() => setRealEstate("split")}
          >
            Split panes
          </button>
        </div>

        {#if config.realEstate.kind === "split"}
          {@const shapes = gridShapesForSize(config.size)}
          <div class="team-realestate-shapes" role="radiogroup" aria-label="Grid shapes">
            {#each shapes as shape (`${shape.rows}x${shape.cols}`)}
              <button
                type="button"
                class="team-shape-pick"
                class:on={config.realEstate.kind === "split" &&
                  config.realEstate.grid.rows === shape.rows &&
                  config.realEstate.grid.cols === shape.cols}
                onclick={() => onShapeClick(shape)}
                title={`${shape.rows}x${shape.cols}`}
              >
                {shape.rows}x{shape.cols}
              </button>
            {/each}
          </div>

          <div
            class="team-airplane-grid"
            style:--grid-rows={config.realEstate.grid.rows}
            style:--grid-cols={config.realEstate.grid.cols}
          >
            {#each config.realEstate.slots as cell, cellIdx (cellIdx)}
              <div
                class="team-airplane-cell"
                class:occupied={cell.length > 0}
                ondragover={onCellDragOver}
                ondrop={(e) => onCellDrop(cellIdx, e)}
                role="region"
                aria-label={`Cell ${cellIdx + 1}`}
              >
                <span class="team-cell-index">{cellIdx + 1}</span>
                {#if cell.length === 0}
                  <span class="team-cell-empty">drop bot(s) here</span>
                {:else}
                  <ul class="team-cell-robots">
                    {#each cell as memberIdx (memberIdx)}
                      <li class="team-cell-robot">
                        {handleOf(config.members[memberIdx] ?? {
                          name: `M${memberIdx}`,
                          command: "",
                          env: "",
                          isLead: false,
                        })}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </div>

          <p class="team-airplane-hint">
            Drag a robot from the member rows above into a cell.
            Same-cell drop stacks robots as tabs in that pane.
          </p>
        {/if}
      </fieldset>

      {#if submitError}
        <p class="team-dialog-error" role="alert">{submitError}</p>
      {:else if issue}
        <p class="team-dialog-hint">{issue}</p>
      {/if}
    </div>

    <footer class="team-dialog-footer">
      <button type="button" class="team-dialog-cancel" onclick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button
        type="button"
        class="team-dialog-bootstrap"
        onclick={onBootstrap}
        disabled={busy || issue !== null}
      >
        Bootstrap
      </button>
    </footer>
  </div>
</div>

<style>
  .team-dialog-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 75%, transparent);
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .team-dialog {
    background: var(--bg-card);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    width: min(720px, 90vw);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .team-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .team-dialog-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .team-dialog-close {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 4px;
    display: inline-flex;
    align-items: center;
  }
  .team-dialog-body {
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .team-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .team-field-label {
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  .team-field input[type="text"],
  .team-field select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    color: var(--text);
    font: inherit;
  }
  .team-field-hint {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .team-load-error {
    color: var(--danger-text);
  }
  .team-members {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .team-members legend {
    padding: 0 6px;
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .team-member-row {
    display: grid;
    grid-template-columns: auto 1fr 1.5fr 1fr auto;
    gap: 6px;
    align-items: center;
  }
  .team-member-icon {
    color: var(--text-secondary);
    display: inline-flex;
  }
  .team-member-row :global(input[type="text"]) {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
    color: var(--text);
    font: inherit;
    min-width: 0;
  }
  .team-member-lead {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .team-member-row.dragging {
    opacity: 0.6;
  }
  .team-member-cell-badge {
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
  }
  .team-member-cell-badge.unassigned {
    cursor: default;
    opacity: 0.6;
  }
  .team-realestate {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .team-realestate legend {
    padding: 0 6px;
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .team-realestate-toggle {
    display: flex;
    gap: 6px;
  }
  .team-realestate-mode {
    flex: 1;
    padding: 6px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .team-realestate-mode.on {
    background: color-mix(in srgb, var(--accent) 20%, var(--bg));
    border-color: var(--accent);
  }
  .team-realestate-shapes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .team-shape-pick {
    padding: 4px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
  }
  .team-shape-pick.on {
    background: color-mix(in srgb, var(--accent) 20%, var(--bg));
    border-color: var(--accent);
  }
  .team-airplane-grid {
    display: grid;
    grid-template-rows: repeat(var(--grid-rows), 1fr);
    grid-template-columns: repeat(var(--grid-cols), 1fr);
    gap: 4px;
    min-height: 120px;
    padding: 6px;
    background: var(--bg);
    border-radius: 4px;
  }
  .team-airplane-cell {
    position: relative;
    border: 1px dashed var(--border);
    border-radius: 4px;
    padding: 16px 6px 6px;
    min-height: 60px;
    background: var(--bg-card);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .team-airplane-cell.occupied {
    border-style: solid;
    border-color: var(--accent);
  }
  .team-cell-index {
    position: absolute;
    top: 2px;
    left: 4px;
    font-size: 0.65rem;
    color: var(--text-secondary);
  }
  .team-cell-empty {
    align-self: center;
    margin: auto;
    font-size: 0.75rem;
    color: var(--text-secondary);
    opacity: 0.7;
  }
  .team-cell-robots {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .team-cell-robot {
    font-size: 0.75rem;
    padding: 2px 4px;
    background: var(--bg);
    border-radius: 3px;
    color: var(--text);
  }
  .team-airplane-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .team-dialog-error {
    margin: 0;
    color: var(--danger-text);
    font-size: 0.875rem;
  }
  .team-dialog-hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  .team-dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .team-dialog-footer button {
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  .team-dialog-cancel {
    background: var(--btn-bg);
    border: 1px solid var(--btn-border);
    color: var(--text);
  }
  .team-dialog-bootstrap {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--bg);
  }
  .team-dialog-bootstrap:disabled,
  .team-dialog-cancel:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
