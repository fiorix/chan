import assert from "node:assert/strict";
import { test } from "node:test";
import { armCardFlip } from "./card-flip.mjs";

function fixture(t, count = 1) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
  };
  t.after(() => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.MutationObserver = saved.MutationObserver;
  });

  const roots = Array.from({ length: count }, () => {
    const root = { active: false };
    root.classList = { contains: (name) => name === "flipActive" && root.active };
    return root;
  });
  globalThis.document = { querySelectorAll: (selector) => selector === ".card-flip" ? roots : [] };
  globalThis.window = {};
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.push(this); }
    disconnect() { this.disconnected = true; }
  };

  const page = {
    evaluate: async (fn, ...args) => fn(...args),
    waitForFunction: async (fn, _options, ...args) => {
      if (!fn(...args)) throw new Error("timeout");
    },
  };
  return {
    page,
    roots,
    setActive(active) {
      roots[0].active = active;
      for (const observer of observers) if (!observer.disconnected) observer.callback();
    },
    observers,
  };
}

test("the card flip settles only after an observed start and end", async (t) => {
  const f = fixture(t);
  const flip = await armCardFlip(f.page, ".card-flip");
  f.setActive(true);
  f.setActive(false);
  await flip.settled("add card");
  await flip.assertSettled("add card");
  assert.equal(f.observers[0].disconnected, true);
});

test("an unobserved end cannot settle the card", async (t) => {
  const f = fixture(t);
  const flip = await armCardFlip(f.page, ".card-flip");
  f.setActive(true);
  f.roots[0].active = false;
  await assert.rejects(flip.settled("add card", 1), /"started":true,"ended":false/);
  assert.equal(f.observers[0].disconnected, true);
});

test("arming requires exactly one inactive card", async (t) => {
  const f = fixture(t, 2);
  await assert.rejects(armCardFlip(f.page, ".card-flip"), /target count is 2/);
  f.roots.pop();
  f.roots[0].active = true;
  await assert.rejects(armCardFlip(f.page, ".card-flip"), /already active/);
});
