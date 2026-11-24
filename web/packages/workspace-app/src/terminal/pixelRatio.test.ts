import { describe, expect, test, vi } from "vitest";
import { watchDevicePixelRatio, type PixelRatioHost } from "./pixelRatio";

function fakeHost(ratio: number) {
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const host: PixelRatioHost = {
    devicePixelRatio: ratio,
    matchMedia: (media) => {
      const listeners = new Set<() => void>();
      queries.push({ media, listeners });
      return {
        addEventListener: (_type: string, listener: unknown) => listeners.add(listener as () => void),
        removeEventListener: (_type: string, listener: unknown) => listeners.delete(listener as () => void),
      };
    },
  };
  const moveTo = (next: number): void => {
    host.devicePixelRatio = next;
    for (const listener of [...queries.at(-1)!.listeners]) listener();
  };
  return { host, queries, moveTo };
}

describe("watchDevicePixelRatio", () => {
  test("reports each change and watches the ratio it led to", () => {
    const { host, queries, moveTo } = fakeHost(1);
    const changed = vi.fn();
    watchDevicePixelRatio(changed, host);
    expect(queries.map((query) => query.media)).toEqual(["(resolution: 1dppx)"]);
    moveTo(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(queries.map((query) => query.media)).toEqual(["(resolution: 1dppx)", "(resolution: 2dppx)"]);
    expect(queries[0]!.listeners.size, "the old ratio's query is released").toBe(0);
    moveTo(1.5);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(queries.at(-1)!.media).toBe("(resolution: 1.5dppx)");
  });

  test("stops when asked", () => {
    const { host, queries, moveTo } = fakeHost(2);
    const changed = vi.fn();
    const stop = watchDevicePixelRatio(changed, host);
    stop();
    expect(queries[0]!.listeners.size).toBe(0);
    moveTo(1);
    expect(changed).not.toHaveBeenCalled();
  });

  test("a window without matchMedia is watched by nothing", () => {
    const changed = vi.fn();
    const stop = watchDevicePixelRatio(changed, { devicePixelRatio: 1 });
    stop();
    expect(changed).not.toHaveBeenCalled();
  });
});
