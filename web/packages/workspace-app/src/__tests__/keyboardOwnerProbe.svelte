<script lang="ts">
  import { legacyKeyboardOwned } from "../state/keyboardOwner.svelte";
  import type { OverlayId } from "../state/store.svelte";
  import type { SurveySlot } from "../state/survey.svelte";

  let {
    slot = null,
    except = undefined,
  }: {
    slot?: SurveySlot;
    except?: OverlayId;
  } = $props();

  const owned = $derived(legacyKeyboardOwned(slot, except));
</script>

<span data-owned={owned ? "yes" : "no"}></span>
