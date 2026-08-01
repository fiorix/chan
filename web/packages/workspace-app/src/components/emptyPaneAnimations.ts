export const EMPTY_PANE_ANIMATIONS = [
  {
    id: "sixfold-vortex",
    name: "Sixfold Vortex",
    description: "A particle galaxy stirred by six outward-moving vortices.",
  },
  {
    id: "radial-ribbons",
    name: "Radial Ribbons",
    description: "Twenty curved ribbons slowly twisting around the center.",
  },
  {
    id: "polar-drift",
    name: "Polar Drift",
    description: "A slow polar current traced by thousands of particles.",
  },
  {
    id: "concentric-pulse",
    name: "Concentric Pulse",
    description: "Breathing polygonal rings that expand across the pane.",
  },
  {
    id: "penguin-grid",
    name: "Penguin Grid",
    description: "Alternating rows that morph into interlocking penguins.",
  },
  {
    id: "exponential-thread",
    name: "Exponential Thread",
    description: "A dim, slowly morphing exponential curve.",
  },
  {
    id: "exponential-echo",
    name: "Exponential Echo",
    description: "A growing-frequency curve leaving a tunnel of fading echoes.",
  },
  {
    id: "quadratic-bloom",
    name: "Quadratic Bloom",
    description: "A shifting quadratic attractor drawn as a field of points.",
  },
  {
    id: "orbital-rosette",
    name: "Orbital Rosette",
    description: "Breathing rings of outlined circles around the chan mark.",
  },
  {
    id: "dotted-waves",
    name: "Dotted Waves",
    description: "A perspective field of dots moving in shallow waves.",
  },
  {
    id: "spiral-spokes",
    name: "Spiral Spokes",
    description: "An expanding fan of lines twisting out from the center.",
  },
  {
    id: "mutual-force-starburst",
    name: "Mutual Force Starburst",
    description: "Three hundred particles pulling into a traced starburst.",
  },
  {
    id: "recursive-arc-bloom",
    name: "Recursive Arc Bloom",
    description: "Sixteen chains of alternating arcs breathing in radial symmetry.",
  },
  {
    id: "chaotic-halo",
    name: "Chaotic Halo",
    description: "A dense field of coupled orbits forming a shifting halo.",
  },
  {
    id: "threefold-veil",
    name: "Threefold Veil",
    description: "Three point-cloud veils folding around the center.",
  },
  {
    id: "striated-current",
    name: "Striated Current",
    description: "A layered filament current flowing across the pane.",
  },
  {
    id: "lorenz-constellation",
    name: "Lorenz Constellation",
    description: "Nine projected Lorenz traces orbiting as a constellation.",
  },
  {
    id: "twin-veil-dance",
    name: "Twin Veil Dance",
    description: "Two filament veils unfurling around one another.",
  },
  {
    id: "rippled-duet",
    name: "Rippled Duet",
    description: "Paired rippling forms turning through the pane.",
  },
  {
    id: "fourteenfold-bloom",
    name: "Fourteenfold Bloom",
    description: "A fourteenfold rotational lace bloom with a quiet center.",
  },
  {
    id: "hexagonal-bloom",
    name: "Hexagonal Bloom",
    description: "A sixfold rotational lattice breathing around a quiet center.",
  },
] as const;

export type EmptyPaneAnimationId =
  (typeof EMPTY_PANE_ANIMATIONS)[number]["id"];

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

export function stepEmptyPaneAnimation(
  current: EmptyPaneAnimationId,
  direction: -1 | 1,
): EmptyPaneAnimationId {
  const currentIndex = EMPTY_PANE_ANIMATIONS.findIndex(
    (animation) => animation.id === current,
  );
  const nextIndex =
    (currentIndex + direction + EMPTY_PANE_ANIMATIONS.length) %
    EMPTY_PANE_ANIMATIONS.length;
  return EMPTY_PANE_ANIMATIONS[nextIndex].id;
}

export function randomEmptyPaneAnimation(
  current?: EmptyPaneAnimationId,
  random = Math.random,
): EmptyPaneAnimationId {
  const alternatives = EMPTY_PANE_ANIMATIONS.filter(
    (animation) => animation.id !== current,
  );
  if (alternatives.length === 0) return EMPTY_PANE_ANIMATIONS[0].id;
  const index = Math.min(
    alternatives.length - 1,
    Math.floor(random() * alternatives.length),
  );
  return alternatives[index].id;
}

export function initialEmptyPaneAnimation(
  storage = availableSessionStorage(),
  random = Math.random,
): EmptyPaneAnimationId {
  try {
    const saved = storage?.getItem(EMPTY_PANE_ANIMATION_SESSION_KEY) ?? null;
    if (isEmptyPaneAnimationId(saved)) return saved;
  } catch {
    // A blocked sessionStorage should not prevent the welcome from rendering.
  }

  const animation = randomEmptyPaneAnimation(undefined, random);
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
