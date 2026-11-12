// @vitest-environment jsdom
//
// The terminal harness's teardown and the store's session save. Every attach
// a terminal test drives schedules a session save, and the store outlives the
// test, so a save or a failed save's retry still armed when the test ends
// goes out during a later test, or after the file's environment is gone,
// where it fails the run with every test passing. `resetTerminals` ends them.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { recordRequests, stopRecordingRequests, type RecordedRequest } from "./fetch";
import { terminalTab } from "./tabs";
import { resetTerminals, seatTerminals } from "./terminalTab";
import {
  __testResetSessionDiscarded,
  __testResetSessionWrites,
  discardWindowSessionLocal,
  scheduleSessionSave,
} from "../state/store.svelte";

let requests: RecordedRequest[];

function sessionWrites(): string[] {
  return requests.filter((request) => request.path === "/api/session").map((request) => request.method);
}

/// A terminal attached to a server session, as an attach leaves the layout.
function seatAttachedTerminal(): void {
  seatTerminals([terminalTab({ terminalSessionId: "sess-1" })]);
}

beforeEach(() => {
  vi.useFakeTimers();
  discardWindowSessionLocal();
  __testResetSessionDiscarded();
  __testResetSessionWrites();
});

afterEach(() => {
  resetTerminals();
  stopRecordingRequests();
  vi.useRealTimers();
});

test("a save still waiting when the terminals are reset is not sent", async () => {
  requests = recordRequests(() => new Response(null, { status: 204 }));
  seatAttachedTerminal();
  scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(sessionWrites(), "the attached terminal's save").toEqual(["PUT"]);

  scheduleSessionSave();
  resetTerminals();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sessionWrites(), "writes after the reset").toEqual(["PUT"]);
});

test("a failed save's retry is not sent once the terminals are reset", async () => {
  requests = recordRequests(() => new Response("disk full", { status: 500 }));
  seatAttachedTerminal();
  scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sessionWrites(), "the failed save and its first retry").toEqual(["PUT", "PUT"]);

  resetTerminals();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sessionWrites(), "writes after the reset").toEqual(["PUT", "PUT"]);
});
