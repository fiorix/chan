<script lang="ts">
  // Search settings: the server-config `search_aggression` resource
  // profile for the indexer, worded and written by its entry in the
  // settings index.

  import type { Preferences } from "../../api/types";
  import { commitSetting, type CommitFn } from "./commit";
  import { chosenIn, optionsOf, settingEntry } from "./settingsIndex";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const INDEXING = settingEntry("search.indexing");
</script>

<SettingField
  setting={INDEXING}
  pref="search_aggression"
  hint="Resource profile for the search indexer. Aggressive indexes more eagerly at a higher cost."
>
  <PillRadio
    name="settings-search"
    ariaLabel="Search indexing profile"
    value={chosenIn(INDEXING, prefs)}
    options={optionsOf(INDEXING)}
    onselect={(profile) => commitSetting(commit, INDEXING, profile)}
  />
</SettingField>
