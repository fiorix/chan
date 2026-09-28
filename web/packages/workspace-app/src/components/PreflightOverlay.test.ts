// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { PreflightSnapshot } from "../api/types";
import PreflightOverlay from "./PreflightOverlay.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
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

