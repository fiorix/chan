import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { showCarouselCard } from "./carousel.mjs";

const TARGET = '[aria-label="Connect shared-lab"]';
const CARD = '[role="group"][aria-roledescription="card"]';
const DECK = '[role="region"][aria-roledescription="carousel"]';

function fixture(t, options = {}) {
  const saved = Object.fromEntries(["document", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const state = {
    active: options.active ?? 0, frames: 0, clicks: 0, disposed: 0, flushes: 0,
    starts: 0, ends: 0, runningReads: 0, animation: null,
    pendingAt: options.pending ? 2 : null,
  };
  let finish;
  function end() {
    if (!state.animation) return;
    state.animation.playState = "finished";
    state.ends += 1;
    finish();
    state.animation = null;
  }
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => {
    state.frames += 1;
    if (state.pendingAt === state.frames) {
      state.pendingAt = null;
      state.starts += 1;
      state.animation = { playState: "running", pending: false, finished: new Promise((resolve) => { finish = resolve; }) };
      if (options.autoFinish !== false) setTimeout(end, 0);
    }
    callback();
  }, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  const ring = {
    getBoundingClientRect: () => { state.flushes += 1; return {}; },
    getAnimations: () => {
      if (state.animation) state.runningReads += 1;
      return state.animation ? [state.animation] : [];
    },
  };
  globalThis.getComputedStyle = () => ({ transform: `turn(${state.active})` });
  const labels = ["All windows, 1 of 3", "This machine, 2 of 3", "shared-lab, 3 of 3"];
  const cards = labels.map((label, index) => ({
    getAttribute: (name) => name === "aria-label" ? label : name === "aria-current" && state.active === index ? "true" : null,
    closest: (selector) => selector === DECK ? deck : null,
    parentElement: ring,
  }));
  const next = {
    async click() {
      assert.equal(state.animation, null, "the pointer cannot act while the ring moves");
      state.clicks += 1;
      if (options.noTurn) return;
      state.active = (state.active + 1) % cards.length;
      if (!options.reducedMotion) state.pendingAt = state.frames + 2;
    },
  };
  const deck = {
    getAttribute: () => "Computers",
    querySelectorAll: (selector) => selector === CARD ? cards : [],
    querySelector: (selector) => selector === 'button[aria-label="Next card"]' ? next : null,
  };
  const control = {
    closest: (selector) => selector === CARD ? cards[2] : selector === DECK ? deck :
      selector === "[inert]" && (state.active !== 2 || options.inert) ? {} : null,
  };
  globalThis.document = {
    querySelector: (selector) => selector === TARGET ? control : null,
    querySelectorAll: (selector) => selector === TARGET ? Array(options.controls ?? 1).fill(control) : [],
  };
  const page = {
    evaluate: async (fn, ...args) => fn(...args),
    waitForSelector: async () => {},
    waitForFunction: async (fn, _options, ...args) => {
      if (!fn(...args)) throw new Error("card did not change before timeout");
    },
    evaluateHandle: async (fn, ...args) => {
      const element = fn(...args);
      return { asElement: () => element, dispose: async () => { state.disposed += 1; } };
    },
  };
  return { page, state, end };
}

test("the deck arrows bring the control forward after each observed animation ends", async (t) => {
  const f = fixture(t);
  await showCarouselCard(f.page, TARGET);
  assert.equal(f.state.active, 2);
  assert.equal(f.state.clicks, 2);
  assert.equal(f.state.disposed, 2);
  assert.equal(f.state.starts, 2);
  assert.equal(f.state.ends, 2);
  assert.equal(f.state.flushes, 3);
});

test("an active card does not settle during the idle frames before its transition starts", async (t) => {
  const f = fixture(t, { active: 2, pending: true, autoFinish: false });
  let settled = false;
  const ready = showCarouselCard(f.page, TARGET).then(() => { settled = true; });
  for (let attempt = 0; attempt < 100 && !f.state.runningReads; attempt += 1) await delay(1);
  assert.equal(f.state.starts, 1);
  assert.ok(f.state.runningReads > 0, "the barrier observes the delayed transition");
  assert.equal(settled, false);
  f.end();
  await ready;
  assert.equal(settled, true);
  assert.equal(f.state.clicks, 0);
});

test("reduced motion needs the front card but no invented animation", async (t) => {
  const f = fixture(t, { reducedMotion: true });
  await showCarouselCard(f.page, TARGET);
  assert.equal(f.state.clicks, 2);
  assert.equal(f.state.starts, 0);
});

test("a transition that never finishes fails with the active card and motion state", async (t) => {
  const f = fixture(t, { active: 2, pending: true, autoFinish: false });
  await assert.rejects(showCarouselCard(f.page, TARGET, 30), (error) => {
    assert.match(error.message, /carousel motion did not settle within 30ms/);
    assert.match(error.message, /"target":"shared-lab, 3 of 3"/);
    assert.match(error.message, /"animations":\[\{"state":"running","pending":false\}\]/);
    return true;
  });
  f.end();
});

test("an inert front card cannot pass and navigation is bounded to one full turn", async (t) => {
  const f = fixture(t, { active: 2, inert: true, reducedMotion: true });
  await assert.rejects(showCarouselCard(f.page, TARGET), /not become interactive after a full turn.*"inert":true/);
  assert.equal(f.state.clicks, 3);
});

test("a deck that ignores Next cannot pass on an idle ring", async (t) => {
  const f = fixture(t, { noTurn: true });
  await assert.rejects(showCarouselCard(f.page, TARGET), /card did not change before timeout/);
  assert.equal(f.state.clicks, 1);
  assert.equal(f.state.disposed, 1);
});

test("ambiguous controls fail before a deck turn", async (t) => {
  const f = fixture(t, { controls: 2 });
  await assert.rejects(showCarouselCard(f.page, TARGET), /control must name one carousel card.*"controls":2/);
  assert.equal(f.state.clicks, 0);
});
