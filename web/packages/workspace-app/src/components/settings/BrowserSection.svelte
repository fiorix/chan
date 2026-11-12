<script lang="ts">
  // File browser settings: which docks show, the optional Vim map, and the
  // surface's Hybrid body-theme override. Each field takes its words, and a
  // dock its change, from the settings index.

  import { browserKeys, setBrowserVim } from "../../state/browserKeys.svelte";
  import type { Preferences } from "../../api/types";
  import { commitSetting, type CommitFn } from "./commit";
  import { settingEntry, toggledIn } from "./settingsIndex";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const DOCKS = [
    { entry: settingEntry("browser.leftDock"), pref: "browser_side_panes.left", edge: "left" },
    { entry: settingEntry("browser.rightDock"), pref: "browser_side_panes.right", edge: "right" },
  ] as const;
  const VIM = settingEntry("browser.vim");
</script>

{#each DOCKS as dock (dock.entry.id)}
  <SettingField
    setting={dock.entry}
    pref={dock.pref}
    hint={`Show a file browser docked at the window's ${dock.edge} edge. The file browser's own menu toggles the same field.`}
  >
    <PillToggle
      label={dock.entry.caption}
      checked={toggledIn(dock.entry, prefs)}
      ontoggle={(on) => commitSetting(commit, dock.entry, on)}
    />
  </SettingField>
{/each}

<SettingField setting={VIM} hint="Standard desktop keys are always available. The optional Vim map applies to file lists and trees in this browser; text inputs keep their normal keys.">
  <PillToggle label={VIM.caption} checked={browserKeys.vim} ontoggle={setBrowserVim} />
</SettingField>

<SurfaceThemeField kind="browser" {prefs} {commit} />
