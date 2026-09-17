<script lang="ts">
  import { createDeckDraft, type DeckConfirm, type DeckItem } from "../command-deck/model";
  import CommandDeck from "./CommandDeck.svelte";

  let {
    items,
    onChoose = () => {},
  }: {
    items: DeckItem[];
    onChoose?: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
  } = $props();

  let draft = $state({ ...createDeckDraft(), visible: true });
</script>

<CommandDeck
  open={draft.visible}
  bind:draft
  {items}
  scopes={[]}
  onClose={() => { draft.visible = false; }}
  {onChoose}
  onBack={() => {}}
  onScope={() => {}}
  onClearScope={() => {}}
/>
