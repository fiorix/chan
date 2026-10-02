<script lang="ts">
  // Pretty-tree renderer for JSON files. Mounted when a `.json`
  // tab is in `mode === "pretty"`. The buffer (`value`) stays
  // authoritative: this view only renders, edits happen back in
  // source mode (the tab menu's "Show Source" toggle).
  //
  // Parse is reactive on the buffer: a single bad keystroke in
  // source mode shows a parse error here as soon as the user
  // flips back. The buffer is saved as typed whether or not it
  // parses, as any other text file is, so this view is where a
  // JSON that does not parse is said.

  import JsonNode from "./JsonNode.svelte";

  let { value }: { value: string } = $props();

  type Parsed =
    | { ok: true; value: any }
    | { ok: false; error: string };

  const MAX_TREE_BYTES = 1024 * 1024;
  const tooLarge = $derived(
    value.length > MAX_TREE_BYTES || new Blob([value]).size > MAX_TREE_BYTES,
  );
  const parsed = $derived<Parsed | null>(tooLarge ? null : parse(value));

  function parse(src: string): Parsed {
    // Empty buffer: render an empty doc rather than an error so a
    // freshly-created `.json` file doesn't immediately scream
    // "invalid".
    if (src.trim() === "") return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(src) as any };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
</script>

<div class="json-pretty">
  {#if tooLarge}
    <p>This file is too large for the tree (over 1 MiB). Source shows its contents.</p>
  {:else if parsed?.ok}
    <JsonNode value={parsed.value} path="$" />
  {:else if parsed}
    <div class="parse-error">
      <strong>Parse error:</strong>
      <span>{parsed.error}</span>
      <p class="hint">Flip back to Source to fix the syntax.</p>
    </div>
  {/if}
</div>

<style>
  .json-pretty {
    /* Same shape as .md-source so the container sits flush in the
       editor pane and scrolls vertically when the tree is taller
       than the viewport. */
    flex: 1;
    min-height: 0;
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    background: var(--bg);
    padding: 12px 16px 60px 16px;
    max-width: var(--chan-page-max-width, none);
    margin-inline: auto;
  }
  .parse-error {
    color: var(--danger-text);
    font-size: 14px;
    line-height: 1.5;
    padding: 12px 16px;
    border: 1px solid var(--danger-text);
    border-radius: 4px;
    background: rgba(207, 34, 46, 0.08);
  }
  .parse-error .hint {
    margin-top: 8px;
    color: var(--text-secondary);
    font-size: 13px;
  }
</style>
