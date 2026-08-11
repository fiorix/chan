<script lang="ts">
  // File browser settings: where uploads land, and the surface's Hybrid
  // body-theme override. The attachments path is workspace-relative and
  // rejected empty server-side, so a cleared field is left uncommitted
  // rather than PATCHed as empty.

  import type { Preferences } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import TextField from "./TextField.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  function commitAttachments(raw: string): void {
    const value = raw.trim();
    if (!value) return;
    commit((p) => ({ ...p, attachments_dir: value }));
  }
</script>

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
