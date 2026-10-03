<script lang="ts">
  // Recursive node renderer for the JSON pretty viewer. Used by
  // JsonPretty.svelte for the root render and by each nested
  // object / array recursively (self-referencing import below).
  //
  // The component owns its own collapse state so deeply-nested
  // trees expand and contract independently. The full JSON path
  // (`$.foo.bar[3]`) rides as a prop so right-click can copy it
  // to clipboard without re-deriving the breadcrumb at every depth.

  import JsonNode from "./JsonNode.svelte";
  import { notify } from "../state/notify.svelte";
  import { copyTextToClipboard } from "../state/store.svelte";

  let {
    value,
    label,
    path,
    depth = 0,
    initialCollapsed = depth > 1,
  }: {
    /// The parsed JSON value at this node. `any` here is unavoidable
    /// (the renderer dispatches on JS runtime type); upstream
    /// guards on JSON.parse keep the input safe.
    value: any;
    /// Object key for this node, when applicable. `undefined` for
    /// root values, array members (the index is part of `path`),
    /// and primitive leaves.
    label?: string;
    /// JSONPath-style breadcrumb for the current node. Used as the
    /// hover title and copy-to-clipboard target.
    path: string;
    /// The root and its direct members expand; deeper containers wait
    /// for the reader to open them.
    depth?: number;
    initialCollapsed?: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally
  let collapsed = $state(initialCollapsed);

  /// Runtime kind discriminator. Mirrors the JSON value taxonomy
  /// (object / array / string / number / boolean / null) so the
  /// downstream branches stay readable.
  function kindOf(v: unknown): "object" | "array" | "string" | "number" | "boolean" | "null" {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    const t = typeof v;
    if (t === "object" || t === "string" || t === "number" || t === "boolean") {
      return t as "object" | "string" | "number" | "boolean";
    }
    // Fallback for symbols / functions / undefined: JSON.parse
    // never produces these so it's defensive only.
    return "string";
  }

  const kind = $derived(kindOf(value));

  function toggle(ev: MouseEvent): void {
    ev.stopPropagation();
    collapsed = !collapsed;
  }

  async function copyPath(ev: MouseEvent): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    await copyTextToClipboard(path, {
      onSuccess: () => notify(`Copied ${path}`),
      onError: (msg) => notify(`Copy failed: ${msg}`),
    });
  }

  /// Stable child entries for objects. `Object.keys` order matches
  /// the source JSON for non-integer keys (per the spec), so the
  /// tree renders in author-intended order.
  const objectEntries = $derived.by(() => {
    if (kind !== "object") return [];
    return Object.keys(value as Record<string, unknown>).map((k) => ({
      key: k,
      val: (value as Record<string, any>)[k],
    }));
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="node"
  title={path}
  oncontextmenu={copyPath}
>
  {#if label !== undefined}
    <span class="key">"{label}":</span>
    <span class="space">&nbsp;</span>
  {/if}
  {#if kind === "object"}
    <button
      class="toggle"
      onclick={toggle}
      aria-label={collapsed ? "Expand" : "Collapse"}
    >{collapsed ? "▶" : "▼"}</button>
    <span class="bracket">&#123;</span>
    {#if collapsed}
      <span class="summary">{objectEntries.length} field{objectEntries.length === 1 ? "" : "s"}</span>
      <span class="bracket">&#125;</span>
    {:else}
      <div class="children">
        {#each objectEntries as entry (entry.key)}
          <JsonNode
            value={entry.val}
            label={entry.key}
            path={`${path}.${entry.key}`}
            depth={depth + 1}
          />
        {/each}
      </div>
      <span class="bracket">&#125;</span>
    {/if}
  {:else if kind === "array"}
    {@const arr = value as unknown[]}
    <button
      class="toggle"
      onclick={toggle}
      aria-label={collapsed ? "Expand" : "Collapse"}
    >{collapsed ? "▶" : "▼"}</button>
    <span class="bracket">[</span>
    {#if collapsed}
      <span class="summary">{arr.length} item{arr.length === 1 ? "" : "s"}</span>
      <span class="bracket">]</span>
    {:else}
      <div class="children">
        {#each arr as item, i}
          <JsonNode value={item} path={`${path}[${i}]`} depth={depth + 1} />
        {/each}
      </div>
      <span class="bracket">]</span>
    {/if}
  {:else if kind === "string"}
    <span class="string">"{value}"</span>
  {:else if kind === "number"}
    <span class="number">{value}</span>
  {:else if kind === "boolean"}
    <span class="boolean">{String(value)}</span>
  {:else}
    <span class="null">null</span>
  {/if}
</div>

<style>
  .node {
    font-family: var(--chan-editor-code-family, ui-monospace, SFMono-Regular, monospace);
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text);
  }
  .key {
    color: var(--g-doc);
    font-weight: 600;
  }
  .space {
    user-select: none;
  }
  /* Disclosure triangles: borderless button so the row reads as
     plain text with a single clickable affordance. */
  .toggle {
    background: none;
    border: 0;
    padding: 0 2px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 10px;
    width: 14px;
    text-align: center;
    vertical-align: middle;
  }
  .toggle:hover {
    color: var(--text);
  }
  .bracket {
    color: var(--text-secondary);
  }
  .summary {
    color: var(--text-secondary);
    font-style: italic;
    padding: 0 4px;
  }
  /* Indented child block. The left padding gives the tree an
     obvious nesting cue; the dotted left rule traces the spine of
     the parent so a deep tree stays legible. */
  .children {
    padding-left: 16px;
    border-left: 1px dotted var(--border);
    margin-left: 6px;
  }
  /* Type-specific colors picked to read against both light and
     dark themes without further per-theme overrides. Same hue
     family the syntax-highlight palette already uses. */
  .string {
    color: #1a7f37;
  }
  :global([data-theme="dark"]) .node .string {
    color: #7ee787;
  }
  .number {
    color: #0550ae;
  }
  :global([data-theme="dark"]) .node .number {
    color: #79c0ff;
  }
  .boolean {
    color: #953800;
    font-weight: 600;
  }
  :global([data-theme="dark"]) .node .boolean {
    color: #ffa657;
  }
  .null {
    color: var(--text-secondary);
    font-style: italic;
  }
</style>
