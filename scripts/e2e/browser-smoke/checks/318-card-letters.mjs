// A row letter pressed on a Computers card selected as a whole acts on the
// row Enter takes from the card, which on a devserver's card is its header:
// `t` asks for a terminal on that devserver and `o` disconnects or connects
// it. The built launcher runs on the desktop surface against this check's own
// backend, which serves one connected devserver with one running workspace
// and answers the devserver's terminal, connect and disconnect routes and the
// workspace's open and power routes. The launcher's requests are read in the
// page as it sends them, so a letter that asks for nothing is read at once.
// Legs:
//   1. card t: with the card itself focused, t asks for a terminal on the
//      devserver and focus stays on the card;
//   2. card w and h: the header has neither while the card's workspace row
//      has w, and the card asks for nothing;
//   3. card o: o disconnects the devserver, o again connects it, and focus
//      stays on the card;
//   4. header row: t and o with the header row focused act as before;
//   5. outside the deck: t and o with a top bar button focused ask for
//      nothing;
//   6. dialog: with the devserver's edit dialog open and focus on the page,
//      the deck's stand-in for the card, t and o ask for nothing;
//   7. workspace row: t and o with the workspace row focused act on the
//      workspace, not on the devserver.
// A leg's precondition failing is reported as a precondition, apart from
// the leg's own red.
//
// Runs on headless Chrome. Skips when the launcher bundle is missing.

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { showCarouselCard } from "../lib/carousel.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const DS_ID = "ds-cardkeys";
const DS_LABEL = "cardkeys-lab";
const WS_LABEL = "proj";
const WS_PATH = "/srv/proj";
const ROUTE = `/api/library/devservers/${DS_ID}`;
const ASK_TERMINAL = `POST ${ROUTE}/terminal`;
const ASK_DISCONNECT = `POST ${ROUTE}/disconnect`;
const ASK_CONNECT = `POST ${ROUTE}/connect`;
const ASK_WS_TERMINAL = `POST ${ROUTE}/workspaces/open ${JSON.stringify({ path: WS_PATH, start_terminal: true })}`;
const ASK_WS_OFF = `POST ${ROUTE}/workspaces/off`;

const DISCONNECT = `button[aria-label="Disconnect ${DS_LABEL}"]`;
const CONNECT = `button[aria-label="Connect ${DS_LABEL}"]`;
const EDIT = `button[aria-label="Edit config for ${DS_LABEL}"]`;
const WS_WINDOW = `button[aria-label="New window of ${WS_LABEL}"]`;
const WS_POWER = `button[aria-label="Turn off ${WS_LABEL} (o)"]`;
const OUTSIDE = 'header.topbar button[aria-label="Select"]';

/// The registry the launcher reads, and the routes its letters reach.
function cardBackend(distRoot) {
  const events = [];
  const initial = () => ({
    devserver: {
      id: DS_ID,
      url: "http://cardkeys.invalid:8443",
      host: "cardkeys.invalid",
      port: 8443,
      label: DS_LABEL,
      script: "",
      has_token: false,
      library_id: "lib-cardkeys",
      status: "connected",
      pending_signin: false,
      auto_hide_control: false,
      os: "linux",
      pretty_name: null,
      gateway_id: null,
      gateway_url: "",
      shared: false,
      native_trust_required: false,
      rows_hidden: false,
      connection_health: null,
    },
    workspace: {
      workspace_id: "ws-cardkeys-proj",
      path: WS_PATH,
      label: WS_LABEL,
      on: true,
      status: "running",
      library_id: "lib-cardkeys",
      devserver_id: DS_ID,
      prefix: WS_LABEL,
    },
  });
  let state = initial();

  const json = (res, body) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const empty = (res) => res.writeHead(204).end();

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { pathname } = new URL(req.url, "http://launcher.test");
        if (req.method === "GET") {
          if (pathname === "/api/library/workspaces") return json(res, [{ ...state.workspace }]);
          if (pathname === "/api/library/devservers") return json(res, [{ ...state.devserver }]);
          if (pathname === "/api/library/gateways" || pathname === "/api/library/windows") return json(res, []);
          if (pathname === "/api/library/local-theme") return json(res, { theme: null });
        } else if (pathname.startsWith(`${ROUTE}/`)) {
          events.push(`${req.method} ${pathname}${body ? ` ${body}` : ""}`);
          const action = pathname.slice(ROUTE.length + 1);
          if (action === "disconnect") state.devserver.status = "disconnected";
          if (action === "connect") state.devserver.status = "connected";
          if (action === "workspaces/off") Object.assign(state.workspace, { on: false, status: "stopped" });
          if (action === "workspaces/on") Object.assign(state.workspace, { on: true, status: "running" });
          return empty(res);
        }
        if (pathname.startsWith("/api/")) return res.writeHead(404).end("not found");

        let rel = normalize(pathname).replace(/^([/\\])+/, "");
        if (rel.startsWith("..")) throw new Error("traversal");
        if (!rel) rel = "index.html";
        let file = join(distRoot, rel);
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
        if (!existsSync(file)) file = join(distRoot, "index.html");
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
      } catch {
        res.writeHead(400).end("bad request");
      }
    });
  });
  server.on("upgrade", (_req, socket) => socket.destroy());

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        events,
        url: `http://127.0.0.1:${port}`,
        restoreWorkspace: () => { state.workspace = initial().workspace; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

class Precondition extends Error {}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function precondition(condition, message) {
  if (!condition) throw new Precondition(message);
}

/// Where focus is, as the deck reads it: the devserver's card itself, its
/// header row, its workspace row, the page, or something else.
async function focusAt(page) {
  return page.evaluate((disconnect, connect) => {
    const slot = document.querySelector(disconnect)?.closest(".slot") ?? document.querySelector(connect)?.closest(".slot");
    const active = document.activeElement;
    if (!slot) return { at: "no card" };
    const front = slot.getAttribute("aria-current") === "true" && !slot.closest("[inert]");
    if (active === slot) return { at: "card", front };
    if (active === slot.querySelector(".machine-header")) return { at: "header", front };
    if (active === slot.querySelector(".ws-head")) return { at: "workspace", front };
    if (active === document.body) return { at: "page", front };
    return { at: `${active?.tagName.toLowerCase()} ${active?.getAttribute("aria-label") ?? active?.className ?? ""}`, front };
  }, DISCONNECT, CONNECT);
}

/// Focus the devserver card itself, its header row or its workspace row.
async function focusOn(page, where) {
  await page.evaluate((disconnect, connect, place) => {
    const slot = document.querySelector(disconnect)?.closest(".slot") ?? document.querySelector(connect)?.closest(".slot");
    const target = place === "card" ? slot : slot?.querySelector(place === "header" ? ".machine-header" : ".ws-head");
    target?.focus({ preventScroll: true });
  }, DISCONNECT, CONNECT, where);
  const reading = await focusAt(page);
  precondition(reading.at === where && reading.front, `focus is not on the devserver's ${where} in front: ${JSON.stringify(reading)}`);
}

const asked = (page) => page.evaluate(() => window.__asked318.slice());

/// Press a letter and return what the launcher asked for. A letter clicks
/// its button inside the keydown, and the button's action sends its request
/// before it first waits, so two frames later every request it made is in
/// the page's record.
async function press(page, letter) {
  const before = (await asked(page)).length;
  await page.keyboard.press(letter);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return (await asked(page)).slice(before);
}

/// The devserver connected, its workspace on and running, as the launcher
/// renders them; a leg that failed half way is put back by the pointer.
async function connected(page, backend) {
  if (await page.$(CONNECT)) {
    await page.$eval(CONNECT, (button) => button.click());
    await page.waitForSelector(DISCONNECT, { timeout: 15_000 });
  }
  backend.restoreWorkspace();
  await page.waitForSelector(`${WS_POWER}:not([disabled])`, { timeout: 15_000 });
  await showCarouselCard(page, DISCONNECT, 15_000);
}

export default {
  name: "card-letters",
  async run(ctx) {
    const distRoot = join(ctx.repoRoot, "web-launcher", "dist");
    if (!existsSync(join(distRoot, "index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }

    const backend = await cardBackend(distRoot);
    const result = { steps: [], legs: {}, failures: [] };
    const step = (label) => result.steps.push(`${new Date().toISOString().slice(11, 19)} ${label}`);
    let page = null;
    try {
      page = await ctx.browser.newPage();
      await page.evaluateOnNewDocument(() => {
        const native = window.fetch.bind(window);
        window.__asked318 = [];
        window.fetch = (input, init = {}) => {
          const method = (init.method ?? "GET").toUpperCase();
          if (method !== "GET") {
            const url = new URL(typeof input === "string" ? input : input.url, location.href);
            window.__asked318.push(`${method} ${decodeURIComponent(url.pathname)}${typeof init.body === "string" ? ` ${init.body}` : ""}`);
          }
          return native(input, init);
        };
      });
      await page.goto(backend.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.bringToFront();
      try {
        await page.waitForSelector(DISCONNECT, { timeout: 30_000 });
        await showCarouselCard(page, DISCONNECT, 30_000);
        await page.waitForSelector(`${WS_POWER}:not([disabled])`, { timeout: 15_000 });
      } catch (error) {
        throw new Error(`precondition: the devserver's card never came to the front connected with its workspace: ${error.message}`);
      }
      step("the devserver's card is in front, connected, with its workspace running");
      await ctx.shot("318-card-in-front", page);

      const leg = async (name, body) => {
        const reading = { asks: {} };
        result.legs[name] = reading;
        try {
          await connected(page, backend);
          await body(reading);
          reading.passed = true;
          step(`${name} passed`);
        } catch (error) {
          const kind = error instanceof Precondition ? "precondition" : "red";
          reading.failure = `${kind}: ${error.message}`;
          result.failures.push(`${name} ${reading.failure}`);
          step(`${name} ${kind}`);
          await ctx.shot(`318-${name}-failure`, page).catch(() => {});
        }
      };

      await leg("cardTerminal", async (r) => {
        await focusOn(page, "card");
        r.asks.t = await press(page, "t");
        r.focusAfter = await focusAt(page);
        check(JSON.stringify(r.asks.t) === JSON.stringify([ASK_TERMINAL]), `t at the card asked for ${JSON.stringify(r.asks.t)}, not a terminal on the devserver`);
        check(r.focusAfter.at === "card", `focus left the card after t: ${JSON.stringify(r.focusAfter)}`);
      });

      await leg("cardWithoutHeaderLetter", async (r) => {
        r.workspaceHasW = await page.$eval(WS_WINDOW, (button) => button.dataset.deckKey === "w" && !button.disabled);
        precondition(r.workspaceHasW, "the workspace row's New window is not an enabled w button");
        await focusOn(page, "card");
        r.asks.w = await press(page, "w");
        r.asks.h = await press(page, "h");
        check(r.asks.w.length === 0 && r.asks.h.length === 0, `w and h at the card asked for ${JSON.stringify(r.asks)}`);
      });

      await leg("cardConnection", async (r) => {
        await focusOn(page, "card");
        r.asks.off = await press(page, "o");
        check(JSON.stringify(r.asks.off) === JSON.stringify([ASK_DISCONNECT]), `o at the card asked for ${JSON.stringify(r.asks.off)}, not a disconnect`);
        await page.waitForSelector(CONNECT, { timeout: 15_000 });
        r.focusAfterOff = await focusAt(page);
        check(r.focusAfterOff.at === "card", `focus left the card after the disconnect: ${JSON.stringify(r.focusAfterOff)}`);
        await ctx.shot("318-card-disconnected", page);
        r.asks.on = await press(page, "o");
        check(JSON.stringify(r.asks.on) === JSON.stringify([ASK_CONNECT]), `o at the card asked for ${JSON.stringify(r.asks.on)}, not a connect`);
        await page.waitForSelector(DISCONNECT, { timeout: 15_000 });
        r.focusAfterOn = await focusAt(page);
        check(r.focusAfterOn.at === "card", `focus left the card after the connect: ${JSON.stringify(r.focusAfterOn)}`);
      });

      await leg("headerRow", async (r) => {
        await focusOn(page, "header");
        r.asks.t = await press(page, "t");
        check(JSON.stringify(r.asks.t) === JSON.stringify([ASK_TERMINAL]), `t on the header asked for ${JSON.stringify(r.asks.t)}`);
        r.asks.off = await press(page, "o");
        check(JSON.stringify(r.asks.off) === JSON.stringify([ASK_DISCONNECT]), `o on the header asked for ${JSON.stringify(r.asks.off)}`);
        await page.waitForSelector(CONNECT, { timeout: 15_000 });
        r.asks.on = await press(page, "o");
        check(JSON.stringify(r.asks.on) === JSON.stringify([ASK_CONNECT]), `o on the header asked for ${JSON.stringify(r.asks.on)}`);
        await page.waitForSelector(DISCONNECT, { timeout: 15_000 });
        r.focusAfter = await focusAt(page);
        check(r.focusAfter.at === "header", `focus left the header row: ${JSON.stringify(r.focusAfter)}`);
      });

      await leg("outsideDeck", async (r) => {
        await page.$eval(OUTSIDE, (button) => button.focus());
        r.focus = await page.evaluate((selector) => document.activeElement === document.querySelector(selector), OUTSIDE);
        precondition(r.focus, "the top bar's Select button did not take focus");
        r.asks.t = await press(page, "t");
        r.asks.o = await press(page, "o");
        check(r.asks.t.length === 0 && r.asks.o.length === 0, `t and o outside the deck asked for ${JSON.stringify(r.asks)}`);
      });

      await leg("dialog", async (r) => {
        await focusOn(page, "card");
        await page.$eval(EDIT, (button) => button.click());
        await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        r.focus = await focusAt(page);
        precondition(r.focus.at === "page", `focus is not on the page under the dialog: ${JSON.stringify(r.focus)}`);
        r.asks.t = await press(page, "t");
        r.asks.o = await press(page, "o");
        r.dialogOpen = Boolean(await page.$('[role="dialog"]'));
        await ctx.shot("318-dialog", page);
        await page.$eval('[role="dialog"] .modal-close', (button) => button.click());
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });
        check(r.asks.t.length === 0 && r.asks.o.length === 0, `t and o with the dialog open asked for ${JSON.stringify(r.asks)}`);
        check(r.dialogOpen, "the dialog closed under the letters");
      });

      await leg("workspaceRow", async (r) => {
        await focusOn(page, "workspace");
        r.asks.t = await press(page, "t");
        check(JSON.stringify(r.asks.t) === JSON.stringify([ASK_WS_TERMINAL]), `t on the workspace row asked for ${JSON.stringify(r.asks.t)}, not its terminal window`);
        r.asks.o = await press(page, "o");
        check(r.asks.o.length === 1 && r.asks.o[0].startsWith(`${ASK_WS_OFF} `), `o on the workspace row asked for ${JSON.stringify(r.asks.o)}, not its power`);
        r.stillConnected = Boolean(await page.$(DISCONNECT));
        check(r.stillConnected, "the devserver is not shown connected after o on its workspace row");
      });
    } finally {
      result.backendEvents = backend.events.slice();
      writeFileSync(join(ctx.outDir, "318-card-letters.json"), `${JSON.stringify(result, null, 2)}\n`);
      if (page) await page.close().catch(() => {});
      await backend.close();
    }
    if (result.failures.length) throw new Error(result.failures.join("\n"));
    return { steps: result.steps, backendEvents: result.backendEvents };
  },
};
