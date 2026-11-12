<script lang="ts">
  import { flushSync, tick } from "svelte";
  import {
    createDeckDraft,
    type DeckConfirm,
    type DeckDraft,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "../command-deck/model";
  import CommandDeck from "./CommandDeck.svelte";

  /// How the stand-in surface takes the keyboard when it is shown: before the
  /// call returns, in a microtask, after a tick, on a zero-delay timer, or as
  /// its field mounts.
  type Grab = "sync" | "microtask" | "tick" | "timer" | "mount";

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
  // A stand-in for a surface under the deck that a row shows: a field that
  // takes the keyboard when shown, as a composer, an editor remounted by a
  // mode switch and a terminal handed the keyboard back each do.
  let surfaceShown = $state(false);
  let surfaceGrab: Grab = "sync";
  let surfaceField: HTMLTextAreaElement | null = null;

  function surfaceMounted(node: HTMLTextAreaElement): { destroy: () => void } {
    surfaceField = node;
    if (surfaceGrab === "mount") node.focus();
    return {
      destroy: () => {
        surfaceField = null;
      },
    };
  }

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

  /// Show the stand-in surface, whose field takes the keyboard as `grab` says.
  export function showSurface(grab: Grab): void {
    surfaceGrab = grab;
    surfaceShown = true;
    const take = (): void => surfaceField?.focus();
    if (grab === "mount") return;
    if (grab === "tick") {
      void tick().then(take);
    } else if (grab === "timer") {
      setTimeout(take, 0);
    } else {
      // The field is in the page before the caller goes on.
      flushSync();
      if (grab === "sync") take();
      else queueMicrotask(take);
    }
  }

  export function hideSurface(): void {
    surfaceShown = false;
  }
</script>

{#if surfaceShown}
  <textarea class="stand-in-surface" use:surfaceMounted></textarea>
{/if}

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
