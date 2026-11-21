// The Computers window lists its keys in one bar along its bottom edge, set as
// the command deck's footer sets its keys, and no card or gap between the deck
// and its dots carries a key legend. On the Computers screen the bar holds the
// arrows, Enter, g and the row letters o, t, w and h, each once as kbd keycaps
// with its word; on the Gateways screen, the arrows, Enter as activates, g and
// o. On both screens the bar sits below the front card and the dots, at the
// window's bottom edge, at three window heights with no page scroll and at a
// phone width with no sideways scroll, and it is painted and on top: the
// element at its centre is inside it, it is visible, and neither it nor an
// ancestor is transparent. Nothing in it takes focus, and it carries no role,
// label or aria-hidden, as the deck's footer carries none; its type, colour and
// spacing are read against that footer's in the open deck. The devserver and
// read-only surfaces, which deal no deck, show no bar and no legend.
//
// The harness's `chan serve` has no launcher at `/`, so this spawns its own
// isolated `chan devserver run` over a fresh CHAN_HOME. Only the desktop
// surface deals the deck, so one page keeps the devserver's own document and
// rewrites its surface meta to the desktop's when parsing ends, as check 219
// does; a second page keeps the devserver surface, and a third is rewritten to
// the read-only surface the same way.
//
// A page that never loads its deck fails as a precondition, named so, apart
// from the contract's findings, which are reported together. Skips when the
// launcher bundle is missing.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armFlip, screenFlip } from "../lib/flip.mjs";
import { goto, killChild, mask, spawnDevserver, wait } from "../lib/launcher-devserver.mjs";

const DECK = '[role="region"][aria-roledescription="carousel"]';
const THIS_MACHINE = 'button[aria-label="New local terminal"]';
// The local card's name, which every surface renders; the read-only surface
// has no New terminal button to wait for.
const MACHINE_NAME = "section.card.machine .machine-name";
const COMMAND_DECK = '[role="dialog"][aria-label="Command launcher"]';

const COMPUTERS_KEYS = [
  { keys: ["↑", "↓"], does: "rows" },
  { keys: ["←", "→"], does: "controls" },
  { keys: ["Enter"], does: "focuses" },
  { keys: ["g"], does: "screens" },
  { keys: ["o"], does: "on/off" },
  { keys: ["t"], does: "terminal" },
  { keys: ["w"], does: "workspace window" },
  { keys: ["h"], does: "show/hide" },
];
const GATEWAYS_KEYS = [
  { keys: ["↑", "↓"], does: "rows" },
  { keys: ["←", "→"], does: "controls" },
  { keys: ["Enter"], does: "activates" },
  { keys: ["g"], does: "screens" },
  { keys: ["o"], does: "on/off" },
];
// Words only a key legend holds; none of them is a card's own text.
const LEGEND_WORDS = ["show/hide", "Enter focuses", "g screens", "on/off", "workspace window", "controls"];

const HEIGHTS = [800, 560, 380];
const PHONE = { width: 390, height: 844 };

class Precondition extends Error {}

/// Wait for what the legs read; a timeout is the page not loading, which is
/// not the contract's red.
async function need(page, what, selector, timeoutMs = 30_000) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  } catch (cause) {
    throw new Precondition(`precondition: ${what} did not load within ${timeoutMs}ms (${selector}); the page never reached the state this check reads: ${cause.message}`);
  }
}

/// The screen as the user sees it: the deck in front, what the carousel shows
/// outside its stage, the All windows card's text, every key bar with its
/// hints as keycaps and words, and the boxes the layout legs compare.
function readScreen(deckSelector, legendWords) {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const deck = document.querySelector(deckSelector);
  const stage = deck?.querySelector(".stage") ?? null;
  const front = deck?.querySelector('[aria-roledescription="card"][aria-current="true"]') ?? null;
  const allWindows = document.querySelector('section[aria-label="All windows"]');
  const bars = [...document.querySelectorAll(".key-bar")];
  const bar = bars[0] ?? null;
  const hints = bar
    ? [...bar.children].map((hint) => ({
      keys: [...hint.querySelectorAll("kbd")].map((kbd) => kbd.textContent.trim()),
      does: [...hint.childNodes]
        .filter((node) => !(node instanceof Element && node.tagName === "KBD"))
        .map((node) => node.textContent)
        .join("")
        .trim(),
    }))
    : null;
  // Every text node a legend word sits in, outside the bar.
  const strays = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text || bars.some((b) => b.contains(node)) || node.parentElement?.closest("script, style, noscript")) continue;
    if (legendWords.some((word) => text.includes(word))) strays.push(text.slice(0, 120));
  }
  // Whether the bar is what the window shows at its centre. An element at
  // opacity 0 still answers elementFromPoint, so opacity is read on its own,
  // through the ancestors, whose opacity the bar's computed value leaves out.
  let painted = null;
  if (bar) {
    const r = bar.getBoundingClientRect();
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let opacity = 1;
    for (let el = bar; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    painted = {
      inside: !!hit && bar.contains(hit),
      hit: hit ? `${hit.tagName.toLowerCase()}${hit.className ? `.${hit.className}` : ""}` : null,
      visibility: getComputedStyle(bar).visibility,
      opacity,
    };
  }
  const root = document.documentElement;
  return {
    surface: document.querySelector('meta[name="chan-launcher-surface"]')?.getAttribute("content") ?? null,
    newTerminal: !!document.querySelector('button[aria-label="New local terminal"]'),
    deck: deck?.getAttribute("aria-label") ?? null,
    front: front?.getAttribute("aria-label") ?? null,
    outsideStage: deck ? [...deck.children].filter((el) => el !== stage).map((el) => el.textContent.trim()).filter(Boolean) : null,
    allWindows: allWindows ? allWindows.textContent.replace(/\s+/g, " ").trim().slice(0, 300) : null,
    strays,
    bars: bars.length,
    hints,
    role: bar?.getAttribute("role") ?? null,
    label: bar?.getAttribute("aria-label") ?? bar?.getAttribute("aria-labelledby") ?? null,
    ariaHidden: bar?.getAttribute("aria-hidden") ?? null,
    painted,
    boxes: {
      bar: box(bar),
      card: box(front?.querySelector(".card") ?? front),
      dots: box(deck?.querySelector(".dots")),
    },
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { width: root.scrollWidth, clientWidth: root.clientWidth, height: root.scrollHeight, clientHeight: root.clientHeight },
  };
}

/// Every element of the bar, the bar included, that takes focus: by markup,
/// and by asking each one for focus. Focus goes back to the page after.
function focusableInBar() {
  const bar = document.querySelector(".key-bar");
  if (!bar) return null;
  const found = [];
  for (const el of [bar, ...bar.querySelectorAll("*")]) {
    const name = `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""}`;
    if (el.hasAttribute("tabindex") || el.matches("a[href], button, input, select, textarea, summary, [contenteditable]")) found.push(`${name} by markup`);
    el.focus?.({ preventScroll: true });
    if (document.activeElement === el) found.push(`${name} takes focus`);
  }
  document.activeElement?.blur?.();
  return found;
}

/// The computed type, colour and spacing of a key bar and of one keycap in it.
function barStyle(barSelector, hintSelector) {
  const bar = document.querySelector(barSelector);
  const hint = bar?.querySelector(hintSelector);
  const kbd = hint?.querySelector("kbd");
  if (!bar || !hint || !kbd) return null;
  const b = getComputedStyle(bar);
  const h = getComputedStyle(hint);
  const k = getComputedStyle(kbd);
  return {
    bar: { height: b.height, fontSize: b.fontSize, color: b.color, columnGap: b.columnGap, borderTopWidth: b.borderTopWidth, borderTopColor: b.borderTopColor, whiteSpace: b.whiteSpace },
    hint: { columnGap: h.columnGap },
    kbd: { fontSize: k.fontSize, fontFamily: k.fontFamily, padding: k.padding, borderRadius: k.borderRadius, color: k.color, backgroundColor: k.backgroundColor, borderColor: k.borderTopColor },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/// The contract on one screen of the desktop page, appended to `problems`.
function judgeScreen(reading, expected, label, problems) {
  if (reading.allWindows !== null && LEGEND_WORDS.some((word) => reading.allWindows.includes(word))) {
    problems.push(`${label}: the All windows card carries a key legend: ${JSON.stringify(reading.allWindows)}`);
  }
  if (reading.outsideStage === null) {
    problems.push(`${label}: no carousel on the page`);
  } else if (reading.outsideStage.length) {
    problems.push(`${label}: the carousel shows text between its cards and its dots: ${JSON.stringify(reading.outsideStage)}`);
  }
  if (reading.strays.length) problems.push(`${label}: legend text outside the key bar: ${JSON.stringify(reading.strays)}`);
  if (reading.bars !== 1) {
    problems.push(`${label}: ${reading.bars} key bars, not one`);
    return;
  }
  if (!same(reading.hints, expected)) {
    problems.push(`${label}: the key bar lists ${JSON.stringify(reading.hints)}, not ${JSON.stringify(expected)}`);
  }
  if (reading.role !== null || reading.label !== null) {
    problems.push(`${label}: the key bar carries role ${JSON.stringify(reading.role)} and label ${JSON.stringify(reading.label)}; the deck's footer carries neither`);
  }
  if (reading.ariaHidden !== null) {
    problems.push(`${label}: the key bar carries aria-hidden ${JSON.stringify(reading.ariaHidden)}, which takes its keys from assistive tech; the deck's footer carries none`);
  }
  judgeLayout(reading, label, problems);
}

/// The bar below the front card and the dots, at the window's bottom edge,
/// painted and on top, with no page scroll either way.
function judgeLayout(reading, label, problems) {
  const { bar, card, dots } = reading.boxes;
  const at = `${label} at ${reading.viewport.width}x${reading.viewport.height}`;
  if (!bar) {
    problems.push(`${at}: no key bar box`);
    return;
  }
  if (card && bar.top < card.bottom - 0.5) problems.push(`${at}: the key bar's top ${bar.top} is above the front card's bottom ${card.bottom}`);
  if (dots && bar.top < dots.bottom - 0.5) problems.push(`${at}: the key bar's top ${bar.top} is above the dots' bottom ${dots.bottom}`);
  if (Math.abs(bar.bottom - reading.viewport.height) > 1) problems.push(`${at}: the key bar's bottom ${bar.bottom} is not the window's bottom edge ${reading.viewport.height}`);
  if (bar.left < -0.5 || bar.right > reading.viewport.width + 0.5) problems.push(`${at}: the key bar spans ${bar.left}..${bar.right}, past the window's width ${reading.viewport.width}`);
  const { painted } = reading;
  if (!painted.inside) problems.push(`${at}: the key bar is not on top: the element at its centre is ${painted.hit}`);
  if (painted.visibility !== "visible") problems.push(`${at}: the key bar is not painted: its visibility is ${painted.visibility}`);
  if (painted.opacity !== 1) problems.push(`${at}: the key bar is not painted: its opacity is ${painted.opacity}`);
  const { scroll } = reading;
  if (scroll.width > scroll.clientWidth) problems.push(`${at}: the page scrolls sideways (${scroll.width} > ${scroll.clientWidth})`);
  if (scroll.height > scroll.clientHeight) problems.push(`${at}: the page scrolls (${scroll.height} > ${scroll.clientHeight})`);
}

/// Resize the window and let the deck measure its stage again.
async function resize(page, viewport) {
  await page.setViewport(viewport);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await wait(300);
}

/// The layout and paint of the screen in front at the other window sizes,
/// leaving the window at its first size.
async function judgeSizes(ctx, page, label, readings, problems) {
  const sizes = [...HEIGHTS.slice(1).map((height) => ({ width: 1280, height })), PHONE];
  for (const size of sizes) {
    await resize(page, size);
    const name = `${label}-${size.width}x${size.height}`;
    readings[name] = await page.evaluate(readScreen, DECK, LEGEND_WORDS);
    judgeLayout(readings[name], label, problems);
    await ctx.shot(name, page);
  }
  await resize(page, { width: 1280, height: HEIGHTS[0] });
}

/// A page of a surface that deals no deck: the rewrite, when it asks for one,
/// is shown to have taken, and the page holds no bar and no legend.
async function judgeFlatSurface(ctx, url, surface, problems, readings) {
  const page = await ctx.browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: HEIGHTS[0] });
    if (surface !== "devserver") await rewriteSurface(page, surface);
    await goto(page, url);
    await page.bringToFront();
    await need(page, `the ${surface} page's This machine card`, MACHINE_NAME);
    const reading = await page.evaluate(readScreen, DECK, LEGEND_WORDS);
    readings[surface] = reading;
    if (reading.surface !== surface || reading.newTerminal !== (surface !== "readonly")) {
      throw new Precondition(`precondition: the page is not the ${surface} surface (meta ${JSON.stringify(reading.surface)}, New terminal button ${reading.newTerminal})`);
    }
    if (reading.deck !== null) problems.push(`${surface}: the page deals a deck (${reading.deck}); this leg needs the flat surface`);
    if (reading.bars !== 0) problems.push(`${surface}: ${reading.bars} key bar(s) on a surface with no deck`);
    if (reading.strays.length) problems.push(`${surface}: legend text on the page: ${JSON.stringify(reading.strays)}`);
    await ctx.shot(`${surface}-1280x800`, page);
  } finally {
    await page.close().catch(() => {});
  }
}

/// The page keeps the devserver's own document and rewrites its surface meta
/// when parsing ends, before the launcher's module script reads it. A document
/// fulfilled by interception is not a loopback document to Chrome, which then
/// refuses its sockets to the devserver.
async function rewriteSurface(page, surface) {
  await page.evaluateOnNewDocument((from, to) => {
    document.addEventListener("readystatechange", () => {
      const meta = document.querySelector('meta[name="chan-launcher-surface"]');
      if (meta?.getAttribute("content") === from) meta.setAttribute("content", to);
    });
  }, "devserver", surface);
}

async function openCommandDeck(page) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await need(page, "the command deck", `${COMMAND_DECK} .deck-footer .deck-hint kbd`, 10_000);
}

export default {
  name: "computers-key-bar",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    const chanHome = mkdtempSync(join(tmpdir(), "chan-key-bar-317-"));
    const devserver = spawnDevserver(ctx.chanBin, chanHome, ["--no-tunnel"]);
    const pages = [];
    const readings = {};
    const problems = [];
    try {
      const launchUrl = await devserver.url;

      // The desktop surface: the Computers deck in front, on its first card.
      const desk = await ctx.browser.newPage();
      pages.push(desk);
      await desk.setViewport({ width: 1280, height: HEIGHTS[0] });
      await rewriteSurface(desk, "desktop");
      await goto(desk, launchUrl);
      await desk.bringToFront();
      await need(desk, "the Computers deck", `${DECK}[aria-label="Computers"]`);
      await need(desk, "the All windows card", 'section[aria-label="All windows"]');
      await need(desk, "This machine's card", THIS_MACHINE);
      await need(desk, "the deck's dots", `${DECK} .dots`);
      await desk.evaluate(() => document.activeElement?.blur?.());

      const computers = await desk.evaluate(readScreen, DECK, LEGEND_WORDS);
      readings.computers = computers;
      if (!computers.front?.startsWith("All windows,")) problems.push(`computers: the front card is ${JSON.stringify(computers.front)}, not All windows`);
      judgeScreen(computers, COMPUTERS_KEYS, "computers", problems);
      await ctx.shot("computers-1280x800", desk);

      const focusable = await desk.evaluate(focusableInBar);
      readings.focusable = focusable;
      if (focusable === null) problems.push("computers: no key bar to try focus on");
      else if (focusable.length) problems.push(`computers: the key bar takes focus: ${JSON.stringify(focusable)}`);

      // The bar against the command deck's footer, in the same page.
      await openCommandDeck(desk);
      const footer = await desk.evaluate(barStyle, `${COMMAND_DECK} .deck-footer`, ".deck-hint");
      const own = await desk.evaluate(barStyle, ".key-bar", ":scope > *");
      readings.styles = { footer, own };
      await desk.keyboard.press("Escape");
      await desk.waitForFunction((selector) => !document.querySelector(selector), { timeout: 10_000 }, COMMAND_DECK);
      if (!own) problems.push("computers: no key bar to read the type of");
      else if (!same(own, footer)) problems.push(`computers: the key bar's type, colour and spacing ${JSON.stringify(own)} differ from the command deck footer's ${JSON.stringify(footer)}`);

      await judgeSizes(ctx, desk, "computers", readings, problems);

      // g turns to the Gateways screen; its turn is observed before reading.
      await desk.evaluate(() => document.activeElement?.blur?.());
      const flip = await armFlip(desk, screenFlip());
      await desk.keyboard.press("g");
      await need(desk, "the Gateways deck", `${DECK}[aria-label="Gateways"]`, 10_000);
      await flip.settled("gateways screen");
      await flip.assertSettled("gateways screen");
      const gateways = await desk.evaluate(readScreen, DECK, LEGEND_WORDS);
      readings.gateways = gateways;
      judgeScreen(gateways, GATEWAYS_KEYS, "gateways", problems);
      await ctx.shot("gateways-1280x800", desk);
      await judgeSizes(ctx, desk, "gateways", readings, problems);

      // The other two surfaces list their cards with no deck and no bar.
      await judgeFlatSurface(ctx, launchUrl, "devserver", problems, readings);
      await judgeFlatSurface(ctx, launchUrl, "readonly", problems, readings);

      if (problems.length) {
        const error = new Error(`key bar contract: ${problems.length} finding(s):\n- ${problems.join("\n- ")}`);
        error.smokeDetails = readings;
        throw error;
      }
      return readings;
    } catch (error) {
      if (!error.smokeDetails) error.smokeDetails = readings;
      if (!(error instanceof Precondition) && !error.message.startsWith("key bar contract:") && problems.length) {
        error.message = `${error.message}\nfindings before it:\n- ${problems.join("\n- ")}`;
      }
      error.message = mask(error.message);
      throw error;
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      await killChild(devserver.child);
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
