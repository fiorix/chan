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

const ENABLE = "POST /api/index/semantic/enable";
const DOWNLOAD = "POST /api/index/semantic/download";
const MODEL_MISSING =
  "embedding model 'BAAI/bge-small-en-v1.5' not downloaded; expected at \"/tmp/model-cache/bge-small\". " +
  "Run `chan workspace index download-model` or rebuild with `--features embed-model`.";
const BUSY = "workspace busy: workspace state is temporarily unavailable; retry in a moment";

/// Mount the workspace-ready card over a server that refuses every semantic
/// enable with `status` and `body`, and click the Semantic search toggle
/// twice. Returns what the card showed after the first click and every
/// request the two clicks sent.
async function refuseSemanticEnable(status: number, body: Record<string, unknown>) {
  const sent: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/preflight") {
      return Response.json({ ...ready, summary: { indexed_docs: 0, semantic_enabled: false, reports_enabled: false } });
    }
    const request = `${input instanceof Request ? input.method : init?.method} ${url.pathname}`;
    sent.push(request);
    return request === ENABLE ? Response.json(body, { status }) : Response.json({ semantic_enabled: false });
  });
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(PreflightOverlay, { target }));
  await vi.waitFor(() => expect(target.querySelector('[aria-label="Semantic search"]')).not.toBeNull());
  const toggle = target.querySelector<HTMLButtonElement>('[aria-label="Semantic search"]')!;
  // The toggle is disabled for as long as its request is in flight.
  const click = async (): Promise<void> => {
    toggle.click();
    await tick();
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  };
  await click();
  const error = target.querySelector(".onboard-err")?.textContent;
  const aside = target.querySelector(".onboard-aside")?.textContent ?? null;
  await click();
  return { error, aside, sent };
}

test.each([
  ["the workspace is busy", 503, { error: BUSY }, BUSY],
  [
    "the 409 carries no code",
    409,
    { error: "model_not_downloaded", model_id: "BAAI/bge-small-en-v1.5" },
    "model_not_downloaded",
  ],
  [
    "the 409 carries another code",
    409,
    { error: "semantic search is unavailable", code: "other" },
    "semantic search is unavailable",
  ],
  [
    "the code comes with another status",
    500,
    { error: MODEL_MISSING, code: "model_not_downloaded" },
    MODEL_MISSING,
  ],
])("a semantic enable refused because %s offers no model download", async (_reason, status, body, sentence) => {
  // No offer beside the toggle, and the second click asks to enable again.
  expect(await refuseSemanticEnable(status, body)).toEqual({
    error: sentence,
    aside: null,
    sent: [ENABLE, ENABLE],
  });
});

test("a semantic enable refused for a missing model offers its download", async () => {
  const refusal = {
    error: MODEL_MISSING,
    code: "model_not_downloaded",
    model_id: "BAAI/bge-small-en-v1.5",
    expected_dir: "/tmp/model-cache/bge-small",
    download_endpoint: "/api/index/semantic/download",
  };

  // The second click downloads the model before it asks to enable again.
  expect(await refuseSemanticEnable(409, refusal)).toEqual({
    error: MODEL_MISSING,
    aside: "downloads ~63 MB",
    sent: [ENABLE, DOWNLOAD, ENABLE],
  });
});
