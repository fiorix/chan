<script lang="ts">
  import { createDeckDraft, type DeckConfirm, type DeckItem } from "../command-deck/model";
  import CommandDeck from "./CommandDeck.svelte";

  let {
    items,
    onChoose = () => {},
    onSuccess,
    onError = () => {},
  }: {
    items: DeckItem[];
    onChoose?: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
    onSuccess?: (item: DeckItem) => void;
    onError?: (item: DeckItem, error: unknown) => void;
  } = $props();

  let draft = $state({ ...createDeckDraft(), visible: true });
  let replacementItems: DeckItem[] | null = $state(null);

  export function setItems(entries: DeckItem[]): void {
    replacementItems = entries;
  }

  export function replaceDraft(visible = true): void {
    draft = { ...createDeckDraft(), visible };
  }

  export function open(): void {
    draft.visible = true;
  }

  export function resetDraft(): void {
    Object.assign(draft, createDeckDraft());
  }

  export function currentDraft(): typeof draft {
    return draft;
  }

  /// Hide the deck the way a host does: by turning its `open` prop off.
  export function close(): void {
    draft.visible = false;
  }
</script>

<CommandDeck
  open={draft.visible}
  bind:draft
  items={replacementItems ?? items}
  scopes={[]}
  onClose={() => { draft.visible = false; }}
  {onChoose}
  {onSuccess}
  {...{ onError }}
  onBack={() => {}}
  onScope={() => {}}
  onClearScope={() => {}}
/>
