import { describe, it, expect, beforeEach } from "vitest";
import {
  clearWindowHidden,
  isWindowEnded,
  markWindowDiscarded,
  markWindowHidden,
  windowLifecycle,
  __resetWindowLifecycle,
} from "./windowLifecycle.svelte";

beforeEach(() => {
  __resetWindowLifecycle();
});

describe("windowLifecycle", () => {
  it("starts not-ended", () => {
    expect(windowLifecycle.ended).toBeNull();
    expect(isWindowEnded()).toBe(false);
  });

  it("marks discarded and hidden", () => {
    markWindowDiscarded();
    expect(windowLifecycle.ended).toBe("discarded");
    expect(isWindowEnded()).toBe(true);

    __resetWindowLifecycle();
    markWindowHidden();
    expect(windowLifecycle.ended).toBe("hidden");
    expect(isWindowEnded()).toBe(true);
  });

  it("a discard is terminal: hidden never downgrades it", () => {
    markWindowDiscarded();
    markWindowHidden();
    expect(windowLifecycle.ended).toBe("discarded");
  });

  it("clears hidden alone when the record is shown", () => {
    clearWindowHidden();
    expect(windowLifecycle.ended).toBeNull();

    markWindowHidden();
    clearWindowHidden();
    expect(windowLifecycle.ended).toBeNull();

    markWindowDiscarded();
    clearWindowHidden();
    expect(windowLifecycle.ended).toBe("discarded");
  });

  it("hidden then discarded escalates to discarded", () => {
    markWindowHidden();
    markWindowDiscarded();
    expect(windowLifecycle.ended).toBe("discarded");
  });
});
