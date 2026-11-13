// A pane draws flush on the sides it has on the window's edge and keeps its
// gap on the sides it shares with another pane. No mounted test applies the
// stylesheet, so the check reads the boxes the browser lays out: a window's
// only pane fills the pane area with no margin, border or rounded corner; two
// panes side by side reach the area's sides and sit 12px apart; a third pane
// under the right one rounds only the corners that meet the gap; and a
// terminal keeps a 2px inset on a window side against 8px on a shared one,
// and 8px under a strip drawn in place.
//
// The docked file browser, which takes its side from the panes' edges, is a
// server preference and is left alone here; `state/paneEdges.test.ts` holds
// that rule.

import assert from "node:assert/strict";
import { dispatchCommand } from "../lib/pane-strip.mjs";

const EDGE_INSET = 2;
const SHARED_INSET = 8;
const MARGIN = 4;
const RADIUS = 6;
const CHANNEL = 12;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 0.5, `${label}: ${actual}, expected ${expected}`);
}

/// The pane area's box and every pane in it, ordered left to right and then
/// top to bottom. Sides run top, right, bottom, left; corners run clockwise
/// from the top-left one.
function read(page) {
  return page.evaluate(() => {
    const px = (value) => Number.parseFloat(value) || 0;
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const sides = (style, prefix, suffix = "") =>
      ["Top", "Right", "Bottom", "Left"].map((side) => px(style[`${prefix}${side}${suffix}`]));
    const area = document.querySelector(".app > main");
    const panes = [...document.querySelectorAll(".pane")].map((pane) => {
      const style = getComputedStyle(pane);
      const strip = pane.querySelector(".pane-card-face > .tabs");
      const host = pane.querySelector(".terminal-tab.active .terminal-host");
      return {
        box: box(pane),
        margin: sides(style, "margin"),
        border: sides(style, "border", "Width"),
        radius: ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map((corner) =>
          px(style[`border${corner}Radius`])),
        strip: !!strip && getComputedStyle(strip).display !== "none",
        inset: host ? sides(getComputedStyle(host), "padding") : null,
      };
    });
    panes.sort((a, b) => a.box.left - b.box.left || a.box.top - b.box.top);
    return { area: area ? box(area) : null, panes };
  });
}

/// A terminal in the active pane, waited for until the window shows `count`.
async function openTerminal(page, count) {
  await dispatchCommand(page, "app.terminal.toggle");
  await page.waitForFunction(
    (wanted) => document.querySelectorAll(".pane .terminal-tab.active .terminal-host").length === wanted,
    { timeout: 30_000 },
    count,
  );
}

async function split(page, command, count) {
  await dispatchCommand(page, command);
  await page.waitForFunction(
    (wanted) => document.querySelectorAll(".pane").length === wanted,
    { timeout: 30_000 },
    count,
  );
}

/// The inset a terminal keeps at its top: the full one under a strip, since
/// the strip is what meets the pane's top there.
function topInset(pane) {
  return pane.strip ? SHARED_INSET : EDGE_INSET;
}

export default {
  name: "pane-window-edges",
  async run(ctx) {
    const { page } = ctx;
    await page.waitForSelector(".pane", { timeout: 30_000 });

    await openTerminal(page, 1);
    await sleep(300);
    const lone = await read(page);
    assert.ok(lone.area, "the window has a pane area");
    assert.equal(lone.panes.length, 1, "a fresh window holds one pane");
    const [only] = lone.panes;
    for (const side of ["left", "top", "right", "bottom"]) {
      near(only.box[side], lone.area[side], `the only pane's ${side} side against the pane area's`);
    }
    assert.deepEqual(only.margin, [0, 0, 0, 0], "the only pane keeps no margin");
    assert.deepEqual(only.border, [0, 0, 0, 0], "the only pane keeps no border");
    assert.deepEqual(only.radius, [0, 0, 0, 0], "the only pane rounds no corner");
    assert.deepEqual(only.inset, [topInset(only), EDGE_INSET, EDGE_INSET, EDGE_INSET],
      "the only pane's terminal keeps the edge inset on every window side");

    await split(page, "app.pane.splitRight", 2);
    await openTerminal(page, 2);
    await sleep(300);
    const row = await read(page);
    const [left, right] = row.panes;
    near(left.box.left, row.area.left, "the left pane's left side against the pane area's");
    near(right.box.right, row.area.right, "the right pane's right side against the pane area's");
    for (const [name, pane] of [["left", left], ["right", right]]) {
      near(pane.box.top, row.area.top, `the ${name} pane's top against the pane area's`);
      near(pane.box.bottom, row.area.bottom, `the ${name} pane's bottom against the pane area's`);
      assert.deepEqual(pane.border, [1, 1, 1, 1], `the ${name} pane keeps the focus ring's line`);
      assert.deepEqual(pane.radius, [0, 0, 0, 0], `the ${name} pane has every corner on a window side`);
    }
    near(right.box.left - left.box.right, CHANNEL, "the gap between two panes side by side");
    assert.deepEqual(left.margin, [0, MARGIN, 0, 0], "the left pane keeps its margin toward the right pane only");
    assert.deepEqual(right.margin, [0, 0, 0, MARGIN], "the right pane keeps its margin toward the left pane only");
    assert.deepEqual(left.inset, [topInset(left), SHARED_INSET, EDGE_INSET, EDGE_INSET],
      "the left pane's terminal keeps the full inset toward the right pane only");
    assert.deepEqual(right.inset, [topInset(right), EDGE_INSET, EDGE_INSET, SHARED_INSET],
      "the right pane's terminal keeps the full inset toward the left pane only");

    await split(page, "app.pane.splitDown", 3);
    await openTerminal(page, 3);
    await sleep(300);
    const stacked = await read(page);
    const [, upper, lower] = stacked.panes;
    near(upper.box.top, stacked.area.top, "the upper right pane's top against the pane area's");
    near(lower.box.bottom, stacked.area.bottom, "the lower right pane's bottom against the pane area's");
    near(upper.box.right, stacked.area.right, "the upper right pane's right side against the pane area's");
    near(lower.box.right, stacked.area.right, "the lower right pane's right side against the pane area's");
    near(lower.box.top - upper.box.bottom, CHANNEL, "the gap between two stacked panes");
    assert.deepEqual(upper.margin, [0, 0, MARGIN, MARGIN], "the upper right pane's margins");
    assert.deepEqual(lower.margin, [MARGIN, 0, 0, MARGIN], "the lower right pane's margins");
    assert.deepEqual(upper.radius, [0, 0, 0, RADIUS], "the upper right pane rounds its bottom-left corner alone");
    assert.deepEqual(lower.radius, [RADIUS, 0, 0, 0], "the lower right pane rounds its top-left corner alone");
    assert.deepEqual(upper.inset, [topInset(upper), EDGE_INSET, SHARED_INSET, SHARED_INSET],
      "the upper right pane's terminal insets");
    assert.deepEqual(lower.inset, [SHARED_INSET, EDGE_INSET, EDGE_INSET, SHARED_INSET],
      "the lower right pane's terminal insets");

    await ctx.shot("pane-window-edges", page);
    return { lone, row, stacked };
  },
};
