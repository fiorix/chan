<script lang="ts">
  // Empty single-pane welcome surface: the chan mark over a decorative
  // field. Its animation keys are local to this focused surface; app
  // shortcuts remain owned by the existing document-level shortcut path.
  // Only mounted when a lone, non-terminal pane has no tabs on either side
  // (see Pane.svelte), so it needs no terminal-window branch.

  import type { Component } from "svelte";
  import ChaoticHalo from "./ChaoticHalo.svelte";
  import ConcentricPulse from "./ConcentricPulse.svelte";
  import DottedSurface from "./DottedSurface.svelte";
  import ExponentialEcho from "./ExponentialEcho.svelte";
  import ExponentialThread from "./ExponentialThread.svelte";
  import {
    emptyPaneAnimationName,
    initialEmptyPaneAnimation,
    persistEmptyPaneAnimation,
    randomEmptyPaneAnimation,
    stepEmptyPaneAnimation,
    type EmptyPaneAnimationId,
  } from "./emptyPaneAnimations";
  import MutualForceStarburst from "./MutualForceStarburst.svelte";
  import OrbitalRosette from "./OrbitalRosette.svelte";
  import PenguinGrid from "./PenguinGrid.svelte";
  import PolarDrift from "./PolarDrift.svelte";
  import QuadraticBloom from "./QuadraticBloom.svelte";
  import RadialRibbons from "./RadialRibbons.svelte";
  import RecursiveArcBloom from "./RecursiveArcBloom.svelte";
  import SixfoldVortex from "./SixfoldVortex.svelte";
  import SpiralSpokes from "./SpiralSpokes.svelte";

  const ANIMATION_COMPONENTS = {
    "sixfold-vortex": SixfoldVortex,
    "radial-ribbons": RadialRibbons,
    "polar-drift": PolarDrift,
    "concentric-pulse": ConcentricPulse,
    "penguin-grid": PenguinGrid,
    "exponential-thread": ExponentialThread,
    "exponential-echo": ExponentialEcho,
    "quadratic-bloom": QuadraticBloom,
    "orbital-rosette": OrbitalRosette,
    "dotted-waves": DottedSurface,
    "spiral-spokes": SpiralSpokes,
    "mutual-force-starburst": MutualForceStarburst,
    "recursive-arc-bloom": RecursiveArcBloom,
    "chaotic-halo": ChaoticHalo,
  } satisfies Record<EmptyPaneAnimationId, Component>;

  let {
    animation = initialEmptyPaneAnimation(),
  }: {
    animation?: EmptyPaneAnimationId;
  } = $props();

  let welcome = $state<HTMLDivElement | undefined>();
  let animationNameFlash = $state<string | null>(null);
  let animationNameFlashSequence = $state(0);
  let ActiveAnimation = $derived(ANIMATION_COMPONENTS[animation]);

  $effect(() => {
    const surface = welcome;
    if (!surface) return;
    queueMicrotask(() => {
      if (surface.isConnected && document.activeElement === document.body) {
        surface.focus({ preventScroll: true });
      }
    });
  });

  function selectAnimation(next: EmptyPaneAnimationId): void {
    animation = next;
    persistEmptyPaneAnimation(next);
    animationNameFlash = emptyPaneAnimationName(next);
    animationNameFlashSequence += 1;
  }

  function onAnimationNameFlashEnd(event: AnimationEvent): void {
    if (
      event.animationName.includes("empty-pane-animation-name-flash")
    ) {
      animationNameFlash = null;
    }
  }

  function onAnimationKeyDown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    const key = event.key;
    if (key !== ">" && key !== "<" && key !== "?") return;

    const surface = welcome;
    queueMicrotask(() => {
      // App shortcuts receive the event through their unchanged document
      // listener. If that path claimed it, or this empty surface disappeared
      // because a tab/split opened, the decorative shortcut does nothing.
      if (
        event.defaultPrevented ||
        !surface?.isConnected ||
        document.activeElement !== surface
      ) {
        return;
      }
      if (key === ">") {
        selectAnimation(stepEmptyPaneAnimation(animation, 1));
      } else if (key === "<") {
        selectAnimation(stepEmptyPaneAnimation(animation, -1));
      } else {
        selectAnimation(randomEmptyPaneAnimation(animation));
      }
    });
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="welcome"
  role="region"
  aria-label="welcome"
  tabindex="0"
  bind:this={welcome}
  onkeydown={onAnimationKeyDown}
>
  <ActiveAnimation />
  <div class="welcome-mark"></div>
  {#if animationNameFlash}
    {#key animationNameFlashSequence}
      <div
        class="animation-name-flash"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onanimationend={onAnimationNameFlashEnd}
      >
        {animationNameFlash}
      </div>
    {/key}
  {/if}
</div>

<style>
  .welcome {
    flex: 1;
    min-height: 0;
    align-self: stretch;
    width: 100%;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem;
    outline: none;
    overflow: hidden;
    isolation: isolate;
    /* Pane-aware sizing for the mark: the surface is its own query
       container so the mark hides per pane in splits, not per window. */
    container-type: size;
  }
  .welcome-mark {
    position: relative;
    z-index: 1;
    width: 160px;
    height: 160px;
    background-color: var(--text-secondary);
    -webkit-mask: url('/chan-mark.png') center / contain no-repeat;
            mask: url('/chan-mark.png') center / contain no-repeat;
    opacity: 0.45;
  }
  .animation-name-flash {
    position: absolute;
    left: 50%;
    bottom: clamp(24px, 6%, 64px);
    z-index: 2;
    max-width: calc(100% - 4rem);
    color: color-mix(in srgb, var(--text) 72%, transparent);
    font-size: 18px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.04em;
    white-space: nowrap;
    pointer-events: none;
    animation: empty-pane-animation-name-flash 1100ms ease-in-out;
  }
  @keyframes empty-pane-animation-name-flash {
    0% {
      opacity: 0;
      transform: translate(-50%, 6px) scale(0.96);
    }
    18%,
    70% {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }
    100% {
      opacity: 0;
      transform: translate(-50%, 0) scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .animation-name-flash {
      animation-name: empty-pane-animation-name-flash-reduced;
    }
  }
  @keyframes empty-pane-animation-name-flash-reduced {
    0%,
    100% {
      opacity: 0;
      transform: translateX(-50%);
    }
    10%,
    80% {
      opacity: 1;
      transform: translateX(-50%);
    }
  }
  /* Short panes drop the mark so the wave field keeps breathing room;
     it reappears the moment the pane grows back. */
  @container (max-height: 420px) {
    .welcome-mark {
      display: none;
    }
  }
</style>
