<script lang="ts">
  import { tick } from "svelte";
  import type { DeckDraft, DeckItem, DeckScope, DeckScopeId } from "../command-deck/model";

  let {
    open,
    draft = $bindable(),
    items,
    scopes,
    placeholder = "Search",
    bodyKey = "root",
    direction = "forward",
    onClose,
    onChoose,
    onBack,
    onScope,
    onClearScope,
    onSuccess,
  }: {
    open: boolean;
    draft: DeckDraft;
    items: DeckItem[];
    scopes: DeckScope[];
    placeholder?: string;
    bodyKey?: string;
    direction?: "forward" | "back" | "still";
    onClose: () => void;
    onChoose: (item: DeckItem) => void | Promise<void>;
    onBack: () => void;
    onScope: (scope: DeckScopeId) => void;
    onClearScope: () => void;
    onSuccess?: (item: DeckItem) => void;
  } = $props();

  const LIST_ID = "chan-command-deck-list";
  const optionId = (index: number): string => `chan-command-deck-option-${index}`;

  let input: HTMLInputElement | undefined = $state();
  let zone: "input" | "results" | "scopes" = $state("input");
  let keyboardIndex = $state(0);
  let pointerIndex: number | null = $state(null);
  let scopeIndex = $state(0);
  let wasOpen = false;
  let confirmKeyReleased = true;

  const activeIndex = $derived(pointerIndex ?? keyboardIndex);
  const availableScopes = $derived(scopes.filter((scope) => scope.available !== false));
  const selectedItem = $derived(items[activeIndex]);

  function reconcileSelection(): void {
    if (!items.length) {
      keyboardIndex = -1;
      draft.selectedId = null;
      return;
    }
    const restored = draft.selectedId
      ? items.findIndex((item) => item.id === draft.selectedId)
      : -1;
    keyboardIndex = restored >= 0 ? restored : 0;
    draft.selectedId = items[keyboardIndex]?.id ?? null;
  }

  $effect(() => {
    const isOpen = open;
    if (isOpen && !wasOpen) {
      reconcileSelection();
      zone = "input";
      pointerIndex = null;
      void tick().then(() => input?.focus());
    }
    wasOpen = isOpen;
  });

  $effect(() => {
    const ids = items.map((item) => item.id).join("\u001f");
    void ids;
    if (!open) return;
    reconcileSelection();
  });

  $effect(() => {
    const wanted = draft.scope;
    const found = wanted ? availableScopes.findIndex((scope) => scope.id === wanted) : -1;
    if (found >= 0) scopeIndex = found;
    else if (scopeIndex >= availableScopes.length) scopeIndex = Math.max(0, availableScopes.length - 1);
  });

  function setKeyboardIndex(index: number): void {
    if (!items.length) {
      keyboardIndex = -1;
      draft.selectedId = null;
      return;
    }
    keyboardIndex = Math.max(0, Math.min(items.length - 1, index));
    draft.selectedId = items[keyboardIndex]?.id ?? null;
    pointerIndex = null;
    zone = "results";
    void tick().then(() =>
      document.getElementById(optionId(keyboardIndex))?.scrollIntoView({ block: "nearest" }),
    );
  }

  function enterScopes(): void {
    if (!availableScopes.length) return;
    const active = draft.scope
      ? availableScopes.findIndex((scope) => scope.id === draft.scope)
      : -1;
    scopeIndex = active >= 0 ? active : 0;
    zone = "scopes";
    pointerIndex = null;
  }

  function moveScope(delta: number): void {
    if (!availableScopes.length) return;
    const next = scopeIndex + delta;
    if (next < 0) {
      draft.scope = null;
      onClearScope();
      zone = "input";
      input?.focus();
      return;
    }
    scopeIndex = Math.min(availableScopes.length - 1, next);
    const scope = availableScopes[scopeIndex];
    if (!scope) return;
    draft.scope = scope.id;
    onScope(scope.id);
  }

  function openConfirm(item: DeckItem): void {
    const confirm = item.confirm;
    if (!confirm) return;
    confirmKeyReleased = false;
    draft.operation = {
      kind: "confirm",
      itemId: item.id,
      title: confirm.title,
      message: confirm.message,
      actionLabel: confirm.actionLabel,
      danger: confirm.danger === true,
      selected: "cancel",
    };
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function execute(item: DeckItem): Promise<void> {
    if (item.disabled) return;
    const executionDraft = draft;
    if (!item.awaitResult) {
      await onChoose(item);
      return;
    }
    draft.operation = { kind: "pending", itemId: item.id, title: item.title };
    try {
      await onChoose(item);
      // A hidden pending command can finish after another native window takes
      // ownership of the reusable overlay. Never paint that result into the
      // new source's draft.
      if (draft !== executionDraft) return;
      if (item.dismissImmediatelyOnSuccess) {
        onSuccess?.(item);
        return;
      }
      executionDraft.operation = { kind: "success", itemId: item.id, title: item.title };
      await new Promise((resolve) => setTimeout(resolve, 260));
      if (draft !== executionDraft) return;
      onSuccess?.(item);
    } catch (error) {
      if (draft !== executionDraft) return;
      executionDraft.operation = {
        kind: "error",
        itemId: item.id,
        title: item.title,
        message: errorMessage(error),
        selected: "back",
      };
    }
  }

  function choose(item: DeckItem | undefined): void {
    if (!item || item.disabled) return;
    if (item.confirm && draft.operation?.itemId !== item.id) {
      openConfirm(item);
      return;
    }
    void execute(item);
  }

  function operationItem(): DeckItem | undefined {
    const id = draft.operation?.itemId;
    return id ? items.find((item) => item.id === id) : undefined;
  }

  function operationBack(): void {
    draft.operation = null;
    zone = "results";
    void tick().then(() => input?.focus());
  }

  function operationEnter(event: KeyboardEvent): void {
    const operation = draft.operation;
    if (!operation || event.repeat || !confirmKeyReleased) return;
    if (operation.kind === "confirm") {
      if (operation.selected === "cancel") {
        operationBack();
        return;
      }
      const item = operationItem();
      if (item) void execute(item);
    } else if (operation.kind === "error") {
      if (operation.selected === "back") {
        operationBack();
        return;
      }
      const item = operationItem();
      if (item) void execute(item);
    }
  }

  function onInput(event: Event): void {
    draft.query = (event.currentTarget as HTMLInputElement).value;
    draft.selectedId = null;
    keyboardIndex = items.length ? 0 : -1;
    pointerIndex = null;
    zone = "input";
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    const operation = draft.operation;
    if (operation) {
      if (operation.kind === "confirm" || operation.kind === "error") {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Tab") {
          event.preventDefault();
          operation.selected =
            operation.kind === "confirm"
              ? operation.selected === "cancel" ? "action" : "cancel"
              : operation.selected === "back" ? "retry" : "back";
        } else if (event.key === "Enter") {
          event.preventDefault();
          operationEnter(event);
        } else if (event.key === "Backspace" || event.key === "ArrowLeft") {
          event.preventDefault();
          operationBack();
        }
      }
      return;
    }

    if (zone === "scopes") {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveScope(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveScope(1);
      } else if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        setKeyboardIndex(0);
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        zone = "input";
        input?.focus();
      }
      return;
    }

    if (zone === "results") {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setKeyboardIndex(keyboardIndex >= items.length - 1 ? 0 : keyboardIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (keyboardIndex <= 0) enterScopes();
        else setKeyboardIndex(keyboardIndex - 1);
      } else if (event.key === "Enter" || event.key === "ArrowRight") {
        event.preventDefault();
        choose(selectedItem);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        onBack();
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        zone = "input";
        input?.focus();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setKeyboardIndex(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      enterScopes();
    } else if (event.key === "Enter" && items.length) {
      event.preventDefault();
      choose(selectedItem);
    } else if ((event.key === "Backspace" && draft.query === "") || event.key === "ArrowLeft" && draft.query === "") {
      event.preventDefault();
      onBack();
    } else if (event.key === "Tab") {
      event.preventDefault();
      enterScopes();
    }
  }
</script>

<svelte:window onkeyup={(event) => { if (event.key === "Enter") confirmKeyReleased = true; }} />

{#if open}
  <div class="deck-overlay" data-direction={direction}>
    <button class="deck-backdrop" type="button" aria-label="Hide command launcher" onclick={onClose}></button>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <section
      class="deck-shell"
      role="dialog"
      aria-modal="false"
      aria-label="Command launcher"
      onkeydown={onKeydown}
    >
      <svg class="deck-filter" width="0" height="0" aria-hidden="true">
        <filter id="chan-command-orb-blob">
          <feGaussianBlur stdDeviation="7" in="SourceGraphic" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -7" result="blob" />
          <feBlend in="SourceGraphic" in2="blob" />
        </filter>
      </svg>

      <div class="deck-topline">
        <div class="deck-capsule">
          <svg class="deck-search-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m20 20-4-4"></path>
          </svg>
          <div class="deck-input-wrap">
            {#if !draft.query}
              {#key placeholder}
                <span class="deck-placeholder">{placeholder}</span>
              {/key}
            {/if}
            <input
              class="deck-input"
              bind:this={input}
              value={draft.query}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={LIST_ID}
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              aria-autocomplete="list"
              aria-label={placeholder}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              oninput={onInput}
            />
          </div>
        </div>

        <div class="deck-scopes" class:keyboard-active={zone === "scopes"} style="filter: url(#chan-command-orb-blob)">
          {#each scopes as scope, index (scope.id)}
            {@const Icon = scope.icon}
            <button
              class="deck-scope"
              class:active={draft.scope === scope.id}
              class:focused={zone === "scopes" && availableScopes[scopeIndex]?.id === scope.id}
              disabled={scope.available === false}
              type="button"
              aria-label={`${scope.label} scope`}
              aria-pressed={draft.scope === scope.id}
              title={scope.label}
              onclick={() => {
                if (scope.available === false) return;
                draft.scope = scope.id;
                scopeIndex = availableScopes.findIndex((candidate) => candidate.id === scope.id);
                zone = "scopes";
                onScope(scope.id);
              }}
              style={`--orb-index: ${index}`}
            >
              <Icon size={20} strokeWidth={1.55} aria-hidden="true" />
            </button>
          {/each}
        </div>
      </div>

      <div class="deck-panel">
        {#if draft.contextChanged}
          <div class="deck-context-note">Context changed</div>
        {/if}
        {#if draft.operation}
          {@const operation = draft.operation}
          <div class="deck-operation" aria-live="polite">
            {#if operation.kind === "confirm"}
              <div class="deck-operation-icon">?</div>
              <div class="deck-operation-copy">
                <strong>{operation.title}</strong>
                <span>{operation.message}</span>
              </div>
              <div class="deck-decisions">
                <button class:chosen={operation.selected === "cancel"} type="button" onclick={operationBack}>Cancel</button>
                <button
                  class:chosen={operation.selected === "action"}
                  class:danger={operation.danger}
                  type="button"
                  onclick={() => {
                    const item = operationItem();
                    if (item) void execute(item);
                  }}
                >{operation.actionLabel}</button>
              </div>
            {:else if operation.kind === "pending"}
              <span class="deck-spinner" aria-hidden="true"></span>
              <div class="deck-operation-copy"><strong>{operation.title}</strong><span>Working…</span></div>
            {:else if operation.kind === "success"}
              <div class="deck-operation-icon success">✓</div>
              <div class="deck-operation-copy"><strong>{operation.title}</strong><span>Done</span></div>
            {:else}
              <div class="deck-operation-icon error">!</div>
              <div class="deck-operation-copy"><strong>{operation.title}</strong><span>{operation.message}</span></div>
              <div class="deck-decisions">
                <button class:chosen={operation.selected === "back"} type="button" onclick={operationBack}>Back</button>
                <button
                  class:chosen={operation.selected === "retry"}
                  type="button"
                  onclick={() => { const item = operationItem(); if (item) void execute(item); }}
                >Retry</button>
              </div>
            {/if}
          </div>
        {:else}
          {#key bodyKey}
            <div
              class="deck-results"
              id={LIST_ID}
              role="listbox"
              tabindex="-1"
              aria-label="Commands"
              onpointerleave={() => (pointerIndex = null)}
            >
              {#if items.length}
                {#each items as item, index (item.id)}
                  {@const Icon = item.icon}
                  <button
                    class="deck-result"
                    class:active={index === activeIndex}
                    class:disabled={item.disabled}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={item.disabled === true}
                    disabled={item.disabled}
                    onclick={() => {
                      keyboardIndex = index;
                      pointerIndex = index;
                      zone = "results";
                      draft.selectedId = item.id;
                      choose(item);
                    }}
                    onpointermove={() => (pointerIndex = index)}
                  >
                    <span class="deck-result-icon">
                      {#if Icon}<Icon size={19} strokeWidth={1.55} aria-hidden="true" />{/if}
                    </span>
                    <span class="deck-result-copy">
                      <span class="deck-result-title">{item.title}</span>
                      <span class="deck-result-path">{item.breadcrumb}</span>
                    </span>
                    {#if index === activeIndex && item.shortcut}
                      <kbd>{item.shortcut}</kbd>
                    {/if}
                    {#if index === activeIndex && item.kind === "branch"}
                      <svg class="deck-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                    {/if}
                  </button>
                {/each}
              {:else}
                <p class="deck-empty">No matching commands</p>
              {/if}
            </div>
          {/key}
        {/if}
      </div>
    </section>
  </div>
{/if}

<style>
  .deck-overlay {
    --deck-scrim: rgba(0, 0, 0, 0.56);
    position: fixed;
    inset: 0;
    z-index: 32000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: min(17vh, 136px) 16px 16px;
    box-sizing: border-box;
    color: var(--text);
  }
  :global([data-theme="light"]) .deck-overlay { --deck-scrim: rgba(0, 0, 0, 0.32); }
  .deck-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: var(--deck-scrim);
    cursor: default;
    animation: scrim-in 180ms ease-out;
  }
  .deck-shell {
    position: relative;
    width: min(650px, 100%);
    min-width: 0;
    outline: none;
    filter: drop-shadow(0 22px 36px rgba(0, 0, 0, 0.2));
    animation: deck-arrive 440ms cubic-bezier(0.2, 0.86, 0.25, 1.12);
  }
  .deck-filter { position: absolute; pointer-events: none; }
  .deck-topline {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .deck-capsule,
  .deck-scope,
  .deck-panel {
    background: color-mix(in srgb, var(--bg-elev) 96%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
    -webkit-backdrop-filter: blur(22px) saturate(1.08);
    backdrop-filter: blur(22px) saturate(1.08);
  }
  .deck-capsule {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    height: 58px;
    padding: 0 19px;
    gap: 11px;
    border-radius: 999px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16), inset 0 1px rgba(255, 255, 255, 0.08);
  }
  .deck-search-icon,
  .deck-chevron {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.55;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--text-secondary);
  }
  .deck-input-wrap { position: relative; flex: 1; height: 100%; min-width: 0; }
  .deck-placeholder,
  .deck-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    box-sizing: border-box;
    font: inherit;
    font-size: 21px;
    letter-spacing: -0.015em;
  }
  .deck-placeholder {
    color: var(--text-secondary);
    pointer-events: none;
    animation: placeholder-in 180ms ease-out;
  }
  .deck-input {
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
  }
  .deck-scopes {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
  }
  .deck-scope {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border-radius: 999px;
    color: var(--text-secondary);
    opacity: 0.36;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
    transition: opacity 160ms ease, color 160ms ease, box-shadow 180ms ease, transform 180ms ease;
    animation: orb-arrive 420ms cubic-bezier(0.2, 0.9, 0.25, 1.16) both;
    animation-delay: calc(var(--orb-index) * 36ms + 70ms);
  }
  .deck-scope:hover,
  .deck-scope.active,
  .deck-scope.focused { opacity: 1; color: var(--text); }
  .deck-scope.focused {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18), 0 0 0 2px color-mix(in srgb, var(--deck-accent, var(--brand)) 58%, transparent);
  }
  .deck-scope.active:not(.focused) {
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.14), inset 0 0 0 1px color-mix(in srgb, var(--deck-accent, var(--brand)) 42%, transparent);
  }
  .deck-scope:disabled { opacity: 0.12; cursor: default; }
  .deck-panel {
    position: relative;
    z-index: 1;
    width: calc(100% - 4px);
    max-height: min(430px, 62vh);
    margin: 10px 2px 0;
    overflow: hidden;
    border-radius: 24px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24), inset 0 1px rgba(255, 255, 255, 0.07);
    transform-origin: center top;
    animation: panel-unfold 360ms cubic-bezier(0.2, 0.84, 0.25, 1.08);
  }
  .deck-context-note {
    padding: 7px 16px 0;
    color: var(--text-secondary);
    font-size: 11px;
    animation: note-away 2.4s ease both;
  }
  .deck-results {
    max-height: min(430px, 62vh);
    overflow-y: auto;
    padding: 7px;
  }
  [data-direction="forward"] .deck-results { animation: body-forward 220ms ease-out; }
  [data-direction="back"] .deck-results { animation: body-back 220ms ease-out; }
  .deck-result {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 51px;
    gap: 11px;
    padding: 6px 10px;
    border: 0;
    border-radius: 16px;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    transition: background-color 140ms ease, box-shadow 160ms ease, transform 160ms ease;
  }
  .deck-result.active {
    background: color-mix(in srgb, var(--bg-card) 88%, var(--text) 4%);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.13), inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent);
    transform: translateY(-0.5px);
  }
  .deck-result.disabled { opacity: 0.34; cursor: default; }
  .deck-result-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    transition: color 140ms ease, background-color 140ms ease;
  }
  .deck-result.active .deck-result-icon { color: var(--deck-accent, var(--text)); }
  .deck-result-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
  .deck-result-title,
  .deck-result-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deck-result-title { font-size: 14px; font-weight: 590; letter-spacing: -0.006em; }
  .deck-result-path { color: var(--text-secondary); font-size: 11.5px; }
  kbd {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
    border-radius: 6px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg) 56%, transparent);
    font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .deck-empty { margin: 0; padding: 26px 18px; color: var(--text-secondary); text-align: center; font-size: 13px; }
  .deck-operation {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 88px;
    padding: 13px 15px;
    animation: body-forward 200ms ease-out;
  }
  .deck-operation-icon,
  .deck-spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .deck-operation-icon.success { color: var(--accent); }
  .deck-operation-icon.error { color: var(--danger, #d1242f); }
  .deck-spinner { box-sizing: border-box; border: 2px solid color-mix(in srgb, var(--text) 12%, transparent); border-top-color: var(--deck-accent, var(--brand)); animation: spin 800ms linear infinite; }
  .deck-operation-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
  .deck-operation-copy strong { font-size: 14px; }
  .deck-operation-copy span { color: var(--text-secondary); font-size: 12px; line-height: 1.35; }
  .deck-decisions { display: flex; gap: 7px; }
  .deck-decisions button {
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .deck-decisions button.chosen { color: var(--text); background: color-mix(in srgb, var(--text) 7%, transparent); border-color: color-mix(in srgb, var(--text) 12%, transparent); }
  .deck-decisions button.danger.chosen { color: var(--danger, #d1242f); }
  @keyframes scrim-in { from { opacity: 0; } }
  @keyframes deck-arrive { from { opacity: 0; transform: translateY(-10px) scaleX(1.08) scaleY(.96); filter: blur(13px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes panel-unfold { from { opacity: 0; transform: translateY(-8px) scaleY(.92); filter: blur(7px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes orb-arrive { from { opacity: 0; transform: translateX(-28px) scale(.72); } }
  @keyframes placeholder-in { from { opacity: 0; transform: translateY(7px); filter: blur(4px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes body-forward { from { opacity: 0; transform: translateX(13px); filter: blur(4px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes body-back { from { opacity: 0; transform: translateX(-13px); filter: blur(4px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes note-away { 0%, 72% { opacity: .72; } 100% { opacity: 0; } }
  @media (max-width: 640px) {
    .deck-overlay { padding-top: 54px; }
    .deck-topline { flex-wrap: wrap; justify-content: center; }
    .deck-capsule { flex-basis: 100%; }
    .deck-scopes { order: 2; }
    .deck-panel { margin-top: 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .deck-backdrop, .deck-shell, .deck-panel, .deck-scope, .deck-placeholder, .deck-results, .deck-operation, .deck-spinner { animation-duration: 1ms; animation-delay: 0ms; }
    .deck-result, .deck-scope { transition-duration: 1ms; }
  }
</style>
