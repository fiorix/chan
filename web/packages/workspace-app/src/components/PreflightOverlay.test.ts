// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { PreflightSnapshot } from "../api/types";
import PreflightOverlay from "./PreflightOverlay.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(async () => {
  for (const view of mounted.splice(0)) await unmount(view);
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("shows an ApiError message that is itself JSON without unwrapping it", async () => {
  const message = '{"error":"This text belongs to the message"}';
  const snapshot: PreflightSnapshot = {
    phase: "ready",
    locked: false,
    readiness: { state: "ready" },
    steps: [],
    summary: { indexed_docs: 0, semantic_enabled: false, reports_enabled: false },
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/preflight") return Response.json(snapshot);
    expect(url.pathname).toBe("/api/index/reports/enable");
    expect(init?.method).toBe("POST");
    return Response.json({ error: message }, { status: 503 });
  });
  const enable = vi.spyOn(api, "reportsEnable");
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(PreflightOverlay, { target }));

  await vi.waitFor(() => expect(target.querySelector('[aria-label="Reports"]')).not.toBeNull());
  target.querySelector<HTMLButtonElement>('[aria-label="Reports"]')!.click();
  await vi.waitFor(() => expect(target.querySelector(".onboard-err")).not.toBeNull());

  expect(enable).toHaveBeenCalledTimes(1);
  await expect(enable.mock.results[0]!.value).rejects.toBeInstanceOf(ApiError);
  await expect(enable.mock.results[0]!.value).rejects.toMatchObject({ message, data: { error: message } });
  expect(target.querySelector(".onboard-err")?.textContent).toBe(message);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("a poll that lands after an answer does not bring the answered step back", async () => {
  const deciding: PreflightSnapshot = {
    phase: "needs_decision",
    locked: true,
    readiness: { state: "recovering" },
    steps: [
      {
        id: "index",
        label: "Build search index",
        state: "needs_decision",
        decision: { prompt: "Recovery is stalled.", choices: [{ id: "rebuild", label: "Rebuild the search index" }] },
      },
    ],
  } as PreflightSnapshot;
  const answered: PreflightSnapshot = {
    phase: "needs_decision",
    locked: true,
    readiness: { state: "recovering" },
    steps: [{ id: "index", label: "Build search index", state: "pending" }],
  } as PreflightSnapshot;
  let landStalePoll: (snap: PreflightSnapshot) => void = () => {};
  const preflight = vi
    .spyOn(api, "preflight")
    .mockResolvedValueOnce(deciding)
    .mockImplementationOnce(() => new Promise((resolve) => (landStalePoll = resolve)))
    .mockResolvedValue(answered);
  vi.spyOn(api, "preflightDecision").mockResolvedValue(answered);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(PreflightOverlay, { target }));
  const choice = (): HTMLButtonElement | undefined =>
    [...target.querySelectorAll<HTMLButtonElement>(".choices button")].find(
      (b) => b.textContent?.trim() === "Rebuild the search index",
    );
  await vi.waitFor(() => expect(choice()).toBeDefined());
  // The next poll is in flight, held, when the user answers.
  await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(2), { timeout: 2000 });

  choice()!.click();
  await vi.waitFor(() => expect(choice(), "the answer takes the step").toBeUndefined());
  landStalePoll(deciding);
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();

  expect(choice(), "the stale poll does not bring the step back").toBeUndefined();
});


const needsDecision = {
  phase: "needs_decision", locked: true, readiness: { state: "recovering" },
  steps: [{ id: "index", label: "Build search index", state: "needs_decision",
    decision: { prompt: "Recovery is stalled.", choices: [{ id: "rebuild", label: "Rebuild" }] } }],
} as PreflightSnapshot;
const recovering = {
  phase: "ready", locked: false, readiness: { state: "recovering" }, steps: [],
} as PreflightSnapshot;
const ready = {
  phase: "ready", locked: false, readiness: { state: "ready" }, steps: [],
} as PreflightSnapshot;

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushSnapshot(): Promise<void> {
  for (let i = 0; i < 4; i++) { await Promise.resolve(); await tick(); }
}

async function hostDecision() {
  vi.useFakeTimers();
  const timer = vi.spyOn(globalThis, "setTimeout");
  const preflight = vi.spyOn(api, "preflight").mockResolvedValue(needsDecision);
  const answer = held<PreflightSnapshot>();
  vi.spyOn(api, "preflightDecision").mockReturnValue(answer.promise);
  const target = document.body.appendChild(document.createElement("div"));
  const view = mount(PreflightOverlay, { target });
  mounted.push(view);
  await flushSnapshot();
  const choice = target.querySelector<HTMLButtonElement>(".choices button")!;
  expect(choice.textContent?.trim(), "decision is initially available").toBe("Rebuild");
  const runnable = timer.mock.calls.find((call) => call[1] === 750)![0] as () => Promise<void>;
  return { target, view, preflight, answer, choice, runnable };
}

test("a decision cancels its pending poll timer", async () => {
  const { choice, answer } = await hostDecision();
  expect(vi.getTimerCount(), "one pending poll").toBe(1);
  choice.click();
  await flushSnapshot();
  expect(vi.getTimerCount(), "decision owns and cancels the timer").toBe(0);
  answer.resolve(ready);
  await flushSnapshot();
});

test("a poll becoming due during a held decision asks nothing", async () => {
  const { choice, answer, preflight } = await hostDecision();
  choice.click();
  await vi.advanceTimersByTimeAsync(750);
  expect(preflight, "no poll while deciding").toHaveBeenCalledTimes(1);
  answer.resolve(ready);
  await flushSnapshot();
  expect(vi.getTimerCount()).toBe(0);
});

test("an already runnable poll callback asks nothing during a decision", async () => {
  const { choice, answer, preflight, runnable } = await hostDecision();
  choice.click();
  await runnable();
  expect(preflight, "runnable poll respects decision ownership").toHaveBeenCalledTimes(1);
  answer.resolve(ready);
  await flushSnapshot();
});

test("an earlier held poll cannot replace an accepted decision", async () => {
  const { choice, answer, preflight, target } = await hostDecision();
  const poll = held<PreflightSnapshot>();
  preflight.mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(750);
  expect(preflight).toHaveBeenCalledTimes(2);
  choice.click();
  answer.resolve(ready);
  await flushSnapshot();
  expect(target.querySelector(".choices")).toBeNull();
  poll.resolve(needsDecision);
  await flushSnapshot();
  expect(target.querySelector(".choices"), "stale poll cannot restore choice").toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("an unsettled decision resumes polling after deciding clears", async () => {
  const { choice, answer, preflight } = await hostDecision();
  choice.click();
  answer.resolve(recovering);
  await flushSnapshot();
  expect(vi.getTimerCount(), "recovering answer schedules another poll").toBe(1);
  preflight.mockResolvedValueOnce(ready);
  await vi.advanceTimersByTimeAsync(750);
  expect(preflight, "poll resumes after the answer").toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("a settled decision leaves no further poll", async () => {
  const { choice, answer, preflight } = await hostDecision();
  choice.click();
  answer.resolve(ready);
  await flushSnapshot();
  await vi.advanceTimersByTimeAsync(1500);
  expect(preflight, "settled answer stops polling").toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a rejected decision resumes polling", async () => {
  const { choice, answer, preflight } = await hostDecision();
  choice.click();
  answer.reject(new Error("decision unavailable"));
  await flushSnapshot();
  expect(choice.disabled).toBe(false);
  preflight.mockResolvedValueOnce(ready);
  await vi.advanceTimersByTimeAsync(750);
  expect(preflight).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("destroying during a decision prevents response and callback polling", async () => {
  const { view, choice, answer, preflight, runnable } = await hostDecision();
  choice.click();
  mounted.splice(mounted.indexOf(view), 1);
  await unmount(view);
  answer.resolve(needsDecision);
  await flushSnapshot();
  await runnable();
  await vi.advanceTimersByTimeAsync(1500);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount(), "destroyed decision cannot reschedule").toBe(0);
});

test("destroying during a poll prevents response rescheduling", async () => {
  const { view, preflight } = await hostDecision();
  const poll = held<PreflightSnapshot>();
  preflight.mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(750);
  mounted.splice(mounted.indexOf(view), 1);
  await unmount(view);
  poll.resolve(needsDecision);
  await flushSnapshot();
  await vi.advanceTimersByTimeAsync(1500);
  expect(preflight).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount(), "destroyed poll cannot reschedule").toBe(0);
});
