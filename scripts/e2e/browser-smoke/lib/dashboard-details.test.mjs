import assert from "node:assert/strict";
import test from "node:test";
import { pressTwice } from "../checks/240-dashboard-search-levels.mjs";

function pageWith(before, after = before) {
  const calls = [];
  const replies = [undefined, before, after, undefined];
  return {
    calls,
    waitForFunction: async () => calls.push("ready"),
    evaluate: async () => { calls.push("evaluate"); return replies.shift(); },
    mouse: Object.fromEntries(["click", "down", "up"].map((name) => [name, async (...args) => calls.push([name, ...args])])),
  };
}

test("Details' live settle window permits the second press", async () => {
  const before = { entered: true, settling: true, secondSettling: null };
  const after = { entered: true, settling: true, secondSettling: true };
  const page = pageWith(before, after);
  const result = await pressTwice(page, { x: 30, y: 40 }, true);
  assert.deepEqual(result, { before, after });
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40], ["down", { clickCount: 2 }], ["up", { clickCount: 2 }]]);
  assert.equal(page.calls.at(-1), "evaluate", "observer cleanup runs after the second reading");
});

test("Details never entering settling remains a defect, not an environment refusal", async () => {
  const page = pageWith({ entered: false, settling: false, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), (error) =>
    /never entered/.test(error.message) && error.code !== "ENVIRONMENT_DETAILS_SETTLE_ELAPSED");
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40]], "the unguarded second click was not sent");
  assert.equal(page.calls.at(-1), "evaluate", "the observer is removed on refusal");
});

test("a settle window seen and then expired refuses before the second press", async () => {
  const page = pageWith({ entered: true, settling: false, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), { code: "ENVIRONMENT_DETAILS_SETTLE_ELAPSED" });
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40]], "an expired window cannot send the second click");
  assert.equal(page.calls.at(-1), "evaluate", "the observer is removed on expiry");
});

test("expiry between the pre-click read and the real second event is an environment refusal", async () => {
  const page = pageWith({ entered: true, settling: true, secondSettling: null }, { entered: true, settling: false, secondSettling: false });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), { code: "ENVIRONMENT_DETAILS_SETTLE_ELAPSED" });
  assert.equal(page.calls.filter(Array.isArray).length, 3, "both presses occurred before delivery lag was known");
});

test("an unobserved second mousedown cannot pass as a live settle window", async () => {
  const page = pageWith({ entered: true, settling: true, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), /second mousedown was not observed/);
  assert.equal(page.calls.at(-1), "evaluate", "the observer is removed after the missing event");
});

test("ordinary double-click legs do not require Details' overlay", async () => {
  const page = pageWith();
  await pressTwice(page, { x: 30, y: 40 });
  assert.equal(page.calls.includes("evaluate"), false);
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40], ["down", { clickCount: 2 }], ["up", { clickCount: 2 }]]);
});
