<script lang="ts">
  // Per-workspace excluded-directory blocklist for the "This workspace"
  // settings tab. Names of directories to skip when indexing + building the
  // graph; the walk skips union(defaults, additions). `defaults` is the
  // machine-wide baseline (read-only); this edits only the per-workspace
  // additions. GET-then-PUT-the-whole-set with a debounced save.

  import { onDestroy, onMount } from "svelte";
  import { api } from "../../../api/client";
  import { tree } from "../../../state/store.svelte";
  import type { ExcludedDirsView } from "../../../api/types";
  import SettingField from "../SettingField.svelte";
  import ChipList from "../ChipList.svelte";

  type SaveStatus = "idle" | "saving" | "saved" | { error: string };

  let view = $state<ExcludedDirsView | null>(null);
  let additions = $state<string[]>([]);
  let draft = $state("");
  let loadError = $state<string | null>(null);
  let saveStatus = $state<SaveStatus>("idle");
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(async () => {
    try {
      const v = await api.excludedDirs();
      view = v;
      additions = [...v.workspace];
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  // Unlike the per-machine debounces (which deliberately outlive their
  // section), a pending whole-set PUT is cancelled when the tab unmounts;
  // the next mount re-reads the server state anyway.
  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });

  function basename(p: string): string {
    const parts = p.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  // Directory basenames from the loaded tree, minus what's already excluded,
  // for the add-input's autocomplete. Only currently-loaded dirs show up; the
  // field still accepts any typed name (the blocklist matches at any depth).
  const suggestions = $derived.by(() => {
    const have = new Set([...additions, ...(view?.defaults ?? [])]);
    const names = new Set<string>();
    for (const e of tree.entries) {
      if (!e.is_dir) continue;
      const b = basename(e.path).trim().toLowerCase();
      if (b && !have.has(b)) names.add(b);
    }
    return [...names].sort();
  });

  // Mirror the server's normalize(): trim, lower-case (matching is
  // case-insensitive), reject path separators (a name, not a path).
  function normalizeName(raw: string): string | null {
    const name = raw.trim();
    if (!name) return null;
    if (name.includes("/") || name.includes("\\")) return null;
    return name.toLowerCase();
  }

  function addDraft(): void {
    const name = normalizeName(draft);
    if (!name) return;
    draft = "";
    if (additions.includes(name) || (view?.defaults ?? []).includes(name)) return;
    additions = [...additions, name].sort();
    scheduleSave();
  }

  function remove(name: string): void {
    additions = additions.filter((d) => d !== name);
    scheduleSave();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      addDraft();
    }
  }

  // Debounce so rapid add/remove edits collapse into one PUT (and one re-walk)
  // rather than firing per keystroke.
  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  async function save(): Promise<void> {
    saveTimer = null;
    saveStatus = "saving";
    try {
      const v = await api.setExcludedDirs(additions);
      view = v;
      additions = [...v.workspace];
      saveStatus = "saved";
    } catch (e) {
      saveStatus = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const saveLabel = $derived(
    saveStatus === "saving"
      ? "Saving..."
      : saveStatus === "saved"
        ? "Saved"
        : typeof saveStatus === "object"
          ? `Save failed: ${saveStatus.error}`
          : "",
  );
</script>

<SettingField
  label="Excluded directories"
  hint="Directory names to skip when indexing and building the graph. Matched by exact name at any depth, case-insensitive. Names only, not paths."
>
  <div class="stack">
    {#if loadError}
      <p class="hint err" role="alert">Couldn't load the blocklist: {loadError}</p>
    {:else}
      <div class="add-row">
        <input
          type="text"
          placeholder="Add a directory name..."
          list="settings-excluded-dir-suggestions"
          bind:value={draft}
          onkeydown={onKeydown}
          aria-label="Add an excluded directory name"
        />
        <datalist id="settings-excluded-dir-suggestions">
          {#each suggestions as s (s)}
            <option value={s}></option>
          {/each}
        </datalist>
        <button type="button" class="add-btn" onclick={addDraft} disabled={!draft.trim()}>
          Add
        </button>
        {#if saveLabel}
          <span class="save-status" class:err={typeof saveStatus === "object"}>
            {saveLabel}
          </span>
        {/if}
      </div>

      {#if additions.length === 0}
        <p class="hint muted">No extra directories excluded for this workspace.</p>
      {:else}
        <ChipList
          names={additions}
          ariaLabel="Excluded directories for this workspace"
          onremove={remove}
        />
      {/if}

      {#if view && view.defaults.length}
        <details class="defaults">
          <summary>Always excluded ({view.defaults.length})</summary>
          <p class="hint muted">
            These come from the machine-wide baseline and apply to every
            workspace. They can't be edited here.
          </p>
          <ChipList names={view.defaults} readonly />
        </details>
      {/if}
    {/if}
  </div>
</SettingField>

<style>
  .add-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    width: 100%;
  }
  .add-row input {
    flex: 1;
    min-width: 0;
  }
  .add-btn {
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 5px 12px;
    font: inherit;
    cursor: pointer;
  }
  .add-btn:hover:not(:disabled) {
    border-color: var(--btn-hover);
  }
  .add-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .save-status {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .save-status.err {
    color: var(--warn-text);
  }
  .defaults {
    margin-top: 4px;
  }
  .defaults summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .defaults p {
    margin: 6px 0;
  }
</style>
