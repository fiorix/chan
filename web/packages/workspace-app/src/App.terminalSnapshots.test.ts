// @vitest-environment jsdom
//
// Older builds kept an ANSI dump of each terminal's screen in localStorage
// under `chan:term-snapshot:<sessionId>`, and a control terminal's dump holds
// the devserver token. Nothing reads them now, and the app's load is the only
// place that removes them, so loading the app clears every one and leaves the
// other keys alone.

import { afterEach, expect, test } from "vitest";

import { mountApp, stubAppEnvironment, unmountApp } from "./__tests__/app";

stubAppEnvironment();

afterEach(async () => {
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
