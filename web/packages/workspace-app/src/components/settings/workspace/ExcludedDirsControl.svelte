<script module lang="ts">
  // The last save asked for in each workspace, by any mount of the control.
  // A save goes out once every save asked for before it has been answered, so
  // one save is on the wire at a time and the server stores the sets as they
  // were asked for: a save a control owes when it unmounts is stored before
  // any save of the control mounted after it.
  const lastSave = new Map<string, Promise<void>>();

  function afterEarlierSaves(workspaceKey: string, send: () => Promise<void>, failed: () => void): void {
    lastSave.set(workspaceKey, (lastSave.get(workspaceKey) ?? Promise.resolve()).then(send).catch(failed));
  }

  // Settles once every save asked for in the workspace has been answered,
  // those asked for while it waits included.
  async function savesAnswered(workspaceKey: string): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== lastSave.get(workspaceKey)) {
      seen = lastSave.get(workspaceKey);
      await seen;
    }
  }
</script>

<script lang="ts">
  // Per-workspace excluded-directory blocklist for the "This workspace"
  // settings tab. Names of directories to skip when indexing + building the
  // graph; the walk skips union(defaults, additions). `defaults` is the
  // machine-wide baseline (read-only); this edits only the per-workspace
  // additions. GET-then-PUT-the-whole-set with a debounced save.

  import { onDestroy, onMount } from "svelte";
  import { api } from "../../../api/client";
  import { ApiError } from "../../../api/errors";
  import { tree, workspace } from "../../../state/store.svelte";
  import type { ExcludedDirsView } from "../../../api/types";
  import SettingField from "../SettingField.svelte";
  import ChipList from "../ChipList.svelte";
  import type { SaveStatus } from "../commit";

  let view = $state<ExcludedDirsView | null>(null);
  let additions = $state<string[]>([]);
  let draft = $state("");
  let loadError = $state<string | null>(null);
  let saveStatus = $state<SaveStatus>("idle");
  // The server's sentence for the set it last refused, until the list changes.
  let refused = $state<string | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Counts edits, so the answer to a save sent before a later edit does not
  // replace the list the user has changed since; that edit's own save follows.
  // Such an answer is still the server's set.
  let edits = 0;
  // The workspace this mount edits: its saves join that workspace's line, and
  // its first read waits for the line to empty.
  const workspaceKey = workspace.info?.metadata_key ?? workspace.info?.root ?? "";
  // A save of this mount is waiting for its turn. It sends the list as it
  // stands when the turn comes, so one turn serves every save asked for
  // before it.
  let queued = false;
  // A save has failed, otherwise than by a refusal, since the server last
  // answered with its set. Shown or not, such a failure does not say whether
  // the set landed, so `view` is in doubt until the server answers again. A
  // refusal says it did not: the server refuses a set before it stores it.
  let inDoubt = false;

  onMount(async () => {
    try {
      // A save a gone mount owes is stored after a read made before its
      // answer, and the list would then show a set the server has replaced.
      await savesAnswered(workspaceKey);
      const v = await api.excludedDirs();
      answered(v);
      additions = [...v.workspace];
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  // Unlike the per-machine debounces (which deliberately outlive their
  // section), the pause before a whole-set PUT is cancelled when the tab
  // unmounts. With no save waiting, the edits made inside it are not sent. A
  // save that waits for an answer is owed: its pause ended, so it goes out
  // when the answer lands, though the control is gone, and it carries the
  // list as it stood at the unmount, those edits included. The next mount
  // reads the server's set once that save is answered.
  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  });

  function basename(p: string): string {
    const parts = p.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  // Directory basenames from the loaded tree, minus what's already excluded,
  // for the add-input's autocomplete. Only currently-loaded dirs show up; the
  // field still accepts any typed name the list takes (the blocklist matches
  // at any depth).
  const suggestions = $derived.by(() => {
    const have = new Set([...additions, ...(view?.defaults ?? [])]);
    const names = new Set<string>();
    for (const e of tree.entries) {
      if (!e.is_dir) continue;
      const b = normalizeName(basename(e.path));
      if (b && !have.has(b)) names.add(b);
    }
    return [...names].sort();
  });

  // Mirror the server's normalize(): trim, lower-case the ASCII letters
  // (the server matches a name ignoring ASCII case and no other, so a letter
  // folded beyond that names a directory nobody has), reject a `/` (a name,
  // not a path). A `\` is part of a name wherever a directory can have one,
  // so the server decides it: it takes the name when a directory of the
  // workspace has it.
  function normalizeName(raw: string): string | null {
    const name = raw.trim();
    if (!name) return null;
    if (name.includes("/")) return null;
    return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  }

  // Why the name in the field is refused, for as long as it stands there.
  const refusal = $derived(
    draft.trim() !== "" && normalizeName(draft) === null
      ? "A name cannot hold /: the list takes directory names, not paths."
      : null,
  );

  function addDraft(): void {
    // The list is the server's set with the user's edits over it, so nothing
    // joins it before that set has been read: a save of a name added then
    // would store the name alone.
    if (view === null) return;
    const name = normalizeName(draft);
    if (!name) return;
    draft = "";
    if (additions.includes(name) || (view?.defaults ?? []).includes(name)) return;
    additions = [...additions, name].sort();
    refused = null;
    scheduleSave();
  }

  function remove(name: string): void {
    additions = additions.filter((d) => d !== name);
    refused = null;
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
    edits += 1;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  // Of what the control lets through, the server refuses only a name that
  // holds a `\` and that its last answer does not hold. So these are the names
  // a refused set can have been refused for, found without reading the
  // server's sentence.
  function refusable(names: string[]): string[] {
    const taken = view?.workspace ?? [];
    return names.filter((name) => name.includes("\\") && !taken.includes(name));
  }

  // An answer that carries the server's set is that set as far as the page
  // can know, whether or not an edit overtook the request.
  function answered(v: ExcludedDirsView): void {
    view = v;
    inDoubt = false;
  }

  function save(): void {
    saveTimer = null;
    saveStatus = "saving";
    if (queued) return;
    queued = true;
    afterEarlierSaves(workspaceKey, async () => {
      queued = false;
      // A pause still running sends the list at its own end.
      if (saveTimer) return;
      await send();
    }, () => {
      inDoubt = true;
      saveStatus = { error: "The save failed" };
    });
  }

  async function send(): Promise<void> {
    const sentAfter = edits;
    const sent = additions;
    try {
      const v = await api.setExcludedDirs(sent);
      answered(v);
      if (edits === sentAfter) {
        additions = [...v.workspace];
        saveStatus = "saved";
      }
    } catch (e) {
      const overtaken = edits !== sentAfter;
      const rejection = e instanceof ApiError && e.status === 400 ? e : null;
      const names = overtaken ? [] : refusable(sent);
      if (rejection && names.length > 0) {
        takeBack(names, rejection.message);
      } else {
        if (!rejection) inDoubt = true;
        if (!overtaken) saveStatus = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  // A refused set left as it is would be refused again at every later save,
  // so the names it can have been refused for leave the list. The server's
  // sentence says which one it refused; with one such name the page knows it
  // too and hands it back to a field its user is not typing in. The rest of
  // the set is saved when it differs from the server's set or that set is in
  // doubt, and not otherwise, since a save rebuilds the index. That set holds
  // nothing the server can refuse, so the save is the only one, and its
  // failure reads as any failed save.
  function takeBack(names: string[], sentence: string): void {
    additions = additions.filter((name) => !names.includes(name));
    refused = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    if (names.length === 1 && draft.trim() === "") draft = names[0];
    const taken = view?.workspace ?? [];
    const differs = additions.length !== taken.length || additions.some((name) => !taken.includes(name));
    if (differs || inDoubt) save();
    else saveStatus = "idle";
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
          disabled={view === null}
          aria-label="Add an excluded directory name"
        />
        <datalist id="settings-excluded-dir-suggestions">
          {#each suggestions as s (s)}
            <option value={s}></option>
          {/each}
        </datalist>
        <button
          type="button"
          class="add-btn"
          onclick={addDraft}
          disabled={view === null || !draft.trim() || refusal !== null}
        >
          Add
        </button>
        {#if saveLabel}
          <span class="save-status" class:err={typeof saveStatus === "object"}>
            {saveLabel}
          </span>
        {/if}
      </div>
      {#if refusal ?? refused}
        <p class="hint err" role="alert">{refusal ?? refused}</p>
      {/if}

      {#if view === null}
        <p class="hint muted">Loading excluded directories...</p>
      {:else if additions.length === 0}
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
