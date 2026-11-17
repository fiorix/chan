<script lang="ts">
  import { keyboardOwned } from "../state/focusGuard.svelte";
  import type { OverlayId } from "../state/store.svelte";
  import type { SurveySlot } from "../state/survey.svelte";

  let {
    slot = null,
    except = undefined,
  }: {
    slot?: SurveySlot;
    except?: OverlayId;
  } = $props();

  const owned = $derived(keyboardOwned(slot, except));
</script>

<span data-owned={owned ? "yes" : "no"}></span>
