<script lang="ts">
  // Search settings: the server-config `search_aggression` resource
  // profile for the indexer.

  import type { Preferences, SearchAggression } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const AGGRESSION = [
    { value: "conservative", label: "Conservative" },
    { value: "balanced", label: "Balanced" },
    { value: "aggressive", label: "Aggressive" },
  ] as const;
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
