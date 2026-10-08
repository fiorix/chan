<script lang="ts">
  // File browser settings: which side panes show, and the surface's Hybrid
  // body-theme override.

  import type { Preferences } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  function commitSidePane(side: "left" | "right", on: boolean): void {
    commit((p) => ({
      ...p,
      browser_side_panes: { ...p.browser_side_panes, [side]: on },
    }));
  }
</script>

<SettingField
  label="Side panes"
  pref="browser_side_panes"
  hint="Show the file browser's left and right side panes. The browser's own stick buttons toggle the same fields."
>
  <PillToggle
    label="Left pane"
    checked={prefs.browser_side_panes.left}
    ontoggle={(on) => commitSidePane("left", on)}
  />
  <PillToggle
    label="Right pane"
    checked={prefs.browser_side_panes.right}
    ontoggle={(on) => commitSidePane("right", on)}
  />
</SettingField>

<SurfaceThemeField kind="browser" {prefs} {commit} />
