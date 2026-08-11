<script lang="ts">
  // The "This workspace" settings tab body. Unlike the per-machine sections,
  // these controls act on the active workspace only, so the tab is shown just
  // when Settings is opened from a workspace context (SettingsOverlay gates it
  // on workspace.info). Each control is self-contained and calls its own
  // per-workspace endpoint; none flow through the split-store PreferencesView
  // buffer the per-machine sections use.

  import { workspace } from "../../../state/store.svelte";
  import IndexControl from "./IndexControl.svelte";
  import SemanticControl from "./SemanticControl.svelte";
  import ExcludedDirsControl from "./ExcludedDirsControl.svelte";
  import ReportsControl from "./ReportsControl.svelte";
  import MetadataControl from "./MetadataControl.svelte";
  import ScreenLockControl from "./ScreenLockControl.svelte";
</script>

<div class="workspace-settings">
  <p class="scope-note">
    These settings apply to the current workspace only:
    <span class="root" title={workspace.info?.root}>{workspace.info?.root}</span>.
    Appearance, Editor, Terminal, and shortcuts are per-machine and live in the
    other tabs.
  </p>

  <IndexControl />
  <SemanticControl />
  <ExcludedDirsControl />
  <ReportsControl />
  <MetadataControl />
  <ScreenLockControl />
</div>

<style>
  .workspace-settings {
    display: flex;
    flex-direction: column;
    /* The SettingField sections carry their own separator (the shared
       border-bottom), so the container adds no dividers of its own. */
  }
  .scope-note {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.45;
  }
  .scope-note .root {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text);
    overflow-wrap: anywhere;
  }
</style>
