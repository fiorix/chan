import assert from "node:assert/strict";
import test from "node:test";
import { pressTwice } from "../checks/240-dashboard-search-levels.mjs";

// Captured by check 240; failure cases alter the class state or elapsed time.
const observed = {
  "before": {
    "entered": true,
    "enteredAt": 8275.400000095367,
    "firstAt": 8267.700000286102,
    "secondAt": null,
    "secondSettling": null,
    "settling": true,
    "readAt": 8379.700000286102
  },
  "after": {
    "entered": true,
    "enteredAt": 8275.400000095367,
    "firstAt": 8267.700000286102,
    "secondAt": 8380.900000095367,
    "secondSettling": true,
    "settling": true,
    "readAt": 8384.10000038147
  }
};

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
  const { before, after } = observed;
  const page = pageWith(before, after);
  const result = await pressTwice(page, { x: 30, y: 40 }, true);
  assert.deepEqual(result, { before, after });
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40], ["down", { clickCount: 2 }], ["up", { clickCount: 2 }]]);
  assert.equal(page.calls.at(-1), "evaluate", "observer cleanup runs after the second reading");
});

test("Details never entering settling remains a defect, not an environment refusal", async () => {
  const page = pageWith({ ...observed.before, entered: false, settling: false, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), (error) =>
    /never entered/.test(error.message) && error.code !== "ENVIRONMENT_DETAILS_SETTLE_ELAPSED");
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40]], "the unguarded second click was not sent");
  assert.equal(page.calls.at(-1), "evaluate", "the observer is removed on refusal");
});

test("a settle window seen and then expired refuses before the second press", async () => {
  const page = pageWith({ ...observed.before, entered: true, readAt: observed.before.enteredAt + 600, settling: false, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), { code: "ENVIRONMENT_DETAILS_SETTLE_ELAPSED" });
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40]], "an expired window cannot send the second click");
  assert.equal(page.calls.at(-1), "evaluate", "the observer is removed on expiry");
});

test("expiry between the pre-click read and the real second event is an environment refusal", async () => {
  const page = pageWith({ ...observed.before, entered: true, readAt: observed.before.enteredAt + 100, settling: true, secondSettling: null }, { ...observed.after, entered: true, readAt: observed.before.enteredAt + 600, settling: false, secondSettling: false });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), { code: "ENVIRONMENT_DETAILS_SETTLE_ELAPSED" });
  assert.equal(page.calls.filter(Array.isArray).length, 3, "both presses occurred before delivery lag was known");
});

test("a settle window that clears well before its duration is a defect", async () => {
  const page = pageWith({ ...observed.before, entered: true, readAt: observed.before.enteredAt + 100, settling: false, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), { code: "DETAILS_SETTLE_ENDED_EARLY" });
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40]]);
});

test("an early-cleared window at the second event is also a defect", async () => {
  const page = pageWith({ ...observed.before, entered: true, readAt: observed.before.enteredAt + 100, settling: true, secondSettling: null }, { ...observed.after, entered: true, readAt: observed.before.enteredAt + 150, settling: false, secondSettling: false });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), { code: "DETAILS_SETTLE_ENDED_EARLY" });
});

test("a reload that removes the observation does not mask the first failure", async () => {
  const page = pageWith();
  let calls = 0;
  page.evaluate = async (run) => {
    calls++;
    if (calls === 1) return;
    if (calls === 2) throw new Error("page reloaded");
    globalThis.window = {};
    try { return run(); } finally { delete globalThis.window; }
  };
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), /page reloaded/);
});

test("an unobserved second mousedown cannot pass as a live settle window", async () => {
  const page = pageWith({ ...observed.before, entered: true, settling: true, secondSettling: null });
  await assert.rejects(pressTwice(page, { x: 30, y: 40 }, true), /second mousedown was not observed/);
  assert.equal(page.calls.at(-1), "evaluate", "the observer is removed after the missing event");
});

test("ordinary double-click legs do not require Details' overlay", async () => {
  const page = pageWith();
  await pressTwice(page, { x: 30, y: 40 });
  assert.equal(page.calls.includes("evaluate"), false);
  assert.deepEqual(page.calls.filter(Array.isArray), [["click", 30, 40], ["down", { clickCount: 2 }], ["up", { clickCount: 2 }]]);
});
