import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FIND_ANNOUNCE_INTERVAL_MS as INTERVAL, FindAnnouncer } from "./findAnnouncer";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/// An announcer and everything it said, in order.
function announcer() {
  const said: string[] = [];
  const it = new FindAnnouncer((text) => said.push(text));
  return { it, said };
}

describe("FindAnnouncer", () => {
  test("says a final count at once", () => {
    const { it, said } = announcer();
    it.update("1 of 3", true);
    expect(said).toEqual(["1 of 3"]);
  });

  test("holds a partial count until it has stood for an interval, then says the latest", () => {
    const { it, said } = announcer();
    it.update("1 of 10+", false);
    vi.advanceTimersByTime(INTERVAL / 2);
    it.update("1 of 40+", false);
    vi.advanceTimersByTime(INTERVAL / 2 - 1);
    expect(said, "nothing while the scan runs").toEqual([]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["1 of 40+"]);
  });

  test("says a count that settles while it waits at once, and drops the wait", () => {
    const { it, said } = announcer();
    it.update("1 of 10+", false);
    vi.advanceTimersByTime(INTERVAL / 2);
    it.update("1 of 52", true);
    expect(said).toEqual(["1 of 52"]);
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(said, "the partial count is never said").toEqual(["1 of 52"]);
  });

  test("after an announcement holds every change for an interval and says the latest at its end", () => {
    const { it, said } = announcer();
    it.update("1 of 3", true);
    it.update("2 of 3", true);
    vi.advanceTimersByTime(INTERVAL / 2);
    it.update("3 of 3", true);
    vi.advanceTimersByTime(INTERVAL / 2 - 1);
    expect(said).toEqual(["1 of 3"]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["1 of 3", "3 of 3"]);
    // That announcement holds the next change for an interval too.
    it.update("1 of 3", true);
    vi.advanceTimersByTime(INTERVAL - 1);
    expect(said).toEqual(["1 of 3", "3 of 3"]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["1 of 3", "3 of 3", "1 of 3"]);
  });

  test("a partial count at the end of an interval waits an interval of its own", () => {
    const { it, said } = announcer();
    it.update("1 of 3", true);
    it.update("1 of 2+", false);
    vi.advanceTimersByTime(INTERVAL);
    expect(said).toEqual(["1 of 3"]);
    vi.advanceTimersByTime(INTERVAL);
    expect(said).toEqual(["1 of 3", "1 of 2+"]);
  });

  test("says nothing when the count comes back to what was said", () => {
    const { it, said } = announcer();
    it.update("1 of 3", true);
    it.update("2 of 3", true);
    it.update("1 of 3", true);
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(said).toEqual(["1 of 3"]);
  });

  test("empties at once with the count and says nothing later", () => {
    const { it, said } = announcer();
    it.update("1 of 3", true);
    it.update("2 of 3", true);
    it.update("", true);
    expect(said).toEqual(["1 of 3", ""]);
    it.update("1 of 9+", false);
    it.update("", true);
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(said).toEqual(["1 of 3", ""]);
  });

  test("dispose drops what waits", () => {
    const { it, said } = announcer();
    it.update("1 of 3", true);
    it.update("2 of 3", true);
    it.dispose();
    const other = announcer();
    other.it.update("1 of 9+", false);
    other.it.dispose();
    vi.advanceTimersByTime(10 * INTERVAL);
    expect(said).toEqual(["1 of 3"]);
    expect(other.said).toEqual([]);
  });
});
