#!/usr/bin/env node
// Check in Chrome, over the built marketing site, that a tour part the pointer woke goes back to
// rest at a press or tap away from it, and that pressing a part or its callout still follows.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const distOption = args.indexOf("--dist");
const dist = path.resolve(distOption < 0 ? path.join(root, "web/packages/marketing/dist") : args[distOption + 1] ?? "");
const viewports = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
};
let failed = 0;
let unmet = 0;

// A leg whose own setup did not hold (no point found, the page did not settle, the mouse did
// not wake the part it hovers) says so, and is counted apart from a failed product assertion.
class Precondition extends Error {}

function result(name, expected, actual, outcome) {
  console.log(JSON.stringify({ name, outcome, expected, actual, pass: outcome === "pass" }));
  if (outcome === "fail") failed++;
  if (outcome === "precondition") unmet++;
}

function unavailable(message) {
  return Object.assign(new Error(message), { unavailable: true });
}

async function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), ".cache/puppeteer/chrome");
  const builds = (await readdir(cache).catch(() => [])).filter((name) => name.startsWith("linux-")).sort();
  if (!builds.length) throw unavailable(`no Chrome under ${cache} and CHROME_BIN unset`);
  return path.join(cache, builds.at(-1), "chrome-linux64/chrome");
}

function serve() {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const relative = pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
      const file = path.resolve(dist, relative);
      if (!file.startsWith(`${dist}${path.sep}`)) return response.writeHead(404).end("not found");
      const body = await readFile(file);
      const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      response.writeHead(200, { "content-type": type }).end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end(String(error?.message ?? error));
    }
  });
}

// The pages whose tour has parts, read from the built site so a new one is covered.
async function tourRoutes() {
  const files = (await readdir(dist, { recursive: true })).filter((file) => file.endsWith(".html")).sort();
  const routes = [];
  for (const file of files) {
    const html = await readFile(path.join(dist, file), "utf8");
    if (!/\sdata-tour[\s>=]/.test(html) || !/<a\s[^>]*data-part=/.test(html)) continue;
    const route = `/${file.split(path.sep).join("/")}`;
    routes.push(route.endsWith("/index.html") ? route.slice(0, -"index.html".length) : route);
  }
  return routes;
}

// Runs in the page. Everything it needs is inside it, since puppeteer sends its source.
function inPage(op, arg) {
  const tour = [...document.querySelectorAll("[data-tour]")].find((each) => each.querySelector(".tour-stage a[data-part]"));
  if (!tour) throw new Error("no tour with parts on the page");
  const stage = tour.querySelector(".tour-stage");
  const parts = [...stage.querySelectorAll("a[data-part]")];
  const callout = stage.querySelector(".tour-callout");
  const interactive = "a[href], button, input, textarea, select, summary, label, video, [role=button], [tabindex]:not([tabindex='-1'])";
  const describe = (el) => el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].join(".")}` : ""}` : null;
  const hitPart = (x, y) => document.elementFromPoint(x, y)?.closest("a[data-part]");
  // Points over a box, inside the viewport, from its centre outward.
  const pointsIn = (rect, step) => {
    const left = Math.max(rect.left, 2), right = Math.min(rect.right, innerWidth - 2);
    const top = Math.max(rect.top, 2), bottom = Math.min(rect.bottom, innerHeight - 2);
    const points = [];
    for (let y = top + step / 2; y < bottom; y += step) for (let x = left + step / 2; x < right; x += step) points.push({ x: Math.round(x), y: Math.round(y) });
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    return points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  };
  const pointOn = (part) => {
    const rect = part.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return null;
    return pointsIn(rect, Math.max(4, Math.min(rect.width, rect.height) / 8)).find(({ x, y }) => hitPart(x, y) === part) ?? null;
  };
  switch (op) {
    case "state":
      return {
        awake: parts.flatMap((part, index) => (part.classList.contains("is-awake") ? [index] : [])),
        anyAwake: document.querySelectorAll(".is-awake").length,
        calloutHidden: callout?.hidden ?? null,
        calloutTitle: callout?.querySelector("b")?.textContent ?? null,
        calloutHref: callout?.querySelector("a")?.href ?? null,
        beat: tour.dataset.current ?? null,
        live: tour.classList.contains("tour-live"),
        motion: `${tour.dataset.current}|${tour.getAttribute("style")}`,
        url: location.href,
      };
    case "part": {
      // The first part the pointer can reach in the viewport, or the given one.
      const order = arg == null ? parts.map((_, index) => index) : [arg];
      for (const index of order) {
        const point = pointOn(parts[index]);
        if (point) return { index, title: parts[index].dataset.part, href: parts[index].href, ...point };
      }
      return null;
    }
    case "empty": {
      // A point that is no part, not the callout and no other control: on the stage, outside
      // the tour, or anywhere.
      const area = arg === "stage" ? stage.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (const point of pointsIn(area, 12).reverse()) {
        const hit = document.elementFromPoint(point.x, point.y);
        if (!hit || hit.closest("a[data-part]") || callout?.contains(hit) || hit.closest(interactive)) continue;
        if (arg === "stage" && !stage.contains(hit)) continue;
        if (arg === "outside" && tour.contains(hit)) continue;
        return { ...point, hit: describe(hit) };
      }
      return null;
    }
    case "callout": {
      if (!callout || callout.hidden) return null;
      const at = (el) => {
        const rect = el?.getBoundingClientRect();
        if (!rect) return null;
        return pointsIn(rect, 3).find(({ x, y }) => el.contains(document.elementFromPoint(x, y))) ?? null;
      };
      return { title: at(callout.querySelector("b")), link: at(callout.querySelector("a")) };
    }
    case "stageTop":
      window.scrollTo({ top: Math.max(0, stage.getBoundingClientRect().top + scrollY), behavior: "instant" });
      return scrollY;
    case "stageFoot": {
      // The callout sits at the stage's foot, which can start below the viewport while the stage
      // waits under the page header to pin.
      const over = Math.ceil(stage.getBoundingClientRect().bottom - innerHeight);
      if (over > 0) window.scrollBy({ top: over, behavior: "instant" });
      return { over, scrollY, stageBottom: stage.getBoundingClientRect().bottom, innerHeight };
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The tour glides toward the scrolled position; wait until its beat and pose hold still.
async function settle(page) {
  let last = "";
  let same = 0;
  for (let tries = 0; tries < 40 && same < 3; tries += 1) {
    await pause(150);
    const { motion } = await page.evaluate(inPage, "state");
    same = motion === last ? same + 1 : 0;
    last = motion;
  }
  if (same < 3) throw new Precondition(`tour did not settle: ${last}`);
}

// Opens a page with a reachable part; when none is in view at the top, scrolls the stage up.
async function open(browser, origin, route, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  try {
    const response = await page.goto(`${origin}${route}`, { waitUntil: "load", timeout: 25000 });
    if (response?.status() !== 200) throw new Error(`${route}: HTTP ${response?.status()}`);
    await page.waitForFunction(() => !!document.querySelector("[data-tour].tour-live"), { timeout: 12000 });
    await settle(page);
    let part = await page.evaluate(inPage, "part", null);
    if (!part) {
      await page.evaluate(inPage, "stageTop");
      await settle(page);
      part = await page.evaluate(inPage, "part", null);
    }
    if (!part) throw new Precondition(`${route}: no part the pointer can reach`);
    return { page, part };
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function check(name, body) {
  try {
    const { expected, actual, pass } = await body();
    result(name, expected, actual, pass ? "pass" : "fail");
  } catch (error) {
    if (error instanceof Precondition) result(name, "the leg's setup holds", error.message, "precondition");
    else result(name, "check completes", String(error?.stack ?? error), "fail");
  }
}

const state = (page) => page.evaluate(inPage, "state");
const lit = (now, part) => now.awake.length === 1 && now.awake[0] === part.index && now.calloutHidden === false && now.calloutTitle === part.title;
const rested = (now) => now.anyAwake === 0 && now.calloutHidden === true;

// Wakes the part by the mouse: away to a point that is no part, then onto it, so it enters.
async function hover(page, part, away) {
  await page.mouse.move(away.x, away.y);
  await page.mouse.move(part.x, part.y);
  await frames(page);
  const now = await state(page);
  if (!lit(now, part)) throw new Precondition(`the mouse did not wake ${part.title}: ${JSON.stringify(now)}`);
  return now;
}

async function press(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
  await frames(page);
}

async function desktopLegs(browser, origin, route) {
  const label = `desktop ${route}`;
  let page = null;
  let part = null;
  try {
    let stageSpot = null;
    let outside = null;
    let target = null;
    const opened = () => {
      if (!page) throw new Precondition("the page did not open with a part the pointer can reach");
    };
    await check(`${label} a: the mouse over a part lights it and the callout names it`, async () => {
      ({ page, part } = await open(browser, origin, route, viewports.desktop));
      await page.mouse.move(part.x, part.y);
      await frames(page);
      const now = await state(page);
      // Taken while the callout shows, so none lies under it.
      target = (await page.evaluate(inPage, "part", part.index)) ?? part;
      stageSpot = await page.evaluate(inPage, "empty", "stage");
      outside = await page.evaluate(inPage, "empty", "outside");
      return { expected: `only part ${part.index} (${part.title}) is-awake; callout shown titled ${part.title}`, actual: { part, now }, pass: lit(now, part) };
    });
    await check(`${label} b: a press on empty stage rests the part and hides the callout`, async () => {
      opened();
      if (!stageSpot) throw new Precondition("no empty point on the stage");
      const before = await hover(page, target, stageSpot);
      await press(page, stageSpot);
      const now = await state(page);
      return { expected: "no is-awake, callout hidden, same beat", actual: { stageSpot, before: before.beat, now }, pass: rested(now) && now.beat === before.beat };
    });
    await check(`${label} c: a press outside the tour rests the part and hides the callout`, async () => {
      opened();
      if (!outside) throw new Precondition("no point outside the tour in view");
      const before = await hover(page, target, outside);
      await press(page, outside);
      const now = await state(page);
      return { expected: "no is-awake, callout hidden, same beat", actual: { outside, before: before.beat, now }, pass: rested(now) && now.beat === before.beat };
    });
  } finally { await page?.close(); }

  await check(`${label} e: a click on the part already awake follows its link`, async () => {
    const { page, part } = await open(browser, origin, route, viewports.desktop);
    try {
      await page.mouse.move(part.x, part.y);
      await frames(page);
      const awake = await state(page);
      if (!lit(awake, part)) throw new Precondition(`the mouse did not wake ${part.title}: ${JSON.stringify(awake)}`);
      // The callout now shows and may lie over the hovered point; press where the part is still hit.
      const spot = await page.evaluate(inPage, "part", part.index);
      if (!spot) throw new Precondition("the awake part is no longer reachable");
      await page.mouse.move(spot.x, spot.y);
      const [response] = await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }), page.mouse.down().then(() => page.mouse.up())]);
      const actual = { part, spot, url: page.url(), status: response?.status() ?? null };
      return { expected: `navigates to ${part.href} with 200`, actual, pass: actual.url === part.href && actual.status === 200 };
    } finally { await page.close(); }
  });

  await check(`${label} f: a press inside the callout keeps the part awake and its link follows to the part's page`, async () => {
    const { page, part } = await open(browser, origin, route, viewports.desktop);
    try {
      // Bring the stage's foot, where the callout shows, into view before anything wakes, and
      // hold the tour to the beat it opened on.
      const opening = await state(page);
      const foot = await page.evaluate(inPage, "stageFoot");
      await settle(page);
      const beat = (await state(page)).beat;
      if (beat !== opening.beat) throw new Precondition(`scrolling the stage's foot into view moved the tour from ${opening.beat} to ${beat}: ${JSON.stringify(foot)}`);
      const spot = await page.evaluate(inPage, "part", part.index);
      if (!spot) throw new Precondition(`${part.title} is not reachable once the stage's foot is in view: ${JSON.stringify(foot)}`);
      await page.mouse.move(spot.x, spot.y);
      await frames(page);
      const woke = await state(page);
      if (!lit(woke, part)) throw new Precondition(`the mouse did not wake ${part.title}: ${JSON.stringify(woke)}`);
      const spots = await page.evaluate(inPage, "callout");
      if (!spots?.title || !spots?.link) throw new Precondition(`callout text or link not reachable: ${JSON.stringify({ spots, foot })}`);
      await press(page, spots.title);
      const afterText = await state(page);
      await page.mouse.move(spots.link.x, spots.link.y);
      await page.mouse.down();
      const linkDown = await state(page);
      const [response] = await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }), page.mouse.up()]);
      const reached = { url: page.url(), status: response?.status() ?? null };
      const actual = { foot, spot, spots, afterText, linkDown, reached };
      const pass = lit(afterText, part) && lit(linkDown, part) && afterText.beat === beat && linkDown.beat === beat && linkDown.calloutHref === part.href && reached.url === part.href && reached.status === 200;
      return { expected: `${part.title} stays awake on ${beat} through a press on the callout text and on its link; the link reaches ${part.href} with 200`, actual, pass };
    } finally { await page.close(); }
  });
}

async function touchLegs(browser, origin, route) {
  const label = `phone ${route}`;
  let page = null;
  let part = null;
  try {
    let navigations = 0;
    let elsewhere = null;
    await check(`${label} d: a tap on a part wakes it without following its link`, async () => {
      ({ page, part } = await open(browser, origin, route, viewports.phone));
      page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
      const before = await state(page);
      await page.touchscreen.tap(part.x, part.y);
      await pause(600);
      await frames(page);
      const now = await state(page);
      elsewhere = await page.evaluate(inPage, "empty", "any");
      const actual = { part, now, navigations, before: before.url };
      return { expected: `only part ${part.index} (${part.title}) is-awake, callout titled ${part.title}, no navigation`, actual, pass: lit(now, part) && navigations === 0 && now.url === before.url };
    });
    await check(`${label} d: a tap elsewhere rests the part and hides the callout`, async () => {
      if (!page) throw new Precondition("the page did not open with a part the pointer can reach");
      if (!elsewhere) throw new Precondition("no point that is no part or control in view");
      const before = await state(page);
      if (!lit(before, part)) throw new Precondition(`${part.title} is not awake: ${JSON.stringify(before)}`);
      await page.touchscreen.tap(elsewhere.x, elsewhere.y);
      await pause(300);
      await frames(page);
      const now = await state(page);
      return { expected: "no is-awake, callout hidden, same beat, no navigation", actual: { elsewhere, now, navigations }, pass: rested(now) && now.beat === before.beat && navigations === 0 };
    });
  } finally { await page?.close(); }
}

async function main() {
  if (distOption >= 0 && !args[distOption + 1]) throw new Error("--dist needs a path");
  await access(path.join(dist, "index.html")).catch(() => { throw unavailable(`no built marketing site at ${dist}`); });
  const routes = await tourRoutes();
  if (!routes.length) throw new Error(`no page in ${dist} has a tour with parts`);
  const chrome = await chromePath();
  await access(chrome).catch(() => { throw unavailable(`Chrome not found at ${chrome}`); });
  const require = createRequire(path.join(root, "scripts/e2e/browser-smoke/package.json"));
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch (error) {
    throw unavailable(`puppeteer-core is not installed under scripts/e2e/browser-smoke: ${error?.message ?? error}`);
  }
  const server = serve();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    try {
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    } catch (error) {
      throw unavailable(`Chrome could not start: ${error}`);
    }
    console.log(JSON.stringify({ dist, chromeVersion: await browser.version(), origin, routes }));
    for (const route of routes) {
      await desktopLegs(browser, origin, route);
      await touchLegs(browser, origin, route);
    }
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  // An unmet precondition is not a pass: the leg did not run.
  console.log(JSON.stringify({ verdict: failed ? "failed" : unmet ? "incomplete" : "passed", failures: failed, preconditions: unmet }));
  process.exitCode = failed || unmet ? 1 : 0;
}

main().catch((error) => {
  if (error?.unavailable) {
    console.log(JSON.stringify({ verdict: "unavailable", reason: error.message }));
    process.exitCode = 2;
    return;
  }
  console.error(error?.stack ?? error);
  console.log(JSON.stringify({ verdict: "error", reason: String(error?.message ?? error) }));
  process.exitCode = 1;
});
