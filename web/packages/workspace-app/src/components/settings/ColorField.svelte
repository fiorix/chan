<script lang="ts">
  // Colour swatch + hex text row for Settings: one swatch, one
  // free-text hex field with inline validation, an optional trailing
  // description, and an error slot. One-way: `value` is the committed
  // hex the swatch shows and `oncommit` fires the write with a
  // normalized `#rrggbb`, or null when the field was cleared (only
  // meaningful when `defaultHex` is set; without it empty text is a
  // validation error). Entering the default commits null too, so an
  // override store stays sparse. The draft and error are local and
  // reseed when `value` changes externally, so typing never fights a
  // buffer reseed.

  import { normalizeHexColor } from "../../state/paneColor";

  let {
    id,
    label,
    value,
    defaultHex,
    description,
    oncommit,
  }: {
    id: string;
    label: string;
    value: string;
    defaultHex?: string;
    description?: string;
    oncommit: (hex: string | null) => void;
  } = $props();

  // Static placeholder seed; the effect reseeds from `value` on mount
  // and on every external change (reading `value` here would capture
  // the initial value, and svelte-check flags it).
  let draft = $state("");
  let error = $state<string | undefined>(undefined);
  $effect(() => {
    draft = value;
    error = undefined;
  });

  function commit(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === "" && defaultHex !== undefined) {
      error = undefined;
      draft = defaultHex;
      oncommit(null);
      return;
    }
    const normalized = normalizeHexColor(trimmed);
    if (!normalized) {
      error = "Enter #rgb or #rrggbb.";
      return;
    }
    error = undefined;
    draft = normalized;
    // Entering the default clears the override instead of storing a
    // redundant one, keeping the stored palette sparse.
    oncommit(defaultHex !== undefined && normalized === defaultHex ? null : normalized);
  }

  function onKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit(event.currentTarget.value);
    event.currentTarget.blur();
  }
</script>

<div class="colour-row">
  <label for={id}>{label}</label>
  <input
    type="color"
    {value}
    aria-label={`${label} colour swatch`}
    oninput={(event) => commit(event.currentTarget.value)}
  />
  <input
    {id}
    type="text"
    value={draft}
    aria-invalid={error ? "true" : undefined}
    oninput={(event) => (draft = event.currentTarget.value)}
    onblur={(event) => commit(event.currentTarget.value)}
    onkeydown={onKeydown}
  />
  {#if description}
    <span class="colour-desc">{description}</span>
  {/if}
  {#if error}
    <span class="colour-error" role="alert">{error}</span>
  {/if}
</div>

<style>
  .colour-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .colour-row > label {
    width: 8em;
    color: var(--text);
    font-size: 13px;
  }
  .colour-row input[type="color"] {
    width: 34px;
    height: 30px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
  }
  .colour-row input[type="text"] {
    width: 8em;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--chan-editor-code-family, monospace);
  }
  .colour-row input[aria-invalid="true"] {
    border-color: var(--danger, #ef4444);
  }
  .colour-desc {
    color: var(--text-secondary);
    font-size: 12px;
  }
  .colour-error {
    color: var(--danger, #ef4444);
    font-size: 12px;
  }
</style>
