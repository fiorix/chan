// The microtask yield of `microtaskYield.ts`: a loop of microtasks lets a
// timer fire once it passes the limit and is counted, and below the limit
// microtasks still run ahead of every timer.

import { afterEach, expect, test } from "vitest";
import { yieldRunawayMicrotasks, type MicrotaskYield } from "./microtaskYield";

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
