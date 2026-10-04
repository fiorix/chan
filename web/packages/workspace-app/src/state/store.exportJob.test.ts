// @vitest-environment jsdom
//
// A `cs export` job reaches its window as an `export-job` frame, and the
// command waits for the window's reply. The store loads the export engine
// when a job arrives; each case mocks that module its own way, over a fresh
// store, and waits on what the mock itself reports: its load being tried, or
// a job being handed to it.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const ENGINE = "../editor/pdf_export";

const JOB = {
  type: "window_command",
  command: "export-job",
  id: "job-1",
  path: "notes/doc.md",
  format: "pdf",
  out: "notes/doc.pdf",
};

type Reply = { requestId: string; payload?: { ok: boolean; error?: string }; pageFinished?: number };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock(ENGINE);
  vi.restoreAllMocks();
});

/// A fresh store that hears frames addressed to this window, with the
/// replies it posts.
async function freshStore(): Promise<{ hear: (frame: Record<string, unknown>) => void; replies: Reply[] }> {
  const client = await import("../api/client");
  const replies: Reply[] = [];
  vi.spyOn(client.api, "windowReply").mockImplementation(async (reply) => {
    replies.push(reply as Reply);
  });
  const store = await import("./store.svelte");
  return {
    hear: (frame) => store.onWatchEvent({ ...frame, window_id: client.sessionWindowId() }),
    replies,
  };
}

/// One turn of the event loop: every microtask queued before it has run.
function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a job whose engine cannot be loaded is answered ok: false with the error", async () => {
  let tried: () => void = () => {};
  const loadTried = new Promise<void>((resolve) => (tried = resolve));
  vi.doMock(ENGINE, () => {
    tried();
    throw new Error("export engine failed to load");
  });
  const { hear, replies } = await freshStore();

  hear(JOB);
  // From the failed load to the reply the store's handler runs on promises
  // alone, so it is through by the turn after the load was tried.
  await loadTried;
  await turn();

  expect(
    replies.map((reply) => ({ ...reply, payload: { ...reply.payload, error: typeof reply.payload?.error } })),
    "the replies the window posted",
  ).toEqual([{ requestId: "job-1", payload: { ok: false, error: "string" } }]);
  // The runner words a mocked module's failed load its own way, so the text
  // is not the factory's.
  expect(replies[0]!.payload!.error, "the error says something").not.toBe("");
});

/// Mock the engine to hold each job it is handed, with the stop signal the
/// store gave it, until the case ends it. `handed(n)` resolves once the
/// store has handed it `n` jobs.
function heldEngine(): {
  signals: Array<AbortSignal | undefined>;
  end: () => void;
  handed: (count: number) => Promise<void>;
} {
  let waiting: Array<{ count: number; reached: () => void }> = [];
  const held = {
    signals: [] as Array<AbortSignal | undefined>,
    end: () => {},
    handed: (count: number) =>
      new Promise<void>((reached) => {
        if (held.signals.length >= count) reached();
        else waiting.push({ count, reached });
      }),
  };
  vi.doMock(ENGINE, () => ({
    respondExportJob: (_frame: unknown, _theme: unknown, _seams: unknown, stop?: AbortSignal) => {
      held.signals.push(stop);
      for (const wait of waiting) if (held.signals.length >= wait.count) wait.reached();
      waiting = waiting.filter((wait) => held.signals.length < wait.count);
      return new Promise<void>((resolve) => (held.end = resolve));
    },
  }));
  return held;
}

const stopOf = (id: string): Record<string, unknown> => ({ type: "window_command", command: "export-stop", id });
const aborted = (signals: Array<AbortSignal | undefined>): Array<boolean | undefined> =>
  signals.map((signal) => signal?.aborted);

test("an export-stop for a job the window is running aborts the signal its engine holds", async () => {
  const engine = heldEngine();
  const { hear } = await freshStore();

  hear(JOB);
  await engine.handed(1);
  expect(aborted(engine.signals), "the signal handed to the engine, before a stop").toEqual([false]);

  hear(stopOf("job-1"));
  expect(aborted(engine.signals), "the signal after the job's stop").toEqual([true]);
});

test("an export-stop for another id, or for a job that has ended, stops nothing", async () => {
  const engine = heldEngine();
  const { hear } = await freshStore();

  hear(JOB);
  await engine.handed(1);
  hear(stopOf("job-2"));
  expect(aborted(engine.signals), "the signal after a stop for another id").toEqual([false]);

  // The store ends the job on promises alone once the engine has answered.
  engine.end();
  await turn();
  hear({ ...JOB, id: "job-2" });
  await engine.handed(2);
  hear(stopOf("job-1"));
  expect(aborted(engine.signals), "both signals after a stop for the ended job").toEqual([false, false]);
});
