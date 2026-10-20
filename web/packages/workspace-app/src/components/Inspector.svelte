<script lang="ts">
  import type { Snippet } from "svelte";
  import { ArrowLeft, ArrowRight, X } from "lucide-svelte";
  import ResizeHandle from "./ResizeHandle.svelte";

  let {
    title,
    width = $bindable(220),
    side = "right",
    floating = false,
    onResize,
    onClose,
    children,
  }: {
    title: string;
    width?: number;
    side?: "left" | "right";
    floating?: boolean;
    onResize?: () => void;
    onClose?: () => void;
    children?: Snippet;
  } = $props();

  let frame: HTMLElement;
  let drag: { pointer: number; x: number; width: number } | null = null;

  function resize(next: number): void {
    const available = frame.parentElement?.clientWidth || 624;
    width = Math.max(Math.min(180, available - 24), Math.min(480, available - 24, next));
    onResize?.();
  }

  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, x: event.clientX, width: frame.getBoundingClientRect().width || width };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    resize(drag.width + (event.clientX - drag.x) * (side === "left" ? 1 : -1));
  }

  function endResize(event: PointerEvent): void {
    if (event.pointerId === drag?.pointer) drag = null;
  }

  function keyResize(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === "ArrowRight" ? 10 : -10) * (side === "left" ? 1 : -1);
    resize((frame.getBoundingClientRect().width || width) + delta);
  }

  function keyClose(event: KeyboardEvent): void {
    if (!floating || !onClose || event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }
</script>

{#if !floating && side === "right"}
  <ResizeHandle bind:width onChange={onResize} />
{/if}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="inspector {side}" class:floating style="width: {width}px" bind:this={frame} aria-label={title} onkeydown={keyClose}>
  {#if floating}
    <button class="floating-resize" type="button" aria-label="Resize {title}" title="Drag to resize; use left and right arrow keys"
      onpointerdown={startResize} onpointermove={moveResize} onpointerup={endResize} onpointercancel={endResize} onlostpointercapture={endResize} onkeydown={keyResize}></button>
  {/if}
  <div class="title">
    <span class="title-text">{title}</span>
    {#if onClose}
      <button class="close" type="button" title="Close" aria-label="Close {title}" onclick={onClose}>
        {#if floating}<X size={16} strokeWidth={1.75} aria-hidden="true" />
        {:else if side === "left"}<ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        {:else}<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
      </button>
    {/if}
  </div>
  <div class="body">
    {#if children}{@render children()}{/if}
  </div>
</aside>
{#if !floating && side === "left"}
  <ResizeHandle bind:width onChange={onResize} side="left" />
{/if}

<style>
  .inspector {
    /* width is set inline by the parent so the resize handle's
       drag updates apply without a CSS rule rewrite. */
    flex-shrink: 0;
    background: var(--inspector-bg);
    color: var(--text);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    font-size: 15px;
  }
  .inspector.right {
    border-left: 1px solid var(--separator);
  }
  .inspector.left {
    border-right: 1px solid var(--separator);
  }
  .title {
    padding: 0.4rem 0.6rem;
    font-size: 14px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--separator);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .title-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.15rem 0.25rem;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .close:hover {
    background: var(--hover-bg, rgba(127, 127, 127, 0.15));
    color: var(--text);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .inspector.floating {
    box-sizing: border-box;
    background: var(--bg-elev);
    position: absolute;
    top: 12px;
    bottom: 12px;
    max-width: calc(100% - 24px);
    z-index: 20;
    overflow: visible;
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
  }
  .floating.left { left: 12px; }
  .floating.right { right: 12px; }
  .floating .title {
    padding: 10px 12px 6px;
    border: 0;
    text-transform: none;
    letter-spacing: normal;
    font-size: 13px;
  }
  .floating .body { overflow: auto; border-radius: 0 0 10px 10px; }
  .floating-resize {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
    border-radius: 4px;
    z-index: 1;
  }
  .left .floating-resize { right: -3px; }
  .right .floating-resize { left: -3px; }
  .floating-resize:hover, .floating-resize:focus-visible { background: var(--link); }
</style>
