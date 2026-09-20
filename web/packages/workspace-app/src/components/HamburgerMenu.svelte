<script lang="ts">
  // Shared hamburger trigger + bubble popover for overlay headers.
  // The file browser, search, and graph overlays each carry the same
  // affordance: a single (≡) button on the left edge of the title
  // bar that opens a vertically-stacked bubble menu, plus a matching
  // right-click context menu on the overlay body. Both surfaces feed
  // the same item list via the `children` snippet so caller adds new
  // actions in one place.
  //
  // Caller supplies:
  //   - `open` (bindable) - true while the popover is up
  //   - `width` (estimate, for off-screen clamping; defaults to 240px)
  //   - `height` (estimate; controls below-vs-above flip)
  //   - `children` - the <li> rows of the menu (the caller controls
  //     content + per-row click handlers)
  //
  // Two opener APIs:
  //   - `openFromTrigger(el)` - measure the trigger button and anchor
  //     the popover to its bottom-right.
  //   - `openAtCursor(x, y)` - anchor at the cursor, used by the
  //     parent's `oncontextmenu` so right-click feels native.

  import type { Snippet } from "svelte";
  import { clampToViewport, triggerMenuX } from "./menuClamp";
  import { portal } from "./portal";

  let {
    open = $bindable(false),
    width = 240,
    height = 256,
    showTrigger = true,
    onBeforeOpen,
    children,
  }: {
    open?: boolean;
    width?: number;
    height?: number;
    /// Drop the trigger button when the menu is opened only via
    /// `openAtCursor` (e.g. a right-click handler in the parent).
    /// The bubble still portals to <body> and dismisses on outside
    /// click as usual.
    showTrigger?: boolean;
    onBeforeOpen?: () => void;
    children?: Snippet;
  } = $props();

  let pos = $state<{ top: number; left: number }>({ top: 0, left: 0 });
  let triggerEl: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLElement | undefined = $state();

  /// Two-phase placement: first paint at the estimated position so
  /// the bubble doesn't pop in at (0,0); then, once mounted, measure
  /// its REAL bounding box and re-clamp into the viewport. The
  /// estimated `width` / `height` props are only used for the first
  /// frame - actual content size wins thereafter.
  const TRIGGER_GAP = 6;

  /// Live anchor for a trigger-opened menu: below the trigger's bottom,
  /// X aligned per triggerMenuX. Re-derived from a fresh bounding box so
  /// refineAfterMount can pick up a trigger whose transform (a pane flip
  /// or hover-scale in flight at click time) has settled since.
  function triggerAnchor(): { x: number; y: number } | null {
    if (!triggerEl) return null;
    const r = triggerEl.getBoundingClientRect();
    return { x: triggerMenuX(r, width), y: r.bottom + TRIGGER_GAP };
  }

  function placeNearCursor(x: number, y: number): void {
    pos = clampToViewport(width, height, { x, y });
    refineAfterMount(() => ({ x, y }));
  }

  /// Open below the trigger's bottom-right corner. The clamp helper
  /// keeps the bubble on-screen if the trigger sits close to the
  /// viewport edge (e.g., when its container is near the right or
  /// bottom of the window).
  function placeUnderTrigger(anchor: { x: number; y: number }): void {
    pos = clampToViewport(width, height, anchor);
    refineAfterMount(() => triggerAnchor() ?? anchor);
  }

  /// After the bubble renders, swap the estimated size for the real one
  /// and re-clamp against a freshly resolved anchor. Runs at next-frame
  /// to catch the painted box and any settled trigger transform.
  function refineAfterMount(anchor: () => { x: number; y: number }): void {
    requestAnimationFrame(() => {
      if (!menuEl) return;
      const r = menuEl.getBoundingClientRect();
      pos = clampToViewport(r.width, r.height, anchor());
    });
  }

  export function openFromTrigger(): void {
    if (open) {
      open = false;
      return;
    }
    const anchor = triggerAnchor();
    if (!anchor) {
      onBeforeOpen?.();
      open = true;
      return;
    }
    onBeforeOpen?.();
    placeUnderTrigger(anchor);
    open = true;
  }

  export function openAtCursor(x: number, y: number): void {
    onBeforeOpen?.();
    placeNearCursor(x, y);
    open = true;
  }

  export function close(): void {
    open = false;
  }

  function onWindowMousedown(e: MouseEvent): void {
    if (!open) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(".hamburger-menu, .hamburger-trigger")) return;
    open = false;
  }

  /// An open menu owns Escape: it closes the menu and nothing else, and focus
  /// goes back to the control that opened it.
  ///
  /// Capture, and stopping propagation, because the app's own Escape handler
  /// is a document listener that would otherwise run first and pop whatever
  /// overlay the menu is sitting on. A menu opened at the cursor has no
  /// trigger to return to, so focus stays where it is.
  function onWindowKeyCapture(e: KeyboardEvent): void {
    if (!open || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    open = false;
    triggerEl?.focus();
  }
</script>

<svelte:window onmousedown={onWindowMousedown} onkeydowncapture={onWindowKeyCapture} />

{#if showTrigger}
  <button
    bind:this={triggerEl}
    class="hamburger-trigger hbtn"
    class:on={open}
    type="button"
    title="Menu"
    aria-label="Menu"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={openFromTrigger}
  >⋮</button>
{/if}

{#if open}
  <!-- Portal the bubble out to <body> so it pins to the viewport
       even when an ancestor (OverlayShell's .panel) has a transform
       set, which would otherwise make `position: fixed` resolve
       relative to that ancestor (the "menu lands ~8cm away from
       the click" bug). -->
  <ul
    bind:this={menuEl}
    class="hamburger-menu"
    role="menu"
    style="top: {pos.top}px; left: {pos.left}px; min-width: {width}px;"
    use:portal
  >
    {#if children}
      {@render children()}
    {/if}
  </ul>
{/if}

<style>
  .hamburger-trigger {
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    color: var(--text);
    font: inherit;
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    padding: 0 7px;
    height: 24px;
    flex-shrink: 0;
  }
  .hamburger-trigger:hover {
    color: var(--text);
    border-color: var(--btn-border);
  }
  .hamburger-trigger.on {
    color: var(--text);
    border-color: var(--btn-hover);
    background: var(--hover-bg);
  }
  /* Bubble popover. Matches the editor tab-menu bubble's
     bouncy reveal and hover scale so all three overlays read as the
     same affordance. */
  .hamburger-menu {
    position: fixed;
    z-index: 29000;
    margin: 0;
    padding: 6px;
    list-style: none;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    font-size: 13px;
    color: var(--text);
    transform-origin: top left;
    animation: hamburger-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .hamburger-menu:hover {
    transform: scale(1.015);
  }
  @keyframes hamburger-pop {
    0% { opacity: 0; transform: scale(0.92); }
    100% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .hamburger-menu { animation: none; transition: none; }
    .hamburger-menu:hover { transform: none; }
  }
  /* Row styling is exposed so per-overlay <li> contents can stay
     terse - they only emit icon + label. Shared cap on hover bg
     and svg sizing for consistency. */
  :global(.hamburger-menu li) { margin: 0; }
  :global(.hamburger-menu li.sep) {
    height: 1px;
    background: var(--separator, var(--border));
    margin: 4px 2px;
  }
  :global(.hamburger-menu button) {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 4px;
    color: var(--text);
    padding: 6px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    transform-origin: left center;
    transition:
      background 80ms ease,
      color 80ms ease,
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  :global(.hamburger-menu button:hover:not(:disabled)) {
    background: var(--hover-bg);
    color: var(--text);
    transform: scale(1.02);
  }
  :global(.hamburger-menu button:disabled) {
    cursor: default;
    opacity: 0.6;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.hamburger-menu button) {
      transition: background 80ms ease, color 80ms ease;
    }
    :global(.hamburger-menu button:hover:not(:disabled)) {
      transform: none;
    }
  }
  :global(.hamburger-menu svg) {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  :global(.hamburger-menu .glyph) {
    width: 14px;
    text-align: center;
    color: var(--text-secondary);
    flex-shrink: 0;
    font-size: 14px;
    line-height: 1;
  }
  /* Two-column row layout used inside HamburgerMenu rows: label
     flush-left, chord (Cmd+P, ...) flush-right. Defined globally so
     every overlay menu and the empty-pane menu share one set of
     class names. Rows without a registered chord still render an
     empty `.menu-row-chord` sibling so the right column stays
     vertically aligned. */
  :global(.menu-row-label) {
    flex: 1;
  }
  :global(.menu-row-chord) {
    margin-left: 1.5rem;
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
  }
</style>
