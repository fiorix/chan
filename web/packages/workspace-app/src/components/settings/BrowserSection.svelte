<script lang="ts">
  // File browser settings: where uploads land, and the surface's Hybrid
  // body-theme override. The attachments path is workspace-relative and
  // rejected empty server-side, so a cleared field is left uncommitted
  // rather than PATCHed as empty.

  import type { Preferences } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import TextField from "./TextField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  function commitAttachments(raw: string): void {
    const value = raw.trim();
    if (!value) return;
    commit((p) => ({ ...p, attachments_dir: value }));
  }

  function commitSidePane(side: "left" | "right", on: boolean): void {
    commit((p) => ({
      ...p,
      browser_side_panes: { ...p.browser_side_panes, [side]: on },
    }));
  }
</script>

<SettingField
  label="Side panes"
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

<SurfaceThemeField kind="browser" {prefs} {commit} />
