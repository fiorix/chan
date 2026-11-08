// A pane strip whose tabs need more room than a narrow window gives it, read
// as the page lays it out. Only the tabs scroll: the side toggle and the pane
// menu stay whole at the strip's right end beside an empty stretch, a scroll
// button stands on each side of the tabs and reads as disabled at its end,
// the buttons, a vertical wheel and a drag held over a button move the tabs,
// and the active tab is in view after it changes. The strip in the window tab
// bar, which a stored chan.windowTabBar of 1 draws in a browser, holds the
// same. Files tabs fill the strip, since they hold no server session.

import { dispatchCommand } from "../lib/pane-strip.mjs";

const BAR_KEY = "chan.windowTabBar";
const PANE_STRIP = ".pane .tabs";
const BAR_STRIP = ".app > .window-tab-bar .slot > .tabs";
const FILE_MIME = "application/x-md-file";
const MAX_TABS = 24;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/// The strip's parts as laid out: boxes, the viewport's scroll metrics, the
/// buttons' state and where the active tab sits.
function readStrip(page, selector) {
  return page.evaluate((sel) => {
    const strip = document.querySelector(sel);
    if (!strip) return null;
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const view = strip.querySelector(":scope > .tab-scroll");
    const tabs = view ? [...view.querySelectorAll(".tab")] : [];
    const active = view?.querySelector(".tab.active") ?? null;
    const button = (side) => {
      const el = strip.querySelector(`:scope > .tab-scroll-button.${side}`);
      return el ? { box: box(el), disabled: el.getAttribute("aria-disabled") === "true" } : null;
    };
    return {
      inBar: strip.classList.contains("in-bar"),
      strip: box(strip),
      view: box(view),
      scrollLeft: view?.scrollLeft ?? 0,
      scrollWidth: view?.scrollWidth ?? 0,
      clientWidth: view?.clientWidth ?? 0,
      tabs: tabs.length,
      active: box(active),
      activeIndex: tabs.indexOf(active),
      deadZone: box(strip.querySelector(":scope > .dead-zone")),
      actions: box(strip.querySelector(":scope > .actions")),
      toggle: box(strip.querySelector(":scope > .actions .side-toggle")),
      menu: box(strip.querySelector(":scope > .actions .hamburger-trigger")),
      left: button("left"),
      right: button("right"),
      innerWidth: window.innerWidth,
    };
  }, selector);
}

/// Wait until the viewport's scroll offset holds still, past a smooth scroll.
async function settled(page, selector) {
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    const state = await readStrip(page, selector);
    if (last && state && Math.abs(state.scrollLeft - last.scrollLeft) < 0.5) return state;
    last = state;
    await sleep(80);
  }
  return last;
}

async function waitStrip(page, selector, label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readStrip(page, selector);
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`${label}: not reached within ${timeoutMs}ms; the strip reads ${JSON.stringify(last)}`);
}

/// Open Files tabs one at a time until the strip draws its scroll buttons.
async function fillStrip(page, selector, label) {
  let state = await readStrip(page, selector);
  while (!state?.left) {
    check((state?.tabs ?? 0) < MAX_TABS, `${label}: ${state?.tabs} tabs and the strip still fits: ${JSON.stringify(state)}`);
    const before = state?.tabs ?? 0;
    await dispatchCommand(page, "app.files.toggle");
    state = await waitStrip(page, selector, `${label}: tab ${before + 1}`, (s) => s.tabs === before + 1);
    await sleep(150);
    state = await readStrip(page, selector);
  }
  return settled(page, selector);
}

function inView(state) {
  return state.active && state.active.left >= state.view.left - 0.5 && state.active.right <= state.view.right + 0.5;
}

/// Every overflow invariant of one reading.
function assertOverflowing(state, label, minDeadZone) {
  check(state.left && state.right, `${label}: no scroll buttons: ${JSON.stringify(state)}`);
  check(state.scrollWidth > state.clientWidth, `${label}: the tabs do not overflow their viewport`);
  check(state.left.box.right <= state.view.left + 0.5, `${label}: the left button is not before the tabs`);
  check(state.right.box.left >= state.view.right - 0.5, `${label}: the right button is not after the tabs`);
  check(state.deadZone.left >= state.right.box.right - 0.5, `${label}: the dead zone is not after the right button`);
  check(state.deadZone.width >= minDeadZone - 0.5, `${label}: the dead zone is ${state.deadZone.width}px, under ${minDeadZone}px`);
  check(state.actions.left >= state.deadZone.right - 0.5, `${label}: the actions are not after the dead zone`);
  check(state.actions.right <= state.strip.right + 0.5, `${label}: the actions run past the strip's end`);
  for (const [name, part] of [["side toggle", state.toggle], ["pane menu", state.menu]]) {
    check(part && part.width > 0 && part.left >= 0 && part.right <= state.innerWidth, `${label}: the ${name} is not whole in the window: ${JSON.stringify(part)}`);
  }
  const atStart = state.scrollLeft <= 1;
  const atEnd = state.scrollLeft >= state.scrollWidth - state.clientWidth - 1;
  check(state.left.disabled === atStart, `${label}: the left button reads disabled=${state.left.disabled} at scrollLeft ${state.scrollLeft}`);
  check(state.right.disabled === atEnd, `${label}: the right button reads disabled=${state.right.disabled} at scrollLeft ${state.scrollLeft}`);
}

/// Press a scroll button until it reads as disabled.
async function pageToEnd(page, selector, side, label) {
  for (let i = 0; i < 20; i += 1) {
    const state = await settled(page, selector);
    if (state[side].disabled) return state;
    await page.click(`${selector} > .tab-scroll-button.${side}`);
  }
  throw new Error(`${label}: the ${side} button never reached its end`);
}

/// A file-tree drag held over the right button, then taken off it.
async function dragOverRight(page, selector) {
  await page.evaluate((sel, mime) => {
    const strip = document.querySelector(sel);
    const button = strip.querySelector(":scope > .tab-scroll-button.right");
    const dt = new DataTransfer();
    dt.setData(mime, JSON.stringify({ path: "none.md" }));
    window.__stripOverflowDrag = dt;
    const r = button.getBoundingClientRect();
    for (const type of ["dragenter", "dragover"]) {
      button.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
    }
  }, selector, FILE_MIME);
  const moving = await waitStrip(page, selector, "the drag over the right button", (s) => s.scrollLeft > 40, 5_000);
  const highlighted = await page.$eval(selector, (strip) => strip.classList.contains("drop-active"));
  await page.evaluate((sel) => {
    const strip = document.querySelector(sel);
    const button = strip.querySelector(":scope > .tab-scroll-button.right");
    const dt = window.__stripOverflowDrag;
    button.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget: document.body }));
    strip.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget: document.body }));
    delete window.__stripOverflowDrag;
  }, selector);
  const stopped = await readStrip(page, selector);
  await sleep(300);
  const after = await readStrip(page, selector);
  return { moving: moving.scrollLeft, highlighted, stoppedAt: stopped.scrollLeft, after: after.scrollLeft };
}

/// The checks every strip goes through once it overflows.
async function exercise(ctx, selector, label, minDeadZone) {
  const { page } = ctx;
  const evidence = {};

  // Filled to overflow, the newest tab is active and in view, at the end.
  const full = await fillStrip(page, selector, label);
  assertOverflowing(full, `${label} filled`, minDeadZone);
  check(inView(full), `${label} filled: the active tab is out of view: ${JSON.stringify(full)}`);
  evidence.full = full;
  await ctx.shot(`210-${label}-overflow`);

  // The left button pages back to the start.
  const start = await pageToEnd(page, selector, "left", `${label} paging left`);
  assertOverflowing(start, `${label} at the start`, minDeadZone);
  check(start.scrollLeft <= 1, `${label}: the left button stopped at ${start.scrollLeft}`);
  evidence.start = start;
  await ctx.shot(`210-${label}-start`);

  // A vertical wheel over the tabs scrolls them sideways.
  const view = start.view;
  await page.mouse.move(view.left + view.width / 2, view.top + view.height / 2);
  await page.mouse.wheel({ deltaY: 200 });
  const wheeled = await waitStrip(page, selector, `${label} wheel`, (s) => s.scrollLeft > 50, 5_000);
  assertOverflowing(wheeled, `${label} after the wheel`, minDeadZone);
  evidence.wheel = wheeled.scrollLeft;

  // The first tab made active comes back into view by its left edge.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.jump", index: 0 } })));
  const first = await waitStrip(page, selector, `${label} first tab`, (s) => s.activeIndex === 0 && inView(s));
  check(first.scrollLeft <= 1, `${label}: the first tab came in at scrollLeft ${first.scrollLeft}`);

  // The right button pages forward from there.
  await page.click(`${selector} > .tab-scroll-button.right`);
  const forward = await settled(page, selector);
  check(forward.scrollLeft > first.scrollLeft + 20, `${label}: the right button moved the tabs from ${first.scrollLeft} to ${forward.scrollLeft}`);
  assertOverflowing(forward, `${label} after the right button`, minDeadZone);

  // The last tab made active comes into view by its right edge.
  await page.evaluate((index) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.jump", index } })), full.tabs - 1);
  const last = await waitStrip(page, selector, `${label} last tab`, (s) => s.activeIndex === s.tabs - 1 && inView(s));
  assertOverflowing(last, `${label} with the last tab active`, minDeadZone);
  check(last.right.disabled, `${label}: the last tab active leaves the tabs short of their end`);
  evidence.last = last;

  // A drag held over the right button scrolls the tabs, from the start.
  await pageToEnd(page, selector, "left", `${label} back to the start`);
  const drag = await dragOverRight(page, selector);
  check(drag.highlighted, `${label}: the strip did not take the drag over its button`);
  check(Math.abs(drag.after - drag.stoppedAt) < 0.5, `${label}: the scroll went on after the drag left the button: ${JSON.stringify(drag)}`);
  evidence.drag = drag;
  return evidence;
}

export default {
  name: "pane-strip-overflow",
  async run(ctx) {
    const { page } = ctx;
    await page.setViewport({ width: 720, height: 640 });
    await page.waitForSelector(PANE_STRIP, { timeout: 30_000 });

    // One tab fits: no buttons, and the strip keeps its height when it
    // overflows later.
    await dispatchCommand(page, "app.files.toggle");
    const one = await waitStrip(page, PANE_STRIP, "one Files tab", (s) => s.tabs >= 1);
    check(!one.left && !one.right, `one tab drew scroll buttons: ${JSON.stringify(one)}`);
    check(one.scrollWidth <= one.clientWidth, `one tab overflows: ${JSON.stringify(one)}`);
    await ctx.shot("210-fits");

    try {
      const pane = await exercise(ctx, PANE_STRIP, "pane", 24);
      check(Math.abs(pane.full.strip.height - one.strip.height) < 0.5, `the strip is ${pane.full.strip.height}px tall overflowing, ${one.strip.height}px fitting`);

      await page.evaluate((key) => localStorage.setItem(key, "1"), BAR_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(BAR_STRIP, { timeout: 30_000 });
      await sleep(500);
      const bar = await exercise(ctx, BAR_STRIP, "bar", 40);
      check(bar.full.inBar, "the bar's strip is not marked in-bar");
      return { one, pane, bar };
    } finally {
      await page.evaluate((key) => localStorage.removeItem(key), BAR_KEY).catch(() => {});
    }
  },
};
