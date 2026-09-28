<script lang="ts">
  // Shared shell for the floating overlays (search, graph, files,
  // settings). Owns the parts every overlay needs to be the same:
  //
  //   - dim backdrop layer that closes on click,
  //   - centered panel container that swallows clicks (so a click
  //     inside the panel doesn't bubble up and trigger close),
  //   - z-index sits above every other UI layer and rises with the
  //     overlay's depth in the global stack so a freshly-opened
  //     overlay paints over the one it was opened from.
  //
  // Escape handling lives in App.svelte, not here: a per-shell
  // listener fired once per mounted-open overlay and closed every
  // open overlay on a single press. The window-level handler closes
  // the topmost overlay only (see `topOverlay`).
  //
  // The overlay's body content goes through the `children` snippet
  // and renders inside the panel; the wrapped overlay owns its
  // own header + body + footer.
  //
  // Size: every overlay fills the full viewport vertically with a
  // uniform margin (reserved by .overlay's padding) on every side.
  // The panel grows to take all the height available between the
  // top and bottom paddings rather than hugging the bottom of the
  // viewport. The width prop caps the cross-axis; overrides land in
  // narrower panels.

  import type { Snippet } from "svelte";
  import { overlayDepth, type OverlayId } from "../state/store.svelte";
  import { overlayMaximized } from "../state/pageWidth.svelte";
  // Each wrapped overlay renders its own maximize/restore + close
  // chrome inside its header (left and right edges respectively),
  // so this shell only provides the backdrop, the panel container,
  // and the depth-based z-index.

  let {
    id,
    open,
    onClose,
    onBackdropContextMenu,
    width,
    align = "stretch",
    lifted = false,
    label,
    children,
  }: {
    id: OverlayId;
    open: boolean;
    onClose: () => void;
    onBackdropContextMenu?: (e: MouseEvent) => void;
    width?: string;
    // Vertical anchoring. "stretch" fills the viewport height (the
    // full-height overlays). "top" pins an auto-height panel near the
    // top. "center" places an auto-height panel in the viewport center.
    align?: "stretch" | "top" | "center";
    // Centered auto-height overlays can opt into a lifted resting
    // position when their content expands below the main input.
    lifted?: boolean;
    // The overlay's accessible name.
    label: string;
    children: Snippet;
  } = $props();

  // The element that held focus when the overlay opened. Closing hands focus
  // back to it when nothing else took it: focus left on the body or on an
  // element that went with the panel returns, and a caller that moved focus
  // on (an opened file) keeps it.
  let returnFocus: HTMLElement | null = null;
  $effect.pre(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => {
      const target = returnFocus;
      returnFocus = null;
      queueMicrotask(() => {
        const current = document.activeElement;
        const fell = current === null || current === document.body || !current.isConnected;
        if (target?.isConnected && fell) {
          target.focus({ preventScroll: true });
        }
      });
    };
  });

  // 10-step gap per depth so any same-overlay sub-layers (popovers,
  // dropdowns) still have room above their parent without spilling
  // into the next overlay's slot. Closed (depth -1) collapses to the
  // base z-index, but the `{#if open}` below means we never paint
  // anything in that state anyway.
  const zIndex = $derived(25000 + Math.max(0, overlayDepth(id)) * 10);

  // Resolved panel width. An explicit `width` prop from the caller
  // wins (no overlay sets one today, but the override stays useful
  // for narrower future surfaces). Otherwise we honor the global
  // overlay-maximize toggle: 1200px cap by default, full viewport
  // minus a symmetric 44px gutter when maximized so the side margin
  // matches the top safe-area + chrome buffer.
  const resolvedWidth = $derived(
    width ??
      (overlayMaximized.on
        ? "calc(100vw - 88px)"
        : "min(1200px, calc(100vw - 48px))"),
  );

  function onContextMenu(e: MouseEvent): void {
    if (!onBackdropContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onBackdropContextMenu(e);
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    class:top={align === "top"}
    class:center={align === "center"}
    style="z-index: {zIndex};"
    onclick={onClose}
    oncontextmenu={onContextMenu}
  >
    <div
      class="panel"
      class:lifted
      style="width: {resolvedWidth};"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
    >
      {@render children()}
    </div>
  </div>
{/if}

<style>
  /* Full-viewport panel with uniform margin on every side. The
     panel itself is bound by .overlay's padding; .panel's flex:1
     in the cross axis (height) lets it grow to fill the available
     vertical space between top and bottom paddings rather than
     hugging the viewport bottom. */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    justify-content: center;
    align-items: stretch;
    /* Symmetric top/bottom gutter. iOS draws the status bar OVER
       the WebView (viewport-fit=cover); the safe-area-inset-top
       branch of max() clears the notch on those devices while the
       24px floor matches the bottom gutter on desktop / non-notched
       viewports. The in-panel chrome (maximize on the left, close
       on the right of each overlay's own header) lives below this
       padding so it's never under the status bar. */
    padding-top: max(env(safe-area-inset-top, 0px), 24px);
    padding-bottom: max(env(safe-area-inset-bottom, 0px), 24px);
    /* Side padding is set narrow on the .overlay; the panel's
       width prop (capped at 1200px) handles wide-viewport
       letterboxing. The padding here just guarantees a minimum
       gutter on phones / narrow windows where the width prop
       would otherwise hit 100vw. */
    padding-left: 16px;
    padding-right: 16px;
    /* z-index is bound inline from the overlay stack depth so a
       freshly-opened overlay paints above the one underneath. */
    box-sizing: border-box;
    /* iOS WKWebView only fires `click` on non-button elements that
       have `cursor: pointer` declared. Without this the scrim taps
       silently no-op and overlays look stuck. */
    cursor: pointer;
  }
  /* Auto-height variants: the panel takes its content height instead
     of stretching to fill the viewport. */
  .overlay.top {
    align-items: flex-start;
    padding-top: max(env(safe-area-inset-top, 0px), 10vh);
  }
  .overlay.center {
    align-items: center;
  }
  /* Dim the workspace behind the launcher and top-anchored overlays
     with a plain dark scrim, not a backdrop blur, so what is behind
     the panel stays readable. The value sits just under the
     full-cover overlays' scrim because the launcher's small capsule
     leaves this scrim visible across the whole viewport. */
  .overlay.top,
  .overlay.center {
    background: rgba(0, 0, 0, 0.4);
  }
  .panel {
    background: var(--bg-elev);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Match the menu / tab-menu bounce so every overlay shares the
       same open feel. The hover transition takes over once the
       open animation finishes, mirroring the floating chrome
       (BottomPill / WikiStatusBar / AppStatusBar) so the panels
       feel alive instead of inert. */
    transform-origin: center top;
    animation: overlay-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    transition:
      transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 160ms ease;
  }
  /* Much subtler scale than the pills (1.04). Panels are big; even
     a 1% factor shoves the whole modal more than it needs to. Half
     a percent is enough to read as a lift on cursor enter without
     making the panel feel restless. */
  .panel:hover {
    transform: scale(1.005);
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.52);
  }
  .overlay.top .panel,
  .overlay.center .panel {
    background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
    border-color: color-mix(in srgb, var(--border) 72%, transparent);
    border-radius: 30px;
    box-shadow:
      0 22px 70px rgba(0, 0, 0, 0.38),
      0 1px 0 color-mix(in srgb, var(--text) 12%, transparent) inset;
    -webkit-backdrop-filter: blur(24px) saturate(1.12);
    backdrop-filter: blur(24px) saturate(1.12);
    animation: spotlight-pop 300ms cubic-bezier(0.2, 0.85, 0.22, 1.1);
  }
  .overlay.center .panel {
    transform-origin: center;
  }
  .overlay.top .panel:hover,
  .overlay.center .panel:hover {
    transform: none;
    box-shadow:
      0 24px 76px rgba(0, 0, 0, 0.4),
      0 1px 0 color-mix(in srgb, var(--text) 12%, transparent) inset;
  }
  .overlay.center .panel.lifted,
  .overlay.center .panel.lifted:hover {
    transform: translateY(-9vh);
  }
  @keyframes overlay-pop {
    0% {
      opacity: 0;
      transform: scale(0.92);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  @keyframes spotlight-pop {
    0% {
      opacity: 0;
      transform: translateY(-10px) scaleX(1.08) scaleY(0.96);
      filter: blur(14px);
    }
    100% {
      opacity: 1;
      transform: translateY(0) scaleX(1) scaleY(1);
      filter: blur(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .panel,
    .panel:hover,
    .overlay.top .panel,
    .overlay.top .panel:hover,
    .overlay.center .panel,
    .overlay.center .panel:hover {
      animation: none;
      transition: none;
      transform: none;
    }
    .overlay.center .panel.lifted,
    .overlay.center .panel.lifted:hover {
      transform: translateY(-9vh);
    }
  }
</style>
