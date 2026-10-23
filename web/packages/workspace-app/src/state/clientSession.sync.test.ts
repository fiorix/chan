// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?kind=terminal&w=w-source&h=home");
});
afterEach(() => vi.restoreAllMocks());

function deferredReply() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function sessionView() {
  const store = await import("./store.svelte");
  const state = await import("./clientSession.svelte");
  const { api } = await import("../api/client");
  const identify = (id: string) => store.onWatchEvent({
    type: "window_command", command: "session_identify", window_id: "w-source", request_id: id,
  });
  const end = (id: string) => store.onWatchEvent({
    type: "window_command", command: "session_identify_end", window_id: "w-source", request_id: id,
  });
  const sync = (ids: string[]) => store.onWatchEvent({ type: "session_identify_sync", request_ids: ids });
  return { ...state, api, identify, end, sync };
}

test.each(["timeout", "caller EOF", "another client's answer"])(
  "a sync clears a card whose %s end frame was missed",
  async () => {
    const { api, clientSession, identify, sync, answerClientIdentification } = await sessionView();
    const replyResult = deferredReply();
    vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
    identify("expired-request");
    expect(clientSession.requestId).toBe("expired-request");
    const answer = answerClientIdentification(true);

    sync([]);

    expect(clientSession.requestId).toBeNull();
    expect(clientSession.busy).toBe(false);
    replyResult.resolve();
    await answer;
  },
);

test("a sync opens a card whose request frame was missed", async () => {
  const { clientSession, sync } = await sessionView();
  expect(clientSession.requestId).toBeNull();

  sync(["pending-request"]);

  expect(clientSession.requestId).toBe("pending-request");
  expect(clientSession.busy).toBe(false);
});

test("a reconnect keeps a live card and its answer in flight", async () => {
  const { api, clientSession, identify, sync, answerClientIdentification } = await sessionView();
  const replyResult = deferredReply();
  vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
  identify("live-request");
  const answer = answerClientIdentification(true);

  sync(["other-request", "live-request"]);

  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  replyResult.resolve();
  await answer;
});

test("an older end frame leaves the card restored for a newer request", async () => {
  const { clientSession, identify, end, sync } = await sessionView();
  identify("old-request");
  sync(["new-request"]);
  end("old-request");

  expect(clientSession.requestId).toBe("new-request");
});

for (const replacement of ["sync", "start"] as const) {
  for (const oldOutcome of ["success", "error"] as const) {
    test(`an old ${oldOutcome} reply cannot unlock a new reply after ${replacement}`, async () => {
      const { api, clientSession, identify, end, sync, answerClientIdentification } = await sessionView();
      const oldReply = deferredReply();
      const newReply = deferredReply();
      const reply = vi.spyOn(api, "windowReply").mockImplementation(({ requestId }) =>
        requestId === "old-request" ? oldReply.promise : newReply.promise);
      clientSession.id = "client-home";

      identify("old-request");
      const oldAnswer = answerClientIdentification(true);
      if (replacement === "sync") sync(["new-request"]);
      else {
        identify("new-request");
        end("old-request");
      }
      expect(clientSession.requestId).toBe("new-request");
      expect(clientSession.busy).toBe(false);

      const newAnswer = answerClientIdentification(true);
      expect(clientSession.busy).toBe(true);
      if (oldOutcome === "success") oldReply.resolve();
      else oldReply.reject(new Error("old request expired"));
      await oldAnswer;

      expect(clientSession.requestId).toBe("new-request");
      expect(clientSession.busy).toBe(true);
      await answerClientIdentification(false);
      expect(reply.mock.calls.map(([call]) => call)).toEqual([
        { requestId: "old-request", payload: { client_id: "client-home" } },
        { requestId: "new-request", payload: { client_id: "client-home" } },
      ]);

      newReply.resolve();
      await newAnswer;
      expect(clientSession.requestId).toBe("new-request");
      expect(clientSession.busy).toBe(true);
      end("new-request");
      expect(clientSession.requestId).toBeNull();
      expect(clientSession.busy).toBe(false);
    });
  }
}

test("an old reply may finish before the replacement card is answered", async () => {
  const { api, clientSession, identify, sync, answerClientIdentification } = await sessionView();
  const oldReply = deferredReply();
  const newReply = deferredReply();
  const reply = vi.spyOn(api, "windowReply").mockImplementation(({ requestId }) =>
    requestId === "old-request" ? oldReply.promise : newReply.promise);
  identify("old-request");
  const oldAnswer = answerClientIdentification(true);
  sync(["new-request"]);
  oldReply.resolve();
  await oldAnswer;

  expect(clientSession.requestId).toBe("new-request");
  expect(clientSession.busy).toBe(false);
  const newAnswer = answerClientIdentification(true);
  expect(clientSession.busy).toBe(true);
  expect(reply).toHaveBeenCalledTimes(2);
  newReply.resolve();
  await newAnswer;
});

test("a sync retaining the active request keeps its answer locked", async () => {
  const { api, clientSession, identify, end, sync, answerClientIdentification } = await sessionView();
  const replyResult = deferredReply();
  const reply = vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
  identify("live-request");
  const answer = answerClientIdentification(true);
  sync(["other-request", "live-request"]);

  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  await answerClientIdentification(false);
  expect(reply).toHaveBeenCalledTimes(1);
  replyResult.resolve();
  await answer;
  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  end("live-request");
  expect(clientSession.requestId).toBe("other-request");
  expect(clientSession.busy).toBe(false);
  end("other-request");
  expect(clientSession.requestId).toBeNull();
});

test("a duplicate start keeps the shown request locked until its end frame", async () => {
  const { api, clientSession, identify, end, sync, answerClientIdentification } = await sessionView();
  const replyResult = deferredReply();
  const reply = vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
  clientSession.id = "client-home";
  sync(["live-request"]);
  const answer = answerClientIdentification(true);

  identify("live-request");
  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  await answerClientIdentification(false);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledWith({ requestId: "live-request", payload: { client_id: "client-home" } });

  replyResult.resolve();
  await answer;
  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  end("live-request");
  expect(clientSession.requestId).toBeNull();
  expect(clientSession.busy).toBe(false);
});

test.each([false, true])("an accepted answer stays locked before a buffered start, replay=%s", async (replay) => {
  const { api, clientSession, identify, end, sync, answerClientIdentification } = await sessionView();
  const reply = vi.spyOn(api, "windowReply").mockResolvedValue(undefined);
  clientSession.id = "client-home";
  sync(["live-request"]);

  await answerClientIdentification(true);
  if (replay) identify("live-request");
  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  await answerClientIdentification(false);
  expect(reply).toHaveBeenCalledExactlyOnceWith({
    requestId: "live-request", payload: { client_id: "client-home" },
  });

  end("live-request");
  expect(clientSession.requestId).toBeNull();
  expect(clientSession.busy).toBe(false);
});

test("a sync retains an accepted answer's lock until the request leaves the snapshot", async () => {
  const { api, clientSession, sync, answerClientIdentification } = await sessionView();
  vi.spyOn(api, "windowReply").mockResolvedValue(undefined);
  sync(["live-request"]);
  await answerClientIdentification(true);

  sync(["live-request"]);
  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(true);
  sync([]);
  expect(clientSession.requestId).toBeNull();
  expect(clientSession.busy).toBe(false);
});

test("a rejected answer reports the error and a later sync restores an unlocked card", async () => {
  const { api, clientSession, sync, answerClientIdentification } = await sessionView();
  const { setNotifyHandler } = await import("./notify.svelte");
  const notifications: string[] = [];
  setNotifyHandler((message) => notifications.push(message));
  vi.spyOn(api, "windowReply").mockRejectedValue(new Error("reply failed"));
  sync(["live-request"]);
  await answerClientIdentification(true);

  expect(clientSession.requestId).toBeNull();
  expect(clientSession.busy).toBe(false);
  expect(notifications).toEqual(["session identification: reply failed"]);
  sync(["live-request"]);
  expect(clientSession.requestId).toBe("live-request");
  expect(clientSession.busy).toBe(false);
});

test("an empty sync does not restore an obsolete request when its reply finishes", async () => {
  const { api, clientSession, identify, sync, answerClientIdentification } = await sessionView();
  const replyResult = deferredReply();
  vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
  identify("old-request");
  const answer = answerClientIdentification(true);
  sync([]);
  replyResult.resolve();
  await answer;

  expect(clientSession.requestId).toBeNull();
  expect(clientSession.busy).toBe(false);
});

test("buffered starts cannot unlock an answer or lose another pending request", async () => {
  const { api, clientSession, identify, end, sync, answerClientIdentification } = await sessionView();
  const replyResult = deferredReply();
  const reply = vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
  clientSession.id = "client-home";
  sync(["a-new", "z-old"]);
  const answer = answerClientIdentification(true);

  identify("z-old");
  identify("a-new");
  expect(clientSession.requestId).toBe("a-new");
  expect(clientSession.busy).toBe(true);
  await answerClientIdentification(false);
  expect(reply).toHaveBeenCalledExactlyOnceWith({ requestId: "a-new", payload: { client_id: "client-home" } });

  end("a-new");
  expect(clientSession.requestId).toBe("z-old");
  expect(clientSession.busy).toBe(false);
  replyResult.resolve();
  await answer;
  expect(clientSession.requestId).toBe("z-old");
  end("z-old");
  expect(clientSession.requestId).toBeNull();
});

test("an end removes only its request from a recovered snapshot", async () => {
  const { clientSession, end, sync } = await sessionView();
  sync(["a-first", "z-second"]);
  end("a-first");
  expect(clientSession.requestId).toBe("z-second");
  end("z-second");
  expect(clientSession.requestId).toBeNull();
});

test.each(["success", "error"] as const)("a %s answer changes only its own card", async (outcome) => {
  const { api, clientSession, end, sync, answerClientIdentification } = await sessionView();
  const { setNotifyHandler } = await import("./notify.svelte");
  const notifications: string[] = [];
  setNotifyHandler((message) => notifications.push(message));
  const replyResult = deferredReply();
  vi.spyOn(api, "windowReply").mockReturnValue(replyResult.promise);
  sync(["a-first", "z-second"]);
  const answer = answerClientIdentification(true);

  if (outcome === "success") replyResult.resolve();
  else replyResult.reject(new Error("request expired"));
  await answer;

  if (outcome === "success") {
    expect(clientSession.requestId).toBe("a-first");
    expect(clientSession.busy).toBe(true);
    end("a-first");
  }
  expect(clientSession.requestId).toBe("z-second");
  expect(clientSession.busy).toBe(false);
  expect(notifications).toEqual(outcome === "error" ? ["session identification: request expired"] : []);
});

test("starts and syncs retain pending arrival order without duplicates", async () => {
  const { clientSession, identify, end, sync } = await sessionView();
  identify("z-first");
  identify("a-second");
  sync(["a-second", "b-third", "z-first"]);
  identify("a-second");
  expect(clientSession.requestId).toBe("z-first");
  end("z-first");
  expect(clientSession.requestId).toBe("a-second");
  end("a-second");
  expect(clientSession.requestId).toBe("b-third");
  end("b-third");
  expect(clientSession.requestId).toBeNull();
});

test("a sync that drops the answering request unlocks the next card", async () => {
  const { api, clientSession, sync, answerClientIdentification } = await sessionView();
  const oldReply = deferredReply();
  const newReply = deferredReply();
  const reply = vi.spyOn(api, "windowReply").mockImplementation(({ requestId }) =>
    requestId === "a-first" ? oldReply.promise : newReply.promise);
  sync(["a-first", "z-second"]);
  const oldAnswer = answerClientIdentification(true);

  sync(["z-second"]);
  expect(clientSession.requestId).toBe("z-second");
  expect(clientSession.busy).toBe(false);
  const newAnswer = answerClientIdentification(true);
  expect(clientSession.busy).toBe(true);
  oldReply.resolve();
  await oldAnswer;
  expect(clientSession.requestId).toBe("z-second");
  expect(clientSession.busy).toBe(true);
  expect(reply.mock.calls.map(([call]) => call.requestId)).toEqual(["a-first", "z-second"]);
  newReply.resolve();
  await newAnswer;
  expect(clientSession.requestId).toBe("z-second");
  expect(clientSession.busy).toBe(true);
  sync([]);
  expect(clientSession.requestId).toBeNull();
});

test("detach clears all pending identification cards", async () => {
  const { clientSession, end, sync } = await sessionView();
  const { markClientDetached } = await import("../api/clientSession");
  sync(["a-first", "z-second"]);
  markClientDetached();
  expect(clientSession.requestId).toBeNull();
  expect(clientSession.busy).toBe(false);
  end("a-first");
  expect(clientSession.requestId).toBeNull();
});
