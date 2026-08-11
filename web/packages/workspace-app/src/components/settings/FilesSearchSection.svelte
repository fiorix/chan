<script lang="ts">
  // Files and search settings: the server-config `search_aggression`
  // and `attachments_dir` fields. The attachments path is workspace-
  // relative and rejected empty server-side, so a cleared field is left
  // uncommitted rather than PATCHed as empty.

  import type { Preferences, SearchAggression } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";
  import TextField from "./TextField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const AGGRESSION = [
    { value: "conservative", label: "Conservative" },
    { value: "balanced", label: "Balanced" },
    { value: "aggressive", label: "Aggressive" },
  ] as const;

  // The path is workspace-relative and rejected empty server-side, so a
  // cleared field is left uncommitted rather than PATCHed as empty.
  function commitAttachments(raw: string): void {
    const value = raw.trim();
    if (!value) return;
    commit((p) => ({ ...p, attachments_dir: value }));
  }
</script>

<SettingField
  label="Search indexing"
  hint="Resource profile for the search indexer. Aggressive indexes more eagerly at a higher cost."
>
  <PillRadio
    name="settings-search"
    ariaLabel="Search indexing profile"
    value={prefs.search_aggression}
    options={AGGRESSION}
    onselect={(v) =>
      commit((p) => ({ ...p, search_aggression: v as SearchAggression }))}
  />
</SettingField>

<SettingField
  label="Attachments folder"
  hint="Workspace-relative folder where pasted and uploaded images are saved."
>
  <TextField
    value={prefs.attachments_dir}
    placeholder="attachments"
    ariaLabel="Attachments folder"
    oncommit={commitAttachments}
  />
</SettingField>
