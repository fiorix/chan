// The microtask yield of `microtaskYield.ts`: a loop of microtasks lets a
// timer fire once it passes the limit and is counted, the count starts again
// at each timer turn, a Svelte effect loop is one such loop, and below the
// limit microtasks still run ahead of every timer.

import { afterEach, expect, test } from "vitest";
import { startEffectLoop } from "./effectLoop.svelte";
import { yieldRunawayMicrotasks, type MicrotaskYield } from "./microtaskYield";

const timerTurn = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

let installed: MicrotaskYield | null = null;
afterEach(() => {
  installed?.release();
  installed = null;
});

test("a loop of microtasks lets a timer fire once it passes the limit, and is counted", async () => {
  // A loop the yield does not break stops itself here, so the case fails
  // rather than hangs.
  const SPINS = 200_000;
  installed = yieldRunawayMicrotasks(1_000);
  let fired = false;
  let runs = 0;
  await new Promise<void>((done) => {
    setTimeout(() => (fired = true), 0);
    const spin = (): void => {
      runs += 1;
      if (fired || runs >= SPINS) done();
      else queueMicrotask(spin);
    };
    queueMicrotask(spin);
  });
  expect(fired, "the timer fired while the loop ran").toBe(true);
  expect(runs).toBeLessThan(SPINS);
  expect(installed.yielded).toBeGreaterThan(0);
});

test("the count starts again at each timer turn, so microtasks past the limit across turns are not yielded", async () => {
  // 1,800 microtasks in all against a limit of 1,000, and never more than
  // 601 of them between two timer turns.
  installed = yieldRunawayMicrotasks(1_000);
  let ran = 0;
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((done) => {
      for (let i = 0; i < 600; i += 1) queueMicrotask(() => (ran += 1));
      queueMicrotask(done);
    });
    await timerTurn();
  }
  expect(ran).toBe(1_800);
  expect(installed.yielded).toBe(0);
});

test("a Svelte effect loop is yielded at the limit and counted", async () => {
  // Svelte schedules each flush of its effects with the global
  // `queueMicrotask`, so its loops go through the yield. A loop the yield
  // does not break stops itself here, so the case fails rather than hangs.
  const LIMIT = 1_000;
  const RUNS = 200_000;
  installed = yieldRunawayMicrotasks(LIMIT);
  let fired = false;
  setTimeout(() => (fired = true), 0);
  const loop = startEffectLoop((runs) => fired || runs >= RUNS);
  try {
    await loop.stopped;
  } finally {
    loop.destroy();
  }
  expect(fired, "the timer fired while the effect looped").toBe(true);
  expect(loop.runs).toBeLessThanOrEqual(LIMIT + 1);
  expect(installed.yielded).toBeGreaterThan(0);
});

test("below the limit microtasks run ahead of every timer, and release puts the native one back", async () => {
  const native = globalThis.queueMicrotask;
  installed = yieldRunawayMicrotasks(1_000);
  const order: string[] = [];
  await new Promise<void>((done) => {
    setTimeout(() => {
      order.push("timer");
      done();
    }, 0);
    for (let i = 0; i < 100; i += 1) queueMicrotask(() => order.push("micro"));
  });
  expect(order.indexOf("timer")).toBe(100);
  expect(installed.yielded).toBe(0);
  installed.release();
  installed = null;
  expect(globalThis.queueMicrotask).toBe(native);
});
