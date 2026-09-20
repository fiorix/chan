<script lang="ts">
  // Recursive renderer for the pane layout tree.
  // Self-import is required by Svelte 5 (svelte:self is deprecated).
  //
  // We deliberately do NOT use a $props default of `layout.rootId`:
  // those are not reactive against state mutations inside the default
  // expression, so splits at the root would stop re-rendering. Use an
  // explicit `$derived` fallback instead.
  //
  // Splits support drag-resize: each child sits in a `.half` flex
  // wrapper whose `flex-grow` is the split's `ratio` (or `1-ratio`
  // for the second child). The wrapper inherits flex-direction from
  // the parent so column splits don't starve their children's
  // cross-axis space.

  import { activeLayout, type LeafNode, type SplitNode } from "../state/tabs.svelte";
  import {
    schedulePersistStateToHash,
    scheduleSessionSave,
  } from "../state/store.svelte";
  import Pane from "./Pane.svelte";
  import Self from "./Workspace.svelte";

  let { nodeId }: { nodeId?: string } = $props();
  const viewLayout = $derived(activeLayout());
  const effectiveId = $derived(nodeId ?? viewLayout.rootId);
  const node = $derived(viewLayout.nodes[effectiveId]);

  function startResize(e: MouseEvent, split: SplitNode): void {
    e.preventDefault();
    const splitEl = (e.currentTarget as HTMLElement).parentElement;
    if (!splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    const isRow = split.direction === "row";
    const total = isRow ? rect.width : rect.height;
    if (total <= 0) return;
    const startCoord = isRow ? e.clientX : e.clientY;
    const startRatio = split.ratio;

    const onMove = (ev: MouseEvent) => {
      const coord = isRow ? ev.clientX : ev.clientY;
      const delta = coord - startCoord;
      // Clamp so panes can't be dragged out of existence; 5% on
      // each side is enough headroom to grab the divider back.
      const next = Math.max(0.05, Math.min(0.95, startRatio + delta / total));
      split.ratio = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Restore default cursor (we set a global one during the
      // drag so it doesn't flicker as the cursor passes over
      // child elements with their own cursor styles).
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      // Persist the new ratio. The layout-persistence effect only tracks
      // leaf nodes, so a divider drag (which mutates the split's ratio)
      // never schedules a save on its own -- the size is then lost on
      // reload, notably when an adjacent pane is empty and no other
      // activity triggers a save.
      schedulePersistStateToHash();
      scheduleSessionSave();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }
</script>

{#if node}
  {#if node.kind === "leaf"}
    <Pane pane={node as LeafNode} />
  {:else}
    {@const split = node as SplitNode}
    <div
      class="split"
      class:row={split.direction === "row"}
      class:column={split.direction === "column"}
    >
      <div class="half" style="flex-grow: {split.ratio}; flex-basis: 0;">
        {#key split.a}
          <Self nodeId={split.a} />
        {/key}
      </div>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="divider"
        role="separator"
        aria-orientation={split.direction === "row" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(split.ratio * 100)}
        tabindex="0"
        onmousedown={(e) => startResize(e, split)}
      ></div>
      <div class="half" style="flex-grow: {1 - split.ratio}; flex-basis: 0;">
        {#key split.b}
          <Self nodeId={split.b} />
        {/key}
      </div>
    </div>
  {/if}
{/if}

<style>
  .split { display: flex; flex: 1; min-height: 0; min-width: 0; }
  .split.row { flex-direction: row; }
  .split.column { flex-direction: column; }
  /* Wrapper around each child of a split. Inherits the split's
     flex-direction so the inner Pane (or nested split) sizes its
     cross-axis correctly. min-* prevents children from forcing the
     wrapper to grow past its assigned share. */
  .half {
    display: flex;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .split.row > .half { flex-direction: row; }
  .split.column > .half { flex-direction: column; }
  /* Pane divider: visually invisible. The pane chrome (margin +
     shadow) already gives the two halves their own visual frame, so a
     hard border between them would just add noise. The hit area,
     cursor, and the grab-friendly hover widening are preserved so
     drag-to-resize keeps the same feel; only the painted bar is
     omitted. */
  .divider {
    background: transparent;
    flex-shrink: 0;
  }
  .split.row > .divider { width: 4px; cursor: col-resize; }
  .split.column > .divider { height: 4px; cursor: row-resize; }
  /* Slightly fatter hover hit-area so the divider is easier to grab. */
  .split.row > .divider:hover    { width: 6px; }
  .split.column > .divider:hover { height: 6px; }
</style>
