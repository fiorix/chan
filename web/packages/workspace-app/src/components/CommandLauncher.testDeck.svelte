<script lang="ts">
  // A stand-in for the shared deck that prints what the launcher hands it:
  // each row with the fields the deck draws, the scopes and the crumbs. A
  // click on a row answers as the deck's Enter does, and a click on the
  // button after a row that has a page of its own as the deck's Right does,
  // so a test reads the launcher's lists without depending on how the deck
  // lays them out.
  import type {
    DeckConfirm,
    DeckDraft,
    DeckItem,
    DeckScope,
    DeckScopeId,
  } from "@chan/web-shared/command-deck";

  let {
    open,
    draft = $bindable(),
    items,
    scopes,
    crumbs,
    placeholder,
    onChoose,
    onExpand,
    onBack,
    onScope,
    onClearScope,
    onError,
  }: {
    open: boolean;
    draft: DeckDraft;
    items: DeckItem[];
    scopes: DeckScope[];
    crumbs?: string[];
    placeholder?: string;
    onChoose: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
    onExpand?: (item: DeckItem) => void;
    onBack: () => void;
    onScope: (scope: DeckScopeId) => void;
    onClearScope: () => void;
    onError: (item: DeckItem, error: unknown) => void;
  } = $props();

  // Runs the launcher has not answered yet, as the deck holds a row's run
  // until its promise settles.
  let pending = $state(0);

  function choose(item: DeckItem): void {
    if (item.disabled) return;
    pending += 1;
    void Promise.resolve()
      .then(() => onChoose(item))
      .catch((error: unknown) => onError(item, error))
      .finally(() => {
        pending -= 1;
      });
  }
</script>

{#if open}
  <div
    class="probe"
    data-crumbs={(crumbs ?? []).join(" > ")}
    data-placeholder={placeholder}
    data-pending={pending}
  >
    <input
      class="probe-query"
      value={draft.query}
      oninput={(event) => {
        draft.query = event.currentTarget.value;
        draft.selectedId = null;
      }}
    />
    {#each scopes as scope (scope.id)}
      <button
        class="probe-scope"
        data-id={scope.id}
        data-caption={scope.caption ?? ""}
        data-available={scope.available !== false}
        data-active={draft.scope === scope.id}
        onclick={() => {
          draft.scope = scope.id;
          onScope(scope.id);
        }}
      >{scope.label}</button>
    {/each}
    <button class="probe-clear" onclick={onClearScope}>clear</button>
    <button class="probe-back" onclick={onBack}>back</button>
    {#each items as item (item.id)}
      <button
        class="probe-row"
        data-id={item.id}
        data-section={item.section ?? ""}
        data-breadcrumb={item.breadcrumb}
        data-subtitle={item.subtitle ?? ""}
        data-value={item.value ?? ""}
        data-kind={item.kind ?? "action"}
        data-checked={item.checked === true}
        data-danger={item.danger === true}
        data-disabled={item.disabled === true}
        data-shortcut={item.shortcut ?? ""}
        data-expandable={item.expandable === true}
        onclick={() => choose(item)}
      >{item.title}</button>
      {#if item.expandable}
        <button class="probe-expand" data-id={item.id} onclick={() => onExpand?.(item)}>page</button>
      {/if}
    {/each}
  </div>
{/if}
