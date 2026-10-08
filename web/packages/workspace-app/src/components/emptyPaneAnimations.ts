import type { WebglRendererKind } from "./webglRenderer";

// `runner` is the canvas runner the animation's component draws with: the
// 2D canvas or a WebGL2 context.
export const EMPTY_PANE_ANIMATIONS = [
  {
    id: "sixfold-vortex",
    runner: "webgl2",
    name: "Sixfold Vortex",
    description: "A particle galaxy stirred by six outward-moving vortices.",
  },
  {
    id: "radial-ribbons",
    runner: "2d",
    name: "Radial Ribbons",
    description: "Twenty curved ribbons slowly twisting around the center.",
  },
  {
    id: "polar-drift",
    runner: "webgl2",
    name: "Polar Drift",
    description: "A slow polar current traced by thousands of particles.",
  },
  {
    id: "concentric-pulse",
    runner: "2d",
    name: "Concentric Pulse",
    description: "Breathing polygonal rings that expand across the pane.",
  },
  {
    id: "exponential-thread",
    runner: "2d",
    name: "Exponential Thread",
    description: "A dim, slowly morphing exponential curve.",
  },
  {
    id: "exponential-echo",
    runner: "2d",
    name: "Exponential Echo",
    description: "A growing-frequency curve leaving a tunnel of fading echoes.",
  },
  {
    id: "quadratic-bloom",
    runner: "2d",
    name: "Quadratic Bloom",
    description: "A shifting quadratic attractor drawn as a field of points.",
  },
  {
    id: "orbital-rosette",
    runner: "2d",
    name: "Orbital Rosette",
    description: "Breathing rings of outlined circles around the chan mark.",
  },
  {
    id: "dotted-waves",
    runner: "2d",
    name: "Dotted Waves",
    description: "A perspective field of dots moving in shallow waves.",
  },
  {
    id: "spiral-spokes",
    runner: "2d",
    name: "Spiral Spokes",
    description: "An expanding fan of lines twisting out from the center.",
  },
  {
    id: "mutual-force-starburst",
    runner: "2d",
    name: "Mutual Force Starburst",
    description: "Three hundred particles pulling into a traced starburst.",
  },
  {
    id: "recursive-arc-bloom",
    runner: "2d",
    name: "Recursive Arc Bloom",
    description: "Sixteen chains of alternating arcs breathing in radial symmetry.",
  },
  {
    id: "chaotic-halo",
    runner: "2d",
    name: "Chaotic Halo",
    description: "A dense field of coupled orbits forming a shifting halo.",
  },
  {
    id: "threefold-veil",
    runner: "webgl2",
    name: "Threefold Veil",
    description: "Three point-cloud veils folding around the center.",
  },
  {
    id: "striated-current",
    runner: "webgl2",
    name: "Striated Current",
    description: "A layered filament current flowing across the pane.",
  },
  {
    id: "lorenz-constellation",
    runner: "webgl2",
    name: "Lorenz Constellation",
    description: "Nine projected Lorenz traces orbiting as a constellation.",
  },
  {
    id: "twin-veil-dance",
    runner: "webgl2",
    name: "Twin Veil Dance",
    description: "Two filament veils unfurling around one another.",
  },
  {
    id: "rippled-duet",
    runner: "webgl2",
    name: "Rippled Duet",
    description: "Paired rippling forms turning through the pane.",
  },
  {
    id: "fourteenfold-bloom",
    runner: "webgl2",
    name: "Fourteenfold Bloom",
    description: "A fourteenfold rotational lace bloom with a quiet center.",
  },
  {
    id: "hexagonal-bloom",
    runner: "webgl2",
    name: "Hexagonal Bloom",
    description: "A sixfold rotational lattice breathing around a quiet center.",
  },
  {
    id: "turbulent-oculus",
    runner: "webgl2",
    name: "Turbulent Oculus",
    description: "A mirrored turbulent tunnel folding around a dark central eye.",
  },
  {
    id: "stellar-outburst",
    runner: "webgl2",
    name: "Stellar Outburst",
    description: "A warm particle field radiating from a brilliant central core.",
  },
  {
    id: "amber-recursion",
    runner: "webgl2",
    name: "Amber Recursion",
    description: "A rotating amber fractal lattice folding through mirrored depth.",
  },
  {
    id: "tenfold-dahlia",
    runner: "webgl2",
    name: "Tenfold Dahlia",
    description: "A tenfold fractal flower zooming without end into a bright core.",
  },
  {
    id: "beaded-torus",
    runner: "webgl2",
    name: "Beaded Torus",
    description: "A tilted torus of beads streaming around its ring and tube.",
  },
  {
    id: "spiral-fountain",
    runner: "webgl2",
    name: "Spiral Fountain",
    description: "Discs fired from the center in three turning arms, trailing as they fly.",
  },
  {
    id: "twisting-swarm",
    runner: "webgl2",
    name: "Twisting Swarm",
    description: "A disc of dots swaying on twisted axes, coiling into strands and out again.",
  },
  {
    id: "branching-wreath",
    runner: "webgl2",
    name: "Branching Wreath",
    description: "Ten branching trees fanned into a wreath that folds through itself.",
  },
  {
    id: "drifting-galaxy",
    runner: "webgl2",
    name: "Drifting Galaxy",
    description: "A spiral galaxy of fine dust turning slowly around a bright core.",
  },
  {
    id: "ninefold-lotus",
    runner: "webgl2",
    name: "Ninefold Lotus",
    description: "Eleven glowing rings flaring in turn into nine-petalled flowers.",
  },
  {
    id: "eightfold-coil",
    runner: "webgl2",
    name: "Eightfold Coil",
    description: "Eight spokes winding into spirals around their nodes, two at a time, and unwinding.",
  },
  {
    id: "cosmic-bell",
    name: "Cosmic Bell",
    description: "A translucent particle shell turning through 450 degrees and back around a luminous ringed core.",
  },
] as const;

export type EmptyPaneAnimation = (typeof EMPTY_PANE_ANIMATIONS)[number];

export type EmptyPaneAnimationId = EmptyPaneAnimation["id"];

const CANVAS_2D_ANIMATIONS: readonly EmptyPaneAnimation[] =
  EMPTY_PANE_ANIMATIONS.filter((animation) => animation.runner === "2d");

/// The animations the welcome draws on a page whose WebGL2 contexts are of
/// `kind`. A software rasterizer draws a full-pane shader at a few frames a
/// second and keeps the CPU busy doing it, and a page with no context draws
/// nothing, so both keep to the 2D canvas. A renderer the engine masks
/// keeps the whole catalog, since WebKit masks it on every machine.
export function emptyPaneAnimationChoices(
  kind: WebglRendererKind,
): readonly EmptyPaneAnimation[] {
  return kind === "software" || kind === "none"
    ? CANVAS_2D_ANIMATIONS
    : EMPTY_PANE_ANIMATIONS;
}

// The speed ladder ArrowUp/ArrowDown walk; 1 is the resting cadence.
// Values feed the --canvas-animation-speed variable the shared canvas
// clock scales by.
export const EMPTY_PANE_ANIMATION_SPEEDS = [
  0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 2.8, 4,
] as const;

export function stepEmptyPaneAnimationSpeed(
  current: number,
  direction: -1 | 1,
): number {
  const speeds = EMPTY_PANE_ANIMATION_SPEEDS;
  const currentIndex = speeds.findIndex((speed) => speed === current);
  const baseIndex = currentIndex === -1 ? speeds.indexOf(1) : currentIndex;
  const nextIndex = Math.min(
    speeds.length - 1,
    Math.max(0, baseIndex + direction),
  );
  return speeds[nextIndex];
}

export function emptyPaneAnimationSpeedLabel(speed: number): string {
  return `Speed ${speed}x`;
}

// How long a shown empty pane waits before its welcome starts. A tab that
// replaces the pane within the delay sees no frame of the animation and
// costs no canvas.
export const EMPTY_PANE_ANIMATION_START_DELAY_MS = 2000;

const EMPTY_PANE_ANIMATION_SESSION_KEY = "chan.empty-pane-animation";

type AnimationStorage = Pick<Storage, "getItem" | "setItem">;

function availableSessionStorage(): AnimationStorage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function isEmptyPaneAnimationId(
  value: string | null,
): value is EmptyPaneAnimationId {
  return EMPTY_PANE_ANIMATIONS.some((animation) => animation.id === value);
}

export function emptyPaneAnimationName(
  animationId: EmptyPaneAnimationId,
): string {
  return (
    EMPTY_PANE_ANIMATIONS.find(
      (animation) => animation.id === animationId,
    )?.name ?? animationId
  );
}

/// The neighbor of `current` among `choices`, in catalog order. `current`
/// need not be one of them: the walk passes over the catalog's other
/// entries, so a step from outside the choices lands on the nearest choice
/// in that direction.
export function stepEmptyPaneAnimation(
  current: EmptyPaneAnimationId,
  direction: -1 | 1,
  choices: readonly EmptyPaneAnimation[] = EMPTY_PANE_ANIMATIONS,
): EmptyPaneAnimationId {
  const count = EMPTY_PANE_ANIMATIONS.length;
  const currentIndex = EMPTY_PANE_ANIMATIONS.findIndex(
    (animation) => animation.id === current,
  );
  for (let step = 1; step <= count; step += 1) {
    const candidate =
      EMPTY_PANE_ANIMATIONS[
        (currentIndex + direction * step + count * step) % count
      ];
    if (choices.includes(candidate)) return candidate.id;
  }
  return current;
}

export function randomEmptyPaneAnimation(
  current?: EmptyPaneAnimationId,
  random = Math.random,
  choices: readonly EmptyPaneAnimation[] = EMPTY_PANE_ANIMATIONS,
): EmptyPaneAnimationId {
  const alternatives = choices.filter(
    (animation) => animation.id !== current,
  );
  if (alternatives.length === 0) {
    return (choices[0] ?? EMPTY_PANE_ANIMATIONS[0]).id;
  }
  const index = Math.min(
    alternatives.length - 1,
    Math.floor(random() * alternatives.length),
  );
  return alternatives[index].id;
}

/// The session's saved choice when it is one of `choices`, otherwise a new
/// draw among them, saved in its place.
export function initialEmptyPaneAnimation(
  storage = availableSessionStorage(),
  random = Math.random,
  choices: readonly EmptyPaneAnimation[] = EMPTY_PANE_ANIMATIONS,
): EmptyPaneAnimationId {
  try {
    const saved = storage?.getItem(EMPTY_PANE_ANIMATION_SESSION_KEY) ?? null;
    if (
      isEmptyPaneAnimationId(saved) &&
      choices.some((animation) => animation.id === saved)
    ) {
      return saved;
    }
  } catch {
    // A blocked sessionStorage should not prevent the welcome from rendering.
  }

  const animation = randomEmptyPaneAnimation(undefined, random, choices);
  persistEmptyPaneAnimation(animation, storage);
  return animation;
}

export function persistEmptyPaneAnimation(
  animation: EmptyPaneAnimationId,
  storage = availableSessionStorage(),
): void {
  try {
    storage?.setItem(EMPTY_PANE_ANIMATION_SESSION_KEY, animation);
  } catch {
    // Persistence is best-effort when storage is unavailable or full.
  }
}
