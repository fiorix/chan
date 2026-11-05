// A pane's body takes a dropped tab in its centre, with its tab strip drawn
// or auto-hidden, and still splits at its edges.
//
// Two panes of one window: the left holds two file tabs, so its strip is
// drawn under either preference and its second tab can be dragged. The drags
// are the browser's own: a pointer press and move on the tab starts a native
// drag, which the DevTools protocol intercepts and then delivers as dragover
// and drop at a point, so the page sees trusted events with the payload
// protected while the drag hovers, as with a person's drag. Each arm reads the
// zone the right pane's body paints while the drag hovers there and the
// layout the drop leaves:
//
//   - pane_strip_auto_hide off: the right pane's centre takes the tab, which
//     joins the right pane; nothing splits.
//   - on: the right pane's lone tab draws no strip, and its centre still
//     takes the tab, after which the strip shows the two.
//   - on, the right pane empty: a drop 20px inside its body's left side, in
//     the edge band of a pane that holds a tab, fills the empty pane and
//     splits nothing, since an empty pane's whole body is the centre.
//   - on: the same drop on a right pane holding a tab splits it, and the tab
//     becomes the new pane between the two.
//
// Each arm opens its own window from a layout in the address, so no arm
// inherits another's layout. The preference is restored to what the check
// found.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPaneStripPreference, writePaneStripPreference } from "../lib/pane-strip.mjs";

const FILES = ["centre-drop-a.md", "centre-drop-b.md", "centre-drop-c.md"];
const RUN = Date.now().toString(36);

function layoutHash(rightHoldsATab) {
  const tab = (p, extra = {}) => ({ p, m: "wysiwyg", ...extra });
  return "s=" + encodeURIComponent(JSON.stringify({
    k: "s", d: "r",
    a: { k: "l", f: 1, t: [tab(FILES[0], { a: 1 }), tab(FILES[1])] },
    b: { k: "l", t: rightHoldsATab ? [tab(FILES[2], { a: 1 })] : [] },
  }));
}

/// Installed before the page's scripts: every drag event's type, whether the
/// browser made it, and the pane and part of the pane it reached first.
function installDragRecord() {
  window.__dragRecord = [];
  for (const type of ["dragstart", "dragover", "drop", "dragend"]) {
    window.addEventListener(type, (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const pane = target?.closest(".pane") ?? null;
      window.__dragRecord.push({
        type,
        trusted: event.isTrusted,
        pane: pane ? [...document.querySelectorAll(".pane")].indexOf(pane) : -1,
        body: Boolean(target?.closest(".editor-wrap")),
        strip: Boolean(target?.closest(".tabs")),
      });
    }, true);
  }
}

/// Each pane in document order: the labels its strip lists, whether the
/// strip is painted, and the zone classes its body carries.
function readPanes(page) {
  return page.evaluate(() => [...document.querySelectorAll(".pane")].map((pane) => {
    const strip = pane.querySelector(".tabs");
    const wrap = pane.querySelector(".editor-wrap");
    return {
      tabs: [...(strip?.querySelectorAll('[role="tab"] .path') ?? [])].map((n) => n.textContent?.trim() ?? ""),
      stripShown: Boolean(strip) && getComputedStyle(strip).display !== "none",
      zones: wrap ? [...wrap.classList].filter((c) => c.startsWith("body-drop-")) : [],
    };
  }));
}

async function waitPanes(page, label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPanes(page);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label}: not reached within ${timeoutMs}ms; the panes read ${JSON.stringify(last)}`);
}

const named = (tabs, file) => tabs.some((label) => label.includes(file.replace(/\.md$/, "")));

/// The centre of the left pane's second tab, and a point in the right pane's
/// body: its middle, or 20px inside its left side at mid height.
async function points(page, at) {
  return page.evaluate((at) => {
    const [left, right] = document.querySelectorAll(".pane");
    const tab = left.querySelectorAll(".tabs .tab")[1].getBoundingClientRect();
    const body = right.querySelector(".editor-wrap").getBoundingClientRect();
    return {
      start: { x: tab.left + tab.width / 2, y: tab.top + tab.height / 2 },
      target: at === "centre"
        ? { x: body.left + body.width / 2, y: body.top + body.height / 2 }
        : { x: body.left + 20, y: body.top + body.height / 2 },
      body: { width: Math.round(body.width), height: Math.round(body.height) },
    };
  }, at);
}

/// The right body's overlay once its fade ends: opacity, ring and left border.
function overlay(page) {
  return page.evaluate(async () => {
    const wrap = document.querySelectorAll(".pane")[1].querySelector(".editor-wrap");
    await Promise.all(wrap.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
    const after = getComputedStyle(wrap, "::after");
    return { opacity: after.opacity, boxShadow: after.boxShadow, borderLeftWidth: after.borderLeftWidth };
  });
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function arm(ctx, page, token, { name, autoHide, rightHoldsATab, at, zone }) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", `centre-drop-205-${name}-${RUN}`);
  url.hash = layoutHash(rightHoldsATab);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitPanes(page, `${name}: the two panes`, (p) => p.length === 2 && p[0].tabs.length === 2 &&
    p[1].tabs.length === (rightHoldsATab ? 1 : 0));
  const pref = await readPaneStripPreference(page, token);
  if (pref.on !== autoHide) await writePaneStripPreference(page, token, autoHide);
  const before = await waitPanes(page, `${name}: the right strip under auto-hide ${autoHide}`, (p) =>
    p.length === 2 && p[0].stripShown && p[1].stripShown === !autoHide);

  const { start, target, body } = await points(page, at);
  const data = await withTimeout(page.mouse.drag(start, target), 15_000, `${name}: the native drag from the left tab`);
  await page.mouse.dragEnter(target, data);
  await page.mouse.dragOver(target, data);
  const hovering = await waitPanes(page, `${name}: the right body paints the ${zone} zone`, (p) =>
    p[1].zones.length === 1 && p[1].zones[0] === `body-drop-${zone}`);
  const painted = await overlay(page);
  await ctx.shot(`205-${name}-hover`, page);
  await page.mouse.drop(target, data);
  await page.mouse.up();
  const types = (data.items ?? []).map((item) => item.mimeType);
  return { name, autoHide, at, body, before, hovering, painted, types };
}

/// Read once the drop's layout has settled, so a dragend has had its turn.
async function settled(page, result, after) {
  const record = await page.evaluate(() => window.__dragRecord);
  return { ...result, after, record };
}

function assertTrusted(result) {
  const { name, record } = result;
  const first = (type) => record.find((r) => r.type === type);
  assert.ok(first("dragstart")?.trusted && first("dragstart").pane === 0 && first("dragstart").strip,
    `${name}: the browser started the drag on the left strip: ${JSON.stringify(record)}`);
  assert.ok(record.some((r) => r.type === "dragover" && r.trusted && r.pane === 1 && r.body),
    `${name}: a trusted dragover reached the right body: ${JSON.stringify(record)}`);
  assert.ok(record.some((r) => r.type === "drop" && r.trusted && r.pane === 1 && r.body),
    `${name}: a trusted drop reached the right body: ${JSON.stringify(record)}`);
}

export default {
  name: "pane-centre-drop",
  async run(ctx) {
    for (const f of FILES) writeFileSync(join(ctx.workspaceDir, f), `# ${f}\n\n${"A line of text.\n\n".repeat(6)}`);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(installDragRecord);
    await page.setDragInterception(true);
    const details = { arms: [] };
    let original = null;
    try {
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", `centre-drop-205-probe-${RUN}`);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      original = await readPaneStripPreference(page, token);

      // The centre with the strip drawn, then hidden: the tab joins the right
      // pane and nothing splits.
      for (const autoHide of [false, true]) {
        const result = await arm(ctx, page, token, {
          name: `centre-${autoHide ? "on" : "off"}`, autoHide, rightHoldsATab: true, at: "centre", zone: "centre",
        });
        const after = await waitPanes(page, `${result.name}: the tab joined the right pane`, (p) =>
          p.length === 2 && named(p[1].tabs, FILES[1]) && named(p[1].tabs, FILES[2]) && !named(p[0].tabs, FILES[1]));
        const done = await settled(page, result, after);
        details.arms.push(done);
        assert.ok(after[1].stripShown, `${result.name}: the right pane holds two tabs and draws its strip: ${JSON.stringify(after)}`);
        assert.equal(result.painted.opacity, "1", `${result.name}: the centre overlay is painted: ${JSON.stringify(result.painted)}`);
        assert.match(result.painted.boxShadow, /inset/, `${result.name}: the centre overlay is a ring: ${JSON.stringify(result.painted)}`);
        assertTrusted(done);
      }

      // An empty pane's whole body is the centre: the drop near its side
      // fills it.
      {
        const result = await arm(ctx, page, token, {
          name: "empty", autoHide: true, rightHoldsATab: false, at: "edge", zone: "centre",
        });
        const after = await waitPanes(page, "empty: the tab filled the empty pane", (p) =>
          p.length === 2 && p[1].tabs.length === 1 && named(p[1].tabs, FILES[1]));
        const done = await settled(page, result, after);
        details.arms.push(done);
        assertTrusted(done);
      }

      // The same point on a pane holding a tab is in its left band, and
      // splits it.
      {
        const result = await arm(ctx, page, token, {
          name: "edge", autoHide: true, rightHoldsATab: true, at: "edge", zone: "left",
        });
        const after = await waitPanes(page, "edge: the drop split the right pane", (p) => p.length === 3);
        const done = await settled(page, result, after);
        details.arms.push(done);
        assert.deepEqual(after.map((p) => p.tabs.length), [1, 1, 1], `edge: one tab per pane: ${JSON.stringify(after)}`);
        assert.ok(named(after[1].tabs, FILES[1]) && named(after[2].tabs, FILES[2]),
          `edge: the dragged tab is the new pane before the right one: ${JSON.stringify(after)}`);
        assert.equal(result.painted.borderLeftWidth, "4px", `edge: the left edge overlay is painted: ${JSON.stringify(result.painted)}`);
        assertTrusted(done);
      }

      for (const a of details.arms) {
        console.log(`[smoke]   ${a.name}: body ${a.body.width}x${a.body.height}, hover ${JSON.stringify(a.hovering[1].zones)}, ` +
          `after ${JSON.stringify(a.after.map((p) => p.tabs))}, dragend ${a.record.some((r) => r.type === "dragend")}, types ${JSON.stringify(a.types)}`);
      }
      return details;
    } finally {
      try {
        if (original) await writePaneStripPreference(page, token, original.on);
      } finally {
        await page.close().catch(() => {});
      }
    }
  },
};
