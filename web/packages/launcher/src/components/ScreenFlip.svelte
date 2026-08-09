<script lang="ts">
  // The card shell that turns the launcher's main area over when it swaps
  // between the Computers and Gateways screens. Structure and animation mirror
  // the workspace-app pane's side flip (see lib/flip.ts for the copy
  // rationale): a preserve-3d inner whose ::before back face shows the
  // incoming screen's name, the content face with its backface hidden, and a
  // one-shot -180deg -> 0 turn. The flip is forward-only: every trigger plays
  // the same turn, there is no reverse direction.
  import type { Snippet } from "svelte";
  import {
    FLIP_DURATION_MS,
    flipAxisForElement,
    flipTransforms,
    type FlipAxis,
  } from "../lib/flip";

  interface Props {
    /** Monotonic flip trigger: each increment plays one turn. */
    flips: number;
    /** The incoming screen's name, shown on the back face mid-turn. */
    backLabel: string;
    children: Snippet;
  }

  let { flips, backLabel, children }: Props = $props();

  let el: HTMLElement | null = $state(null);
  let flipActive = $state(false);
  let flipAxis = $state<FlipAxis>("horizontal");
  let startTransform = $state("rotateY(-180deg)");
  let backTransform = $state("rotateY(-180deg)");
  let lastFlips: number | null = null;
  let flipFrame: number | null = null;
  let flipTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFlipHandles(): void {
    if (flipFrame !== null) {
      cancelAnimationFrame(flipFrame);
      flipFrame = null;
    }
    if (flipTimer !== null) {
      clearTimeout(flipTimer);
      flipTimer = null;
    }
  }

  $effect(() => {
    const count = flips;
    if (lastFlips === null) {
      lastFlips = count;
      return;
    }
    if (lastFlips === count) return;
    lastFlips = count;
    const axis = flipAxisForElement(el);
    const t = flipTransforms(axis);
    flipAxis = axis;
    startTransform = t.start;
    backTransform = t.back;
    flipActive = false;
    clearFlipHandles();
    flipFrame = requestAnimationFrame(() => {
      flipFrame = null;
      flipActive = true;
      // animationend clears the class in a real browser; the timer covers
      // jsdom and reduced-motion environments where it never fires.
      flipTimer = setTimeout(() => {
        flipActive = false;
        flipTimer = null;
      }, FLIP_DURATION_MS + 80);
    });
  });

  $effect(() => {
    return () => clearFlipHandles();
  });
</script>

<div
  class="screen-flip"
  class:flipActive={flipActive}
  class:flipHorizontal={flipAxis === "horizontal"}
  class:flipVertical={flipAxis === "vertical"}
  bind:this={el}
  style:--screen-flip-start={startTransform}
  style:--screen-flip-back={backTransform}
  onanimationend={(e) => {
    if (e.animationName.includes("launcher-screen-flip")) flipActive = false;
  }}
>
  <div class="screen-flip-inner" data-flip-label={backLabel}>
    <div class="screen-flip-face">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .screen-flip {
    display: flex;
    flex-direction: column;
    -webkit-transform-style: preserve-3d;
    transform-style: preserve-3d;
  }

  .screen-flip-inner {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    -webkit-transform-style: preserve-3d;
    transform-style: preserve-3d;
  }

  /* The back face: the incoming screen's name on the launcher background,
     hidden at rest so it only shows mid-flip.

     WHY the `visibility` gate rather than `backface-visibility` alone:
     WebKitGTK, the Linux desktop webview, ignores `backface-visibility` on
     every element, pseudo or not. This face is opaque and sits at z-index 2
     over the whole area, so left to the backface hints it covers the
     launcher permanently and the Computers screen renders as a bare
     mirrored label. Painting it only while the turn runs is what keeps it
     off the screen; the backface hints stay for engines that honor them. */
  .screen-flip-inner::before {
    content: attr(data-flip-label);
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-items: center;
    background: var(--bg);
    color: color-mix(in srgb, var(--text) 70%, transparent);
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
    pointer-events: none;
    visibility: hidden;
    transform: var(--screen-flip-back);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }

  .screen-flip-face {
    position: relative;
    z-index: 1;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }

  .screen-flip.flipActive .screen-flip-inner {
    transform-origin: center center;
    will-change: transform;
    animation: launcher-screen-flip 520ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  /* The back face shows for the first stretch of the turn and hands over to
     the content face as the card passes edge-on. The handover sits at 14.43%
     of the duration, not at half of it, because that is where the easing
     above reaches half its progress and the card crosses 90deg; swapping on
     duration instead leaves the label facing the viewer mirrored. The name
     shares no substring with `launcher-screen-flip`, so the `animationend`
     handler that clears the flip class cannot match this animation. */
  .screen-flip.flipActive .screen-flip-inner::before {
    animation: launcher-back-face-turn 520ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  @keyframes launcher-screen-flip {
    0% {
      transform: var(--screen-flip-start);
    }
    100% {
      transform: rotateX(0deg) rotateY(0deg);
    }
  }

  @keyframes launcher-back-face-turn {
    0%,
    14.43% {
      visibility: visible;
    }
    14.44%,
    100% {
      visibility: hidden;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .screen-flip.flipActive .screen-flip-inner,
    .screen-flip.flipActive .screen-flip-inner::before {
      animation: none;
    }
  }
</style>
