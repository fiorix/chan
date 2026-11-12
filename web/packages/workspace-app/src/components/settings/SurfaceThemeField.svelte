<script lang="ts">
  // The per-surface body-theme row: pin one Hybrid surface's body to
  // Light or Dark independently of the app theme, or Inherit it. Lives
  // in the surface's own Settings section. Its words and its write are
  // its entry in the settings index: Inherit drops the key so the surface
  // follows the app theme again, and the store setters behind the write
  // apply the skin live.

  import type { HybridSurfaceKind, Preferences } from "../../api/types";
  import { commitSetting, type CommitFn } from "./commit";
  import { chosenIn, optionsOf, settingEntry } from "./settingsIndex";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";

  let {
    kind,
    prefs,
    commit,
  }: {
    kind: HybridSurfaceKind;
    prefs: Preferences;
    commit: CommitFn;
  } = $props();

  const entry = $derived(settingEntry(`${kind}.bodyTheme`));
</script>

<SettingField
  setting={entry}
  pref="hybrid_surface_themes"
  hint="Pin this surface's body to Light or Dark independently of the app theme, or Inherit it."
>
  <PillRadio
    name={`settings-surface-theme-${kind}`}
    ariaLabel={`${entry.heading} override`}
    value={chosenIn(entry, prefs)}
    options={optionsOf(entry)}
    onselect={(choice) => commitSetting(commit, entry, choice)}
  />
</SettingField>
