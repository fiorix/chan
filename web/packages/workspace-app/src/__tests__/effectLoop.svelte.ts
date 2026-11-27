// A Svelte effect that never settles: each run starts a promise reaction that
// writes the state the run read, so the effect runs again. Nothing in it
// waits on a timer; every rerun is a flush Svelte schedules itself.

export type EffectLoop = {
  /// How many times the effect has run.
  readonly runs: number;
  /// Settles on the run `stop` ends the loop at.
  readonly stopped: Promise<void>;
  destroy(): void;
};

/// Starts the loop; it ends at the first run for which `stop` holds.
export function startEffectLoop(stop: (runs: number) => boolean): EffectLoop {
  let tick = $state(0);
  let runs = 0;
  let settle: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (settle = resolve));
  const destroy = $effect.root(() => {
    $effect(() => {
      void tick;
      runs += 1;
      if (stop(runs)) settle();
      else void Promise.resolve().then(() => (tick += 1));
    });
  });
  return {
    get runs() {
      return runs;
    },
    stopped,
    destroy,
  };
}
