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
  //
  // The swatch commits on `change`, not on `input`: a drag through the
  // native picker reports every colour it passes over, and each commit
  // here is a whole read-modify-write of the config.

  import { normalizeHexColor } from "../../state/paneColor";
  import type { SaveStatus } from "./commit";

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
    /// Hands back where the write ended when the caller commits through
    /// a surface that reports per control; the row then says so itself,
    /// because several rows write one preference and the preference
    /// cannot say which row was refused.
    oncommit: (hex: string | null) => void | Promise<SaveStatus>;
  } = $props();

  // Static placeholder seed; the effect reseeds from `value` on mount
  // and on every external change (reading `value` here would capture
  // the initial value, and svelte-check flags it).
  let draft = $state("");
  let error = $state<string | undefined>(undefined);
  let status = $state<SaveStatus>("idle");
  const refusal = $derived(typeof status === "object" ? status.error : null);

  /// A write the caller handed back: show it running, then show a
  /// refusal. Success returns the row to quiet, since the swatch already
  /// shows the value that was stored.
  function report(result: void | Promise<SaveStatus>): void {
    if (!result) return;
    status = "saving";
    void result.then((settled) => {
      status = settled === "saved" ? "idle" : settled;
    });
  }
  $effect(() => {
    draft = value;
    error = undefined;
  });

  function commit(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === "" && defaultHex !== undefined) {
      error = undefined;
      draft = defaultHex;
      report(oncommit(null));
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
    report(oncommit(defaultHex !== undefined && normalized === defaultHex ? null : normalized));
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
    onchange={(event) => commit(event.currentTarget.value)}
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
  {#if refusal}
    <span class="colour-error" role="alert">Not saved: {refusal}</span>
  {:else if status === "saving"}
    <span class="colour-desc">Saving...</span>
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
