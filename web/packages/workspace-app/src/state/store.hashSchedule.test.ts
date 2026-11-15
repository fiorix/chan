// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LeafNode } from "./tabs.svelte";

let store: typeof import("./store.svelte");
let tabs: typeof import("./tabs.svelte");
let helpers: typeof import("../__tests__/tabs");

let left: string;
let right: string;

function hashFocus(): "left" | "right" | "other" {
  const tree = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s") ?? "null");
  return tree?.a?.f ? "left" : tree?.b?.f ? "right" : "other";
}

async function endOfEvent(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  history.replaceState(null, "", "/?w=hash-schedule");
  sessionStorage.clear();
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
  helpers = await import("../__tests__/tabs");
  store.searchPanel.open = false;
  left = helpers.resetLayout([helpers.fileTab({ id: "left-file", path: "left.md" })]).id;
  right = tabs.splitPane(left, "row")!;
  const pane = tabs.layout.nodes[right] as LeafNode;
  pane.tabs.push(helpers.fileTab({ id: "right-file", path: "right.md" }));
  pane.activeTabId = "right-file";
  tabs.layout.activePaneId = left;
  store.persistStateToHash();
  vi.advanceTimersByTime(60_000);
});

afterEach(() => {
  store.persistStateToHash();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("focused pane hash scheduling", () => {
  test("101 focus mutations in one event write the final pane once before any timer", async () => {
    const writes = vi.spyOn(history, "replaceState");
    for (let move = 0; move < 101; move++) {
      tabs.layout.activePaneId = move % 2 === 0 ? right : left;
      store.schedulePersistStateToHash({ focus: true });
    }
    expect(writes).not.toHaveBeenCalled();
    await endOfEvent();
    expect(hashFocus(), "the reload address at the event boundary").toBe("right");
    expect(writes).toHaveBeenCalledTimes(1);
  });

  test.each([10, 160])("a stream of 101 focus events spaced %i ms starts with current reload addresses", async (spacing) => {
    const writes = vi.spyOn(history, "replaceState");
    for (let move = 0; move < 101; move++) {
      tabs.layout.activePaneId = move % 2 === 0 ? right : left;
      store.schedulePersistStateToHash({ focus: true });
      await endOfEvent();
      if (spacing === 160 || move < 80) {
        expect(hashFocus(), `focus event ${move + 1}, before its timer`).toBe(move % 2 === 0 ? "right" : "left");
      }
      if (move < 100) vi.advanceTimersByTime(spacing);
    }
    expect(writes).toHaveBeenCalledTimes(spacing === 10 ? 80 : 101);
    if (spacing === 10) {
      expect(hashFocus(), "the saturated burst leaves its last admitted focus").toBe("left");
      vi.advanceTimersByTime(150);
      expect(writes, "the quiet timer cannot spend an unavailable slot").toHaveBeenCalledTimes(80);
      vi.advanceTimersByTime(9_099);
      expect(writes).toHaveBeenCalledTimes(80);
      vi.advanceTimersByTime(1);
      expect(writes, "the first refilled slot carries the latest focus").toHaveBeenCalledTimes(81);
    }
    vi.advanceTimersByTime(60_000);
    await endOfEvent();
    expect(hashFocus(), "the latest pane survives deferred persistence").toBe("right");
    expect(writes).toHaveBeenCalledTimes(spacing === 10 ? 81 : 101);
  });

  test("Hybrid Nav previews leave live focus alone and the commit reaches the hash before a timer", async () => {
    const writes = vi.spyOn(history, "replaceState");
    tabs.enterPaneMode();
    for (let move = 0; move < 101; move++) {
      tabs.paneModeMoveFocus(move % 2 === 0 ? "right" : "left");
      await endOfEvent();
      vi.advanceTimersByTime(10);
    }
    expect(tabs.paneMode.draft?.activePaneId).toBe(right);
    expect(tabs.layout.activePaneId).toBe(left);
    expect(hashFocus()).toBe("left");
    expect(writes).not.toHaveBeenCalled();
    tabs.commitPaneMode();
    store.schedulePersistStateToHash({ focus: true });
    await endOfEvent();
    expect(hashFocus(), "committed focus is reloadable before a timer").toBe("right");
    expect(writes).toHaveBeenCalledTimes(1);
  });
});

test("ordinary layout changes retain the 150 ms trailing debounce", async () => {
  const writes = vi.spyOn(history, "replaceState");
  store.searchPanel.open = true;
  store.searchPanel.query = "first";
  store.schedulePersistStateToHash();
  await endOfEvent();
  vi.advanceTimersByTime(100);
  store.searchPanel.query = "last";
  store.schedulePersistStateToHash();
  await endOfEvent();
  vi.advanceTimersByTime(149);
  expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(new URLSearchParams(location.hash.slice(1)).get("search")).toBe("1:last");
});

test("an explicit flush writes synchronously and supersedes a queued focus write", async () => {
  const writes = vi.spyOn(history, "replaceState");
  tabs.layout.activePaneId = right;
  store.schedulePersistStateToHash({ focus: true });
  store.persistStateToHash();
  expect(hashFocus()).toBe("right");
  expect(writes).toHaveBeenCalledTimes(1);
  store.searchPanel.open = true;
  store.searchPanel.query = "later";
  store.schedulePersistStateToHash();
  await endOfEvent();
  expect(writes, "the cancelled focus microtask cannot flush a later ordinary change").toHaveBeenCalledTimes(1);
  expect(new URLSearchParams(location.hash.slice(1)).has("search")).toBe(false);
  vi.advanceTimersByTime(150);
  expect(writes).toHaveBeenCalledTimes(2);
});

function fillOrdinaryBudget(): void {
  store.searchPanel.open = true;
  for (let write = 0; write < 80; write++) {
    store.searchPanel.query = `value-${write}`;
    store.persistStateToHash();
  }
}

test("direct and scheduled ordinary writes consume the same budget as focus", async () => {
  const writes = vi.spyOn(history, "replaceState");
  store.searchPanel.open = true;
  for (let write = 0; write < 79; write++) {
    store.searchPanel.query = `value-${write}`;
    store.persistStateToHash();
  }
  store.searchPanel.query = "debounced";
  store.schedulePersistStateToHash();
  vi.advanceTimersByTime(150);
  expect(writes).toHaveBeenCalledTimes(80);
  const carrier = sessionStorage.getItem("chan-cli-reload-bits");
  tabs.layout.activePaneId = right;
  store.schedulePersistStateToHash({ focus: true });
  await endOfEvent();
  vi.advanceTimersByTime(150);
  expect(writes).toHaveBeenCalledTimes(80);
  expect(hashFocus()).toBe("left");
  expect(sessionStorage.getItem("chan-cli-reload-bits"), "metadata stays paired with the admitted URL").toBe(carrier);
  vi.advanceTimersByTime(9_950);
  expect(writes).toHaveBeenCalledTimes(81);
  expect(hashFocus()).toBe("right");
  expect(JSON.parse(sessionStorage.getItem("chan-cli-reload-bits")!).hash)
    .toBe(new URLSearchParams(location.hash.slice(1)).get("s"));
});

test("equal URLs use no capacity", () => {
  const writes = vi.spyOn(history, "replaceState");
  for (let noop = 0; noop < 200; noop++) store.persistStateToHash();
  expect(writes).not.toHaveBeenCalled();
  fillOrdinaryBudget();
  expect(writes).toHaveBeenCalledTimes(80);
});

test("a blocked focus event near refill still gets its full quiet interval", async () => {
  const writes = vi.spyOn(history, "replaceState");
  fillOrdinaryBudget();
  vi.advanceTimersByTime(10_200);
  tabs.layout.activePaneId = right;
  store.schedulePersistStateToHash({ focus: true });
  await endOfEvent();
  vi.advanceTimersByTime(149);
  expect(writes, "capacity alone cannot shorten the fallback debounce").toHaveBeenCalledTimes(80);
  expect(hashFocus()).toBe("left");
  vi.advanceTimersByTime(1);
  expect(hashFocus()).toBe("right");
  expect(writes).toHaveBeenCalledTimes(81);
});

test("only exit flushes can use two reserved writes and repeated unloads deduplicate", () => {
  const writes = vi.spyOn(history, "replaceState");
  fillOrdinaryBudget();
  tabs.layout.activePaneId = right;
  store.persistStateToHash();
  expect(writes, "a direct visibility-style flush has no reserved slot").toHaveBeenCalledTimes(80);
  expect(hashFocus()).toBe("left");
  store.persistLayoutToHash({ exiting: true });
  expect(hashFocus()).toBe("right");
  expect(writes).toHaveBeenCalledTimes(81);
  for (let noop = 0; noop < 100; noop++) store.persistLayoutToHash({ exiting: true });
  expect(writes).toHaveBeenCalledTimes(81);
  store.searchPanel.query = "second exit change";
  store.persistLayoutToHash({ exiting: true });
  expect(writes).toHaveBeenCalledTimes(82);
  store.searchPanel.query = "third exit change";
  store.persistLayoutToHash({ exiting: true });
  expect(writes, "exit capacity is bounded too").toHaveBeenCalledTimes(82);
  expect(new URLSearchParams(location.hash.slice(1)).get("search")).toBe("1:second exit change");
  vi.advanceTimersByTime(10_250);
  expect(new URLSearchParams(location.hash.slice(1)).get("search")).toBe("1:third exit change");
  expect(writes).toHaveBeenCalledTimes(83);
});

test("ordinary persistence waits for three expiries after both exit slots were used", () => {
  const writes = vi.spyOn(history, "replaceState");
  store.searchPanel.open = true;
  for (let change = 0; change < 80; change++) {
    store.searchPanel.query = `normal-${change}`;
    store.persistStateToHash();
    vi.advanceTimersByTime(1);
  }
  for (let change = 0; change < 2; change++) {
    store.searchPanel.query = `exit-${change}`;
    store.persistLayoutToHash({ exiting: true });
    vi.advanceTimersByTime(1);
  }
  expect(writes).toHaveBeenCalledTimes(82);
  store.searchPanel.query = "ordinary again";
  store.persistStateToHash();
  vi.advanceTimersByTime(10_168);
  expect(writes, "the first expiry leaves 81 admitted writes").toHaveBeenCalledTimes(82);
  vi.advanceTimersByTime(1);
  expect(writes, "the second expiry leaves all 80 ordinary slots used").toHaveBeenCalledTimes(82);
  vi.advanceTimersByTime(1);
  expect(writes, "the third expiry opens an ordinary slot").toHaveBeenCalledTimes(83);
  expect(new URLSearchParams(location.hash.slice(1)).get("search")).toBe("1:ordinary again");
});

test.each(["exception", "silent refusal"])("a native %s leaves metadata paired and retries the latest state once the window passes", async (refusal) => {
  const writes = vi.spyOn(history, "replaceState").mockImplementationOnce(() => {
    if (refusal === "exception") throw new DOMException("history rate limit", "SecurityError");
  });
  const carrier = sessionStorage.getItem("chan-cli-reload-bits");
  tabs.layout.activePaneId = right;
  expect(() => store.persistStateToHash()).not.toThrow();
  expect(hashFocus()).toBe("left");
  expect(sessionStorage.getItem("chan-cli-reload-bits")).toBe(carrier);
  store.searchPanel.open = true;
  for (let change = 0; change < 20; change++) {
    store.searchPanel.query = `latest-${change}`;
    store.schedulePersistStateToHash({ focus: true });
    await endOfEvent();
    vi.advanceTimersByTime(10);
  }
  vi.advanceTimersByTime(10_049);
  expect(writes, "refused history writes are not retried in a hot loop").toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("chan-cli-reload-bits")).toBe(carrier);
  vi.advanceTimersByTime(1);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(hashFocus()).toBe("right");
  expect(new URLSearchParams(location.hash.slice(1)).get("search")).toBe("1:latest-19");
  expect(JSON.parse(sessionStorage.getItem("chan-cli-reload-bits")!).hash)
    .toBe(new URLSearchParams(location.hash.slice(1)).get("s"));
});

test.each(["exception", "silent refusal"])("a native %s retries even when no more events arrive", (refusal) => {
  const writes = vi.spyOn(history, "replaceState").mockImplementationOnce(() => {
    if (refusal === "exception") throw new DOMException("history rate limit", "SecurityError");
  });
  tabs.layout.activePaneId = right;
  store.persistStateToHash();
  vi.advanceTimersByTime(10_249);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(hashFocus()).toBe("left");
  vi.advanceTimersByTime(1);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(hashFocus()).toBe("right");
});

test("an unrelated history error is not classified as a rate refusal", () => {
  const error = new TypeError("unrelated history failure");
  vi.spyOn(history, "replaceState").mockImplementationOnce(() => { throw error; });
  tabs.layout.activePaneId = right;
  expect(() => store.persistStateToHash()).toThrow(error);
});
