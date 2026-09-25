// @vitest-environment jsdom
//
// release() clears what a test armed and left pending, animation frames
// included, and leaves the page able to run frames afterwards. Vitest's jsdom
// environment pretends to be visual, so requestAnimationFrame is jsdom's own:
// it runs every outstanding frame from one interval it starts on the first
// request and stops when none is left. That interval is jsdom's, and clearing
// it as a test timer strands every later frame in the file.

import { describe, expect, test } from "vitest";

import { trackTimers } from "./timers";

const realSetTimeout = globalThis.setTimeout;

/// Whether a frame requested now runs within `ms`.
function frameRunsWithin(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    realSetTimeout(() => resolve(false), ms);
    requestAnimationFrame(() => resolve(true));
  });
}

describe("trackTimers", () => {
  test("cancels a pending animation frame on release", async () => {
    const track = trackTimers();
    let ran = false;
    requestAnimationFrame(() => {
      ran = true;
    });

    const cleared = track.release();
    await new Promise((r) => realSetTimeout(r, 80));

    expect({ cleared, ran }).toEqual({ cleared: 1, ran: false });
  });

  test("leaves jsdom's frame loop running after a release", async () => {
    const track = trackTimers();
    requestAnimationFrame(() => {});
    track.release();

    expect(await frameRunsWithin(200), "a frame requested after the release runs").toBe(true);
  });

  test("forgets a frame that already ran", async () => {
    const track = trackTimers();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(track.release()).toBe(0);
  });
});
