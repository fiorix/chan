#!/usr/bin/env node
// Check the built marketing manual in Chrome; the package smoke has no layout or iframe focus.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const mode = args.includes("--baseline") ? "baseline" : "verify";
const distOption = args.indexOf("--dist");
const dist = path.resolve(distOption < 0 ? path.join(root, "web/packages/marketing/dist") : args[distOption + 1] ?? "");
const viewports = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 1 },
};
let failed = 0;

function result(name, expected, actual, pass) {
  console.log(JSON.stringify({ name, expected, actual, pass }));
  if (!pass) failed++;
}

async function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), ".cache/puppeteer/chrome");
  const builds = (await readdir(cache)).filter((name) => name.startsWith("linux-")).sort();
  if (!builds.length) throw Object.assign(new Error(`no Chrome under ${cache}`), { unavailable: true });
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

async function ready(page, route) {
  if (route.startsWith("/manual/devserver/")) {
    await page.waitForFunction(() => !!document.querySelector("iframe.launcher-demo-embed")?.contentDocument?.querySelector('.modal[role="dialog"]'), { timeout: 12000 });
  } else if (route.startsWith("/manual/install/")) {
    await page.waitForFunction(() => !!document.querySelector("#launcher-demo.mounted .launcher-demo-frame"), { timeout: 12000 });
  } else {
    await page.waitForFunction(() => document.readyState === "complete", { timeout: 12000 });
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function open(browser, origin, route, viewport, wait = true) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  try {
    const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 25000 });
    if (response?.status() !== 200) throw new Error(`${route}: HTTP ${response?.status()}`);
    if (wait) await ready(page, route);
    else await page.waitForFunction(() => document.readyState === "complete", { timeout: 12000 });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function check(name, body) {
  try {
    const { expected, actual, pass } = await body();
    result(name, expected, actual, pass);
  } catch (error) {
    result(name, "check completes", String(error?.stack ?? error), false);
  }
}

async function readerOpen(browser, origin, route, viewport) {
  const framed = route === "/manual/devserver/";
  const page = await open(browser, origin, route, viewport, !framed);
  try {
    if (framed) {
      await page.evaluate(() => document.querySelector("iframe.launcher-demo-embed").scrollIntoView({ block: "center", behavior: "instant" }));
      await ready(page, route);
    }
    const frame = framed ? await (await page.$("iframe.launcher-demo-embed")).contentFrame() : null;
    const context = frame ?? page;
    const button = framed ? ".add-devserver" : '#launcher-demo button[aria-label="New local workspace"]';
    const dialog = framed ? '.modal[role="dialog"]' : '#launcher-demo .modal[role="dialog"]';
    if (framed) {
      await frame.click(".modal-close");
      await frame.waitForFunction(() => !document.querySelector('.modal[role="dialog"]'), { timeout: 5000 });
    }
    const originOf = () => framed
      ? page.evaluate(() => {
        const rect = document.querySelector("iframe.launcher-demo-embed").getBoundingClientRect();
        const frame = document.querySelector("iframe.launcher-demo-embed");
        return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop };
      })
      : Promise.resolve({ x: 0, y: 0 });
    const rectOf = (selector) => context.evaluate((sel) => {
      const rect = document.querySelector(sel)?.getBoundingClientRect();
      if (!rect) throw new Error(`missing ${sel}`);
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    }, selector);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const start = await originOf();
    const opener = await rectOf(button);
    const height = await page.evaluate(() => innerHeight);
    const wanted = Math.max(0, start.y + opener.bottom - (height - 24));
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), wanted);
    const at = await originOf();
    const positioned = await rectOf(button);
    const openerBottom = at.y + positioned.bottom;
    if (Math.abs(openerBottom - (height - 24)) > 2) throw new Error(`opener not positioned: ${openerBottom} of ${height}`);
    const before = await page.evaluate(() => scrollY);
    await page.mouse.click(at.x + positioned.left + positioned.width / 2, at.y + positioned.top + positioned.height / 2);
    await context.waitForFunction((sel) => !!document.querySelector(sel), { timeout: 5000 }, dialog);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await page.evaluate(() => scrollY);
    const panel = await rectOf(dialog);
    const shifted = await originOf();
    const top = shifted.y + panel.top;
    const bottom = shifted.y + panel.bottom;
    const actual = { openerBottom, before, after, panelTop: top, panelBottom: bottom, viewportHeight: height };
    return { expected: "reader-opened dialog wholly in view within 2 px", actual, pass: top >= -2 && bottom <= height + 2 };
  } finally { await page.close(); }
}

async function main() {
  if (distOption >= 0 && !args[distOption + 1]) throw new Error("--dist needs a path");
  await access(path.join(dist, "index.html"));
  const manualRoutes = [];
  for (const entry of await readdir(path.join(dist, "manual"), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "demo") continue;
    try {
      await access(path.join(dist, "manual", entry.name, "index.html"));
      manualRoutes.push(`/manual/${entry.name}/`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  manualRoutes.sort();
  if (!manualRoutes.includes("/manual/devserver/") || !manualRoutes.includes("/manual/install/")) throw new Error("built manual inventory lacks required pages");
  const chrome = await chromePath();
  await access(chrome);
  const require = createRequire(path.join(root, "scripts/e2e/browser-smoke/package.json"));
  const puppeteer = require("puppeteer-core");
  const server = serve();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    try {
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    } catch (error) {
      throw Object.assign(new Error(`Chrome could not start: ${error}`), { unavailable: true });
    }
    console.log(JSON.stringify({ mode, dist, chromeVersion: await browser.version(), origin }));
    console.log(JSON.stringify({ manualRoutes }));

    for (const [label, viewport] of Object.entries(viewports)) {
      await check(`${label} Devserver without fragment`, async () => {
        const page = await open(browser, origin, "/manual/devserver/", viewport, label !== "phone");
        try {
          if (label === "phone") {
            try {
              await page.waitForFunction(() => !!document.querySelector("iframe.launcher-demo-embed")?.contentDocument?.querySelector('.modal[role="dialog"]'), { timeout: 12000 });
            } catch (error) {
              if (error?.name !== "TimeoutError") throw error;
            }
          }
          const actual = await page.evaluate(() => ({ y: scrollY, frameMounted: !!document.querySelector("iframe.launcher-demo-embed")?.contentDocument?.querySelector('.modal[role="dialog"]') }));
          return { expected: "scrollY=0", actual, pass: actual.y === 0 };
        } finally { await page.close(); }
      });
      await check(`${label} Devserver fragment`, async () => {
        const page = await open(browser, origin, "/manual/devserver/#remote-workspaces", viewport);
        try {
          const actual = await page.evaluate(() => ({ top: document.getElementById("remote-workspaces")?.getBoundingClientRect().top, height: innerHeight, y: scrollY }));
          return { expected: "heading inside viewport", actual, pass: actual.top >= -1 && actual.top < actual.height };
        } finally { await page.close(); }
      });
      await check(`${label} Devserver fragment exact`, async () => {
        const page = await open(browser, origin, "/manual/devserver/#remote-workspaces", viewport);
        try {
          const actual = await page.evaluate(() => {
            const heading = document.getElementById("remote-workspaces");
            const top = heading.getBoundingClientRect().top;
            heading.scrollIntoView();
            return { top, ownLandingTop: heading.getBoundingClientRect().top };
          });
          return { expected: "heading within 2 px of its own fragment landing", actual, pass: Math.abs(actual.top - actual.ownLandingTop) <= 2 };
        } finally { await page.close(); }
      });
      for (const [route, name] of [["/manual/install/", "Install"], ["/manual/devserver/", "Devserver"]]) {
        await check(`${label} ${name} reader-opened dialog`, () => readerOpen(browser, origin, route, viewport));
      }
      for (const route of [...manualRoutes.filter((route) => route !== "/manual/devserver/"), "/animations/"]) {
        await check(`${label} ${route} control`, async () => {
          const page = await open(browser, origin, route, viewport);
          try {
            const actual = await page.evaluate(() => scrollY);
            return { expected: "scrollY=0", actual, pass: actual === 0 };
          } finally { await page.close(); }
        });
      }
    }

    await check("phone scroll toward lazy Devserver demo", async () => {
      const page = await open(browser, origin, "/manual/devserver/", viewports.phone, false);
      try {
        const set = await page.evaluate(() => {
          const frame = document.querySelector("iframe.launcher-demo-embed");
          const top = frame.getBoundingClientRect().top + scrollY;
          const requested = Math.max(0, top - innerHeight - 200);
          window.scrollTo({ top: requested, behavior: "instant" });
          return { requested, y: scrollY, frameTop: frame.getBoundingClientRect().top, height: innerHeight };
        });
        if (set.frameTop <= set.height) throw new Error(`frame must remain outside viewport: ${JSON.stringify(set)}`);
        await ready(page, "/manual/devserver/");
        const actual = { set, after: await page.evaluate(() => scrollY) };
        return { expected: "scrollY remains at the set offset within 2 px after the lazy frame mounts", actual, pass: Math.abs(actual.after - set.y) <= 2 };
      } finally { await page.close(); }
    });

    if (mode === "verify") await check("Devserver pointer and keyboard interaction", async () => {
      const page = await open(browser, origin, "/manual/devserver/", viewports.desktop);
      try {
        const initial = await page.evaluate(() => ({ y: scrollY, parentActive: document.activeElement?.tagName }));
        await page.evaluate(() => document.querySelector("iframe.launcher-demo-embed").scrollIntoView({ block: "center", behavior: "instant" }));
        const frame = await (await page.$("iframe.launcher-demo-embed")).contentFrame();
        const address = await frame.$('input[placeholder^="127.0.0.1"]');
        if (!address) throw new Error("Address field absent");
        await address.click();
        await address.type("127.0.0.1:8787");
        const typed = await frame.evaluate(() => ({ value: document.querySelector('input[placeholder^="127.0.0.1"]')?.value, active: document.activeElement?.tagName }));
        await page.keyboard.press("Tab");
        const afterTab = await frame.evaluate(() => document.activeElement?.tagName);
        await page.keyboard.press("Escape");
        await frame.waitForFunction(() => !document.querySelector('.modal[role="dialog"]'), { timeout: 5000 });
        await frame.click(".add-devserver");
        await frame.waitForFunction(() => !!document.querySelector('.modal[role="dialog"]'), { timeout: 5000 });
        const reopened = await frame.evaluate(() => document.activeElement?.matches('.modal[role="dialog"]'));
        const actual = { initial, typed, afterTab, reopened };
        return { expected: "initial manual focus retained; pointer types Address; Tab reaches textarea; Escape closes; demo button reopens with modal focus", actual, pass: initial.y === 0 && initial.parentActive !== "IFRAME" && typed.value === "127.0.0.1:8787" && typed.active === "INPUT" && afterTab === "TEXTAREA" && reopened === true };
      } finally { await page.close(); }
    });
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  console.log(JSON.stringify({ verdict: failed ? "failed" : "passed", failures: failed }));
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = error?.unavailable || error?.code === "ENOENT" || error?.code === "MODULE_NOT_FOUND" ? 2 : 1;
});
