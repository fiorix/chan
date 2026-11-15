import assert from "node:assert/strict";
import { test } from "node:test";
import { waitSaved } from "../checks/290-rich-prompt-disconnected.mjs";

const context = { serverUrl: "http://127.0.0.1:1234/?t=test-token" };
const windowId = "saved window/290";
const name = "Prompt290-xterm";

function pollingPage(t, responses) {
  const observed = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `/api/session?w=${encodeURIComponent(windowId)}`);
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.ok(responses.length, "the poll must not consume an undeclared response");
    return responses.shift();
  });
  return {
    observed,
    waitForFunction: async (predicate, options, args) => {
      assert.equal(options.timeout, 20_000);
      assert.equal(options.polling, 100);
      while (responses.length) {
        const ready = await predicate(args);
        observed.push(ready);
        if (ready) return;
      }
      throw new Error("Waiting failed: 20000ms exceeded");
    },
  };
}

test("a fresh session remains pending before its terminal layout is saved", async (t) => {
  const empty = new Response(null, { status: 204 });
  const parseEmpty = t.mock.method(empty, "json");
  // These HTTP stand-ins isolate the readiness predicate, without a server.
  const page = pollingPage(t, [empty,
    Response.json({ layout: null }),
    Response.json({ layout: { name: "another terminal" } }),
    Response.json({ layout: { name } }),
  ]);
  await waitSaved(context, page, windowId, name);
  assert.deepEqual(page.observed, [false, false, false, true]);
  assert.equal(parseEmpty.mock.callCount(), 0, "204 must not be parsed as JSON");
});

test("an unsaved session cannot satisfy the reload barrier", async (t) => {
  const page = pollingPage(t, [new Response(null, { status: 204 })]);
  await assert.rejects(waitSaved(context, page, windowId, name), /Waiting failed/);
  assert.deepEqual(page.observed, [false]);
});

test("a matching name outside the saved layout cannot satisfy the barrier", async (t) => {
  const page = pollingPage(t, [Response.json({ unrelated: name, layout: null })]);
  await assert.rejects(waitSaved(context, page, windowId, name), /Waiting failed/);
  assert.deepEqual(page.observed, [false]);
});

test("a failed response cannot satisfy the barrier even with a matching body", async (t) => {
  const page = pollingPage(t, [Response.json({ layout: { name } }, { status: 503 })]);
  await assert.rejects(waitSaved(context, page, windowId, name), /Waiting failed/);
  assert.deepEqual(page.observed, [false]);
});

test("malformed successful JSON still fails the barrier", async (t) => {
  const page = pollingPage(t, [new Response("", { status: 200 })]);
  await assert.rejects(waitSaved(context, page, windowId, name), SyntaxError);
  assert.deepEqual(page.observed, []);
});
