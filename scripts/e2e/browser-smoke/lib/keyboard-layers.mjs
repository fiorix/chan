// Shared pieces of the paint-order checks: which surface paints at a point,
// a surface's layer as the page ranks it (the highest z-index on it or an
// ancestor, the way state/paintLevel.ts reads it), the command deck opened
// and closed by its command, and the waits every leg uses.

import { dispatchCommand } from "./pane-strip.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DECK = '[role="dialog"][aria-label="Command launcher"]';
export const DECK_INPUT = `${DECK} input[role="combobox"]`;
export const SEARCH = '[role="dialog"][aria-label="Search"]';
export const SETTINGS = '[role="dialog"][aria-label="Settings"]';
export const PATH_PROMPT = '[role="dialog"][aria-labelledby="path-prompt-title"]';
export const PROMPT = '[role="dialog"][aria-labelledby="prompt-title"]';
export const TEAM = '.team-dialog[role="dialog"]';
export const CLOSE_PROMPT = '[role="alertdialog"][aria-label="Close this window?"]';
export const LOCK = '[data-cover="screensaver"]';

// The surfaces a point or the keyboard can be on, topmost kinds first, each
// matched by `closest` from the element.
const SURFACES = [
  ["screen-lock", '[data-cover="screensaver"]'],
  ["close-prompt", CLOSE_PROMPT],
  ["session-ended", '[data-cover="session-ended"]'],
  ["reconnect", '[data-cover="reconnect"]'],
  ["window-survey", ".survey-overlay:not(.per-terminal)"],
  ["path-prompt", PATH_PROMPT],
  ["prompt", PROMPT],
  ["team", ".team-dialog-backdrop"],
  ["settings", SETTINGS],
  ["search", SEARCH],
  ["deck", ".deck-overlay"],
  ["statusbar", ".app-statusbar"],
];

/// Let the page paint twice, then wait a fixed 300 ms for effects queued
/// after the paint.
export async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await sleep(300);
}

/// Read until `accept` holds or the bound passes; the error names the last
/// read. The bound is a hang guard, not an expected time: 15 s by default,
/// shorter where a leg names its own.
export async function until(label, read, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: last read ${JSON.stringify(value)}`);
}

/// The window id the check page runs in.
export function checkWindowId(page) {
  return page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
    || sessionStorage.getItem("chan.session.window")?.trim() || "");
}

/// The surface that paints at the centre of `selector`'s box, or `at` (x, y):
/// its kind, or the tag and class of whatever else is there.
export function surfaceAt(page, selector, at = null) {
  return page.evaluate((selector, at, surfaces) => {
    let x = at?.x;
    let y = at?.y;
    if (selector) {
      const target = document.querySelector(selector);
      if (!target) return { missing: selector };
      const box = target.getBoundingClientRect();
      x = box.left + box.width / 2;
      y = box.top + box.height / 2;
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { x, y, surface: null };
    const found = surfaces.find(([, sel]) => hit.closest(sel));
    return {
      x: Math.round(x), y: Math.round(y),
      surface: found ? found[0] : `${hit.tagName}.${hit.className?.toString?.() ?? ""}`.slice(0, 80),
    };
  }, selector, at, SURFACES);
}

/// The surface the keyboard is on, by the same names as `surfaceAt`.
export function keyboardSurface(page) {
  return page.evaluate((surfaces) => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    const found = surfaces.find(([, sel]) => active.closest(sel));
    return found ? found[0] : `${active.tagName}.${active.className?.toString?.() ?? ""}`.slice(0, 80);
  }, SURFACES);
}

/// The layer `selector` paints at: the highest numeric z-index on it or an
/// ancestor, or null when it is not in the page.
export function layerOf(page, selector) {
  return page.evaluate((selector) => {
    let node = document.querySelector(selector);
    if (!node) return null;
    let top = null;
    for (; node instanceof Element; node = node.parentElement) {
      const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(z) && (top === null || z > top)) top = z;
    }
    return top;
  }, selector);
}

/// The value of the input `selector` names, or null.
export function inputValue(page, selector) {
  return page.evaluate((selector) => document.querySelector(selector)?.value ?? null, selector);
}

/// Open the command deck by its command and wait for its input to hold the keyboard.
export async function openDeck(page) {
  if (!(await page.$(DECK))) await dispatchCommand(page, "app.launcher.toggle");
  await until("the deck opens with its input focused",
    () => page.evaluate((sel) => document.activeElement === document.querySelector(sel), DECK_INPUT), Boolean);
}

/// Close the command deck by its command when it is open.
export async function closeDeck(page) {
  if (!(await page.$(DECK))) return;
  await dispatchCommand(page, "app.launcher.toggle");
  await until("the deck closes", async () => Boolean(await page.$(DECK)), (open) => !open, 5000);
}

/// Whether Settings answers keys: Tab until one of its section tabs holds the
/// keyboard, then ArrowDown, which moves the current section. The current
/// section before and after, and where each Tab left the keyboard.
export async function settingsArrowDown(page) {
  const current = () => page.evaluate((settings) =>
    document.querySelector(`${settings} .section-tab[aria-current="page"]`)?.textContent?.trim() ?? null, SETTINGS);
  const onSectionTab = () => page.evaluate((settings) =>
    Boolean(document.activeElement?.closest(`${settings} .section-tab`)), SETTINGS);
  const steps = [];
  for (let press = 0; press < 8 && !(await onSectionTab()); press += 1) {
    await page.keyboard.press("Tab");
    steps.push(await keyboardSurface(page));
  }
  if (!(await onSectionTab())) return { reached: false, steps };
  const before = await current();
  await page.keyboard.press("ArrowDown");
  await settle(page);
  const after = await current();
  return { reached: true, steps, before, after, moved: before !== null && after !== null && before !== after };
}
