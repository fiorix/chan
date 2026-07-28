<script lang="ts">
  // Empty single-pane welcome surface: the chan mark over a decorative
  // field. It carries no actions of its own; app
  // spawns live in the pane hamburger's Apps rows and the command
  // launcher (menu or global chord).
  // Only mounted for a lone, non-terminal pane (see Pane.svelte), so it
  // needs no terminal-window branch.

  import type { Component } from "svelte";
  import ConcentricPulse from "./ConcentricPulse.svelte";
  import DottedSurface from "./DottedSurface.svelte";
  import ExponentialThread from "./ExponentialThread.svelte";
  import {
    emptyPaneAnimationName,
    initialEmptyPaneAnimation,
    persistEmptyPaneAnimation,
    randomEmptyPaneAnimation,
    stepEmptyPaneAnimation,
    type EmptyPaneAnimationId,
  } from "./emptyPaneAnimations";
  import OrbitalRosette from "./OrbitalRosette.svelte";
  import PenguinGrid from "./PenguinGrid.svelte";
  import PolarDrift from "./PolarDrift.svelte";
  import QuadraticBloom from "./QuadraticBloom.svelte";
  import RadialRibbons from "./RadialRibbons.svelte";
  import SixfoldVortex from "./SixfoldVortex.svelte";

  const ANIMATION_COMPONENTS = {
    "sixfold-vortex": SixfoldVortex,
    "radial-ribbons": RadialRibbons,
    "polar-drift": PolarDrift,
    "concentric-pulse": ConcentricPulse,
    "penguin-grid": PenguinGrid,
    "exponential-thread": ExponentialThread,
    "quadratic-bloom": QuadraticBloom,
    "orbital-rosette": OrbitalRosette,
    "dotted-waves": DottedSurface,
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
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== welcome
    ) {
      return;
    }

    if (event.key === ">") {
      event.preventDefault();
      selectAnimation(stepEmptyPaneAnimation(animation, 1));
    } else if (event.key === "<") {
      event.preventDefault();
      selectAnimation(stepEmptyPaneAnimation(animation, -1));
    } else if (event.key === "?") {
      event.preventDefault();
      selectAnimation(randomEmptyPaneAnimation(animation));
    }
  }
</script>

<svelte:window onkeydown={onAnimationKeyDown} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="welcome"
  role="region"
  aria-label="welcome"
  tabindex="0"
  bind:this={welcome}
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
