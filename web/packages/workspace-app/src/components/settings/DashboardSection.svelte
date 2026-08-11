<script lang="ts">
  // Dashboard settings: the surface's Hybrid body-theme override. The
  // dashboard has no other Settings knob today.

  import type { Preferences } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();
</script>

<SurfaceThemeField kind="dashboard" {prefs} {commit} />
