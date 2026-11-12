<script lang="ts">
  import {
    createDeckDraft,
    type DeckConfirm,
    type DeckDraft,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "../command-deck/model";
  import CommandDeck from "./CommandDeck.svelte";

  let {
    items,
    scopes = [],
    crumbs,
    placeholder,
    initialDraft = {},
    onChoose = () => {},
    onSuccess,
    onError = () => {},
    onFocusLost,
    mayTakeFocus,
    onClose,
    onBack = () => {},
    onScope = () => {},
    onClearScope = () => {},
    onExpand,
  }: {
    items: DeckItem[];
    scopes?: DeckScope[];
    crumbs?: string[];
    placeholder?: string;
    /// Fields the draft starts with, as a host that restored one would.
    initialDraft?: Partial<DeckDraft>;
    onChoose?: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
    onSuccess?: (item: DeckItem) => void;
    onError?: (item: DeckItem, error: unknown) => void;
    onFocusLost?: () => void;
    mayTakeFocus?: () => boolean;
    onClose?: () => void;
    onBack?: () => void;
    onScope?: (scope: DeckScopeId) => void;
    onClearScope?: () => void;
    onExpand?: (item: DeckItem) => void;
  } = $props();

  function startingDraft(): DeckDraft {
    return { ...createDeckDraft(), visible: true, ...initialDraft };
  }

  let draft = $state(startingDraft());
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
  {scopes}
  {crumbs}
  {placeholder}
  onClose={() => {
    draft.visible = false;
    onClose?.();
  }}
  {onChoose}
  {onSuccess}
  {onFocusLost}
  {mayTakeFocus}
  {...{ onError }}
  {onBack}
  {onScope}
  {onClearScope}
  {onExpand}
/>
