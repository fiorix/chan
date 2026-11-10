<script lang="ts">
  // Dashboard settings: the surface's Hybrid body-theme override. The
  // Dashboard's other knob, its carousel's auto-rotate, is the "Dashboard
  // carousel" row in Global (GlobalSection.svelte).

  import type { Preferences } from "../../api/types";
  import type { CommitFn } from "./commit";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();
</script>

<SurfaceThemeField kind="dashboard" {prefs} {commit} />
