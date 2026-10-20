<script lang="ts">
  // Empty single-pane welcome surface: the chan mark for a moment, then a
  // decorative field. Its animation keys are local to this focused
  // surface; app shortcuts remain owned by the existing document-level
  // shortcut path. Only mounted when a lone, non-terminal pane has no tabs
  // on either side (see Pane.svelte), so it needs no terminal-window branch.
  //
  // The field starts after a delay. A new window's pane is empty until its
  // first tab arrives, and a welcome that drew at once would flash there
  // and spend a canvas, a context and its shaders on a surface about to be
  // replaced. The mark fills that delay instead: it fades in as soon as
  // the pane is shown and fades out so that it is gone when the field
  // arrives. A later animation switch shows no mark, and a welcome that
  // starts at once (no delay) never shows one.
  //
  // Which animations it draws follows the page's WebGL renderer (see
  // emptyPaneAnimationChoices). An animation named by the caller is shown
  // as given.

  import { onMount, untrack, type Component } from "svelte";
  import AmberRecursion from "./AmberRecursion.svelte";
  import BeadedTorus from "./BeadedTorus.svelte";
  import BranchingWreath from "./BranchingWreath.svelte";
  import ChaoticHalo from "./ChaoticHalo.svelte";
  import ConcentricPulse from "./ConcentricPulse.svelte";
  import CosmicBell from "./CosmicBell.svelte";
  import DottedSurface from "./DottedSurface.svelte";
  import DriftingGalaxy from "./DriftingGalaxy.svelte";
  import EightfoldCoil from "./EightfoldCoil.svelte";
  import ExponentialEcho from "./ExponentialEcho.svelte";
  import ExponentialThread from "./ExponentialThread.svelte";
  import FourteenfoldBloom from "./FourteenfoldBloom.svelte";
  import {
    EMPTY_PANE_ANIMATION_START_DELAY_MS,
    EMPTY_PANE_MARK_FADE_MS,
    emptyPaneAnimationChoices,
    emptyPaneAnimationName,
    emptyPaneAnimationSpeedLabel,
    initialEmptyPaneAnimation,
    persistEmptyPaneAnimation,
    randomEmptyPaneAnimation,
    stepEmptyPaneAnimation,
    stepEmptyPaneAnimationSpeed,
    type EmptyPaneAnimationId,
  } from "./emptyPaneAnimations";
  import HexagonalBloom from "./HexagonalBloom.svelte";
  import LorenzConstellation from "./LorenzConstellation.svelte";
  import MutualForceStarburst from "./MutualForceStarburst.svelte";
  import NinefoldLotus from "./NinefoldLotus.svelte";
  import OrbitalRosette from "./OrbitalRosette.svelte";
  import PolarDrift from "./PolarDrift.svelte";
  import QuadraticBloom from "./QuadraticBloom.svelte";
  import RadialRibbons from "./RadialRibbons.svelte";
  import RecursiveArcBloom from "./RecursiveArcBloom.svelte";
  import RippledDuet from "./RippledDuet.svelte";
  import SegmentedTorus from "./SegmentedTorus.svelte";
  import SixfoldVortex from "./SixfoldVortex.svelte";
  import SpiralFountain from "./SpiralFountain.svelte";
  import SpiralSpokes from "./SpiralSpokes.svelte";
  import StellarOutburst from "./StellarOutburst.svelte";
  import StriatedCurrent from "./StriatedCurrent.svelte";
  import TenfoldDahlia from "./TenfoldDahlia.svelte";
  import ThreefoldVeil from "./ThreefoldVeil.svelte";
  import TurbulentOculus from "./TurbulentOculus.svelte";
  import TwinVeilDance from "./TwinVeilDance.svelte";
  import TwistingSwarm from "./TwistingSwarm.svelte";
  import { pageWebglRenderer } from "./webglRenderer";

  import SwayingBranches from "./SwayingBranches.svelte";



  const ANIMATION_COMPONENTS = {
    "sixfold-vortex": SixfoldVortex,
    "radial-ribbons": RadialRibbons,
    "polar-drift": PolarDrift,
    "concentric-pulse": ConcentricPulse,
    "exponential-thread": ExponentialThread,
    "exponential-echo": ExponentialEcho,
    "quadratic-bloom": QuadraticBloom,
    "orbital-rosette": OrbitalRosette,
    "dotted-waves": DottedSurface,
    "spiral-spokes": SpiralSpokes,
    "mutual-force-starburst": MutualForceStarburst,
    "recursive-arc-bloom": RecursiveArcBloom,
    "chaotic-halo": ChaoticHalo,
    "threefold-veil": ThreefoldVeil,
    "striated-current": StriatedCurrent,
    "lorenz-constellation": LorenzConstellation,
    "twin-veil-dance": TwinVeilDance,
    "rippled-duet": RippledDuet,
    "fourteenfold-bloom": FourteenfoldBloom,
    "hexagonal-bloom": HexagonalBloom,
    "turbulent-oculus": TurbulentOculus,
    "stellar-outburst": StellarOutburst,
    "amber-recursion": AmberRecursion,
    "tenfold-dahlia": TenfoldDahlia,
    "beaded-torus": BeadedTorus,
    "spiral-fountain": SpiralFountain,
    "twisting-swarm": TwistingSwarm,
    "branching-wreath": BranchingWreath,
    "drifting-galaxy": DriftingGalaxy,
    "ninefold-lotus": NinefoldLotus,
    "eightfold-coil": EightfoldCoil,
    "cosmic-bell": CosmicBell,
    "segmented-torus": SegmentedTorus,
    "swaying-branches": SwayingBranches,
  } satisfies Record<EmptyPaneAnimationId, Component>;

  let {
    animation = $bindable(),
    startDelayMs = EMPTY_PANE_ANIMATION_START_DELAY_MS,
  }: {
    animation?: EmptyPaneAnimationId;
    startDelayMs?: number;
  } = $props();

  // Called from the start on, never before: reading the page's renderer
  // creates a WebGL2 context.
  function choices() {
    return emptyPaneAnimationChoices(pageWebglRenderer().kind);
  }

  function firstChoice(): EmptyPaneAnimationId {
    return initialEmptyPaneAnimation(undefined, undefined, choices());
  }

  // False until the delay has passed. Nothing is chosen, saved or drawn
  // before then, so a pane replaced within the delay leaves no trace.
  const startsAtOnce = untrack(() => startDelayMs) <= 0;
  let started = $state(startsAtOnce);
  if (startsAtOnce) animation ??= firstChoice();

  let welcome = $state<HTMLDivElement | undefined>();
  let speed = $state(1);
  let animationNameFlash = $state<string | null>(null);
  let animationNameFlashSequence = $state(0);
  // When the mark's fade-out begins, so that it ends as the field starts.
  let markOutDelayMs = $derived(
    Math.max(0, startDelayMs - EMPTY_PANE_MARK_FADE_MS),
  );
  let ActiveAnimation = $derived(
    started && animation ? ANIMATION_COMPONENTS[animation] : null,
  );

  onMount(() => {
    if (startsAtOnce) return;
    const timer = setTimeout(() => {
      animation ??= firstChoice();
      started = true;
    }, startDelayMs);
    return () => clearTimeout(timer);
  });

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

  function selectSpeed(direction: -1 | 1): void {
    speed = stepEmptyPaneAnimationSpeed(speed, direction);
    animationNameFlash = emptyPaneAnimationSpeedLabel(speed);
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
    if (
      key !== "?" &&
      key !== "ArrowRight" &&
      key !== "ArrowLeft" &&
      key !== "ArrowUp" &&
      key !== "ArrowDown"
    ) {
      return;
    }

    const surface = welcome;
    queueMicrotask(() => {
      // App shortcuts receive the event through their unchanged document
      // listener. If that path claimed it, or this empty surface disappeared
      // because a tab/split opened, the decorative shortcut does nothing.
      // Before the start there is no animation to step or speed up.
      const current = animation;
      if (
        event.defaultPrevented ||
        !surface?.isConnected ||
        document.activeElement !== surface ||
        !started ||
        !current
      ) {
        return;
      }
      if (key === "ArrowRight") {
        selectAnimation(stepEmptyPaneAnimation(current, 1, choices()));
      } else if (key === "ArrowLeft") {
        selectAnimation(stepEmptyPaneAnimation(current, -1, choices()));
      } else if (key === "ArrowUp") {
        selectSpeed(1);
      } else if (key === "ArrowDown") {
        selectSpeed(-1);
      } else {
        selectAnimation(
          randomEmptyPaneAnimation(current, undefined, choices()),
        );
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
  style="--canvas-animation-speed: {speed}; --welcome-mark-fade: {EMPTY_PANE_MARK_FADE_MS}ms; --welcome-mark-out-delay: {markOutDelayMs}ms"
>
  {#if !started}
    <div class="welcome-mark"></div>
  {/if}
  {#if ActiveAnimation}
    <ActiveAnimation />
  {/if}
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
    width: 160px;
    height: 160px;
    background-color: var(--text-secondary);
    -webkit-mask: url('/chan-mark.png') center / contain no-repeat;
            mask: url('/chan-mark.png') center / contain no-repeat;
    opacity: 0;
    /* Two fades over the start delay: in at once, out timed by the surface
       to end as the field starts. Each holds its last frame, and the
       fade-out contributes nothing until its delay has passed, so the mark
       rests at its full presence between them. */
    animation:
      empty-pane-mark-in var(--welcome-mark-fade) ease-out forwards,
      empty-pane-mark-out var(--welcome-mark-fade) ease-in var(--welcome-mark-out-delay) forwards;
  }
  @keyframes empty-pane-mark-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 0.45;
    }
  }
  @keyframes empty-pane-mark-out {
    from {
      opacity: 0.45;
    }
    to {
      opacity: 0;
    }
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
