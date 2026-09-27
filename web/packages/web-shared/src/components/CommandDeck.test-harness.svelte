<script lang="ts">
  import { createDeckDraft, type DeckConfirm, type DeckItem } from "../command-deck/model";
  import CommandDeck from "./CommandDeck.svelte";

  let {
    items,
    onChoose = () => {},
    onSuccess,
  }: {
    items: DeckItem[];
    onChoose?: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
    onSuccess?: (item: DeckItem) => void;
  } = $props();

  let draft = $state({ ...createDeckDraft(), visible: true });

  export function replaceDraft(): void {
    draft = { ...createDeckDraft(), visible: true };
  }

  /// Hide the deck the way a host does: by turning its `open` prop off.
  export function close(): void {
    draft.visible = false;
  }
</script>

<CommandDeck
  open={draft.visible}
  bind:draft
  {items}
  scopes={[]}
  onClose={() => { draft.visible = false; }}
  {onChoose}
  {onSuccess}
  onBack={() => {}}
  onScope={() => {}}
  onClearScope={() => {}}
/>
