// @vitest-environment jsdom
//
// Older builds kept an ANSI dump of each terminal's screen in localStorage
// under `chan:term-snapshot:<sessionId>`, and a control terminal's dump holds
// the devserver token. Nothing reads them now, and the app's load is the only
// place that removes them, so loading the app clears every one and leaves the
// other keys alone.

import { afterEach, expect, test, vi } from "vitest";

import { mountApp, stubAppEnvironment, unmountApp } from "./__tests__/app";

stubAppEnvironment();

afterEach(async () => {
  vi.restoreAllMocks();
  await unmountApp();
  localStorage.clear();
  sessionStorage.clear();
});

test("the app's load removes the stored snapshots and keeps other keys", async () => {
  const snapshot = (ansi: string) =>
    JSON.stringify({ ansi, generation: 1, lastSeq: 42, cols: 80, rows: 24, updatedAt: Date.now() });
  localStorage.setItem("chan:term-snapshot:term_a", snapshot("fresh and well formed"));
  localStorage.setItem("chan:term-snapshot:term_b", "not-json");
  localStorage.setItem("chan:term-snapshot:ctl", snapshot("CHAN_DEVSERVER_TOKEN=tok_leaked\r\n$ "));
  localStorage.setItem("chan:terminal-webgl", "0");
  sessionStorage.setItem("chan:term-snapshot:term_f", "session store");

  await mountApp();

  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
  expect(keys.filter((key) => key.startsWith("chan:term-snapshot:")), "no snapshot left").toEqual([]);
  expect(localStorage.getItem("chan:terminal-webgl"), "an unrelated chan key stays").toBe("0");
  expect(sessionStorage.getItem("chan:term-snapshot:term_f"), "sessionStorage is not swept").toBe("session store");
});

// The sweep goes ahead of the editor-buffer prune, so a prune the store stops
// cannot leave a snapshot behind: the snapshot's removal comes before the
// prune's first read of a buffer entry.
test("the load removes the snapshots before it prunes the editor buffers", async () => {
  localStorage.setItem("chan:term-snapshot:term_a", "{}");
  localStorage.setItem("chan:editor-buffer:order", JSON.stringify({ content: "x", updatedAt: Date.now(), path: "a.md", sessionId: "previous-load" }));
  const calls: string[] = [];
  const getItem = Storage.prototype.getItem;
  const removeItem = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
    calls.push(`get ${key}`);
    return getItem.call(this, key);
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
    calls.push(`remove ${key}`);
    return removeItem.call(this, key);
  });

  await mountApp();

  const swept = calls.indexOf("remove chan:term-snapshot:term_a");
  const pruned = calls.indexOf("get chan:editor-buffer:order");
  expect(swept, "the sweep removed the snapshot").toBeGreaterThanOrEqual(0);
  expect(pruned, "the prune read the buffer entry").toBeGreaterThanOrEqual(0);
  expect(swept, "the snapshot went before the prune's read").toBeLessThan(pruned);
});
