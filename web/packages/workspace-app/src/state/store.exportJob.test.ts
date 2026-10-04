// @vitest-environment jsdom
//
// A `cs export` job reaches its window as an `export-job` frame, and the
// command waits for the window's reply. The store loads the export engine
// when a job arrives; each case mocks that module its own way, over a fresh
// store.

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

/// Let the store's load of the engine settle, and what it does next run.
async function engineLoaded(): Promise<void> {
  await import(ENGINE).catch(() => {});
  for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a job whose engine cannot be loaded is answered ok: false with the error", async () => {
  vi.doMock(ENGINE, () => {
    throw new Error("export engine failed to load");
  });
  const { hear, replies } = await freshStore();

  hear(JOB);
  await engineLoaded();

  expect(
    replies.map((reply) => ({ ...reply, payload: { ...reply.payload, error: typeof reply.payload?.error } })),
    "the replies the window posted",
  ).toEqual([{ requestId: "job-1", payload: { ok: false, error: "string" } }]);
  expect(replies[0]!.payload!.error, "the error names what failed").toContain("export engine failed to load");
});
