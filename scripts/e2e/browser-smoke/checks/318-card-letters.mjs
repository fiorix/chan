// A row letter pressed on a Computers card selected as a whole, the card
// itself holding focus and its ring painted, acts on the row Enter takes from
// the card, which on a devserver's card is its header: `t` asks for a
// terminal on that devserver and `o` disconnects or connects it. A clicked
// row is selected the same way. With nothing selected a letter does nothing.
// The built launcher runs on the desktop surface against this check's own
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
//   4. nothing focused: with focus on the page, no dialog and the surface
//      not inert, t and o ask for nothing;
//   5. pointer: a mouse click on the card's empty body selects it and paints
//      its one ring before any key, then t asks for the terminal and o for
//      the disconnect, and focus stays on the card;
//   6. pointer row: a mouse click on an empty point of the workspace row
//      selects it and paints its one ring, and t acts on that row;
//   7. All windows row: a click on the row nested in its list item paints
//      one ring, on the row holding focus, before and after a key, and a
//      focused control inside it lights no row's ring;
//   8. mouse turn: the side buttons, pressed with the mouse, leave the new
//      front card selected with its ring, and a letter acts on that card and
//      not on the one that was in front; Enter on a side button turns the
//      deck and keeps focus on the button;
//   9. header row: t and o with the header row focused act as before;
//  10. outside the deck: t and o with a top bar button focused ask for
//      nothing;
//  11. dialog: with the devserver's edit dialog open the surface is inert
//      and cannot hold focus on the card, so the letters are pressed with
//      focus on the page, and ask for nothing;
//  12. workspace row: t and o with the workspace row focused act on the
//      workspace, not on the devserver.
// The keyboard legs reach the card and its rows as the owner does: an arrow
// turns the deck away and back, which focuses the card, and Down walks to a
// row.
// A leg's precondition failing is reported as a precondition, apart from
// the leg's own red.
//
// Runs on headless Chrome. Skips when the launcher bundle is missing.

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
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

const DS_ID = "ds-letters";
const DS_LABEL = "letters-lab";
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
const WS_TERMINAL = `button[aria-label="New terminal window of ${WS_LABEL}"]`;
const WS_POWER = `button[aria-label="Turn off ${WS_LABEL} (o)"]`;
const WINDOW_ID = "win-letters";
const ALL_WINDOWS_ROW = `.all-windows [data-window-id="${WINDOW_ID}"]`;
const OUTSIDE = 'header.topbar button[aria-label="Select"]';
const NEXT = 'button[aria-label="Next card"]';
const PREVIOUS = 'button[aria-label="Previous card"]';

/// One window of the local machine, so All windows has a row to click.
const LOCAL_WINDOW = {
  window_id: WINDOW_ID,
  library_id: "local",
  kind: "terminal",
  title: "letters window",
  ordinal: 1,
  workspace_path: null,
  prefix: "",
  token: "",
  persisted: false,
  connected: true,
  active_transfer: false,
  hidden: false,
};

/// The registry the launcher reads, and the routes its letters reach.
function cardBackend(distRoot) {
  const events = [];
  const initial = () => ({
    devserver: {
      id: DS_ID,
      url: "http://letters.invalid:8443",
      host: "letters.invalid",
      port: 8443,
      label: DS_LABEL,
      script: "",
      has_token: false,
      library_id: "lib-letters",
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
      workspace_id: "ws-letters-proj",
      path: WS_PATH,
      label: WS_LABEL,
      on: true,
      status: "running",
      library_id: "lib-letters",
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
          if (pathname === "/api/library/gateways") return json(res, []);
          if (pathname === "/api/library/windows") return json(res, [{ ...LOCAL_WINDOW }]);
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
  // The launcher reads its windows from this feed alone, as one snapshot.
  const feed = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://launcher.test").pathname !== "/api/library/windows/watch") return socket.destroy();
    feed.handleUpgrade(req, socket, head, (client) => client.send(JSON.stringify({ windows: [{ ...LOCAL_WINDOW }], leaders: {} })));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        events,
        url: `http://127.0.0.1:${port}`,
        restoreWorkspace: () => { state.workspace = initial().workspace; },
        close: () => new Promise((done) => {
          for (const client of feed.clients) client.terminate();
          server.close(done);
        }),
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
    const ring = Boolean(active?.matches(":focus-visible"));
    if (active === slot) return { at: "card", front, ring };
    if (active === slot.querySelector(".machine-header")) return { at: "header", front, ring };
    if (active === slot.querySelector(".ws-head")) return { at: "workspace", front, ring };
    if (active === document.body) return { at: "page", front, ring };
    return { at: `${active?.tagName.toLowerCase()} ${active?.getAttribute("aria-label") ?? active?.className ?? ""}`, front, ring };
  }, DISCONNECT, CONNECT);
}

const blur = (page) => page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

/// How many presses of Down take the selected card to each of its rows.
const ROW_PRESSES = { card: 0, header: 1, workspace: 2 };

/// Select the devserver's card, its header row or its workspace row by the
/// keyboard: an arrow turns the deck away and another turns it back, which
/// focuses the card with its ring, and Down walks its rows.
async function focusOn(page, where) {
  try {
    await blur(page);
    const own = await page.$eval(DISCONNECT, (button) => button.closest(".slot").dataset.key);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((key) => document.querySelector('.slot[aria-current="true"]')?.dataset.key !== key, { timeout: 10_000 }, own);
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction((key) => {
      const slot = document.querySelector('.slot[aria-current="true"]');
      return slot?.dataset.key === key && document.activeElement === slot;
    }, { timeout: 10_000 }, own);
    await showCarouselCard(page, DISCONNECT, 15_000);
    for (let i = 0; i < ROW_PRESSES[where]; i += 1) await page.keyboard.press("ArrowDown");
  } catch (error) {
    throw new Precondition(`the keyboard did not reach the devserver's ${where}: ${error.message}`);
  }
  const reading = await focusAt(page);
  precondition(reading.at === where && reading.front && reading.ring, `focus is not on the devserver's ${where} in front with its ring: ${JSON.stringify(reading)}`);
}

/// The front card as the selection reads: its key, whether its slot holds
/// focus, the ring on its card, the slot's own outline, and how many cards
/// on the deck draw a ring.
function readFront() {
  const slot = document.querySelector('.slot[aria-current="true"]');
  const card = slot?.querySelector("section.card");
  const style = card ? getComputedStyle(card) : null;
  const active = document.activeElement;
  return {
    key: slot?.dataset.key ?? null,
    focused: Boolean(slot) && active === slot,
    active: active === document.body ? "body" : `${active?.tagName.toLowerCase()} ${active?.getAttribute("aria-label") ?? ""}`.trim(),
    outlineStyle: style?.outlineStyle ?? null,
    outlineWidth: style?.outlineWidth ?? null,
    ring: Boolean(style) && style.outlineStyle !== "none" && style.outlineWidth === "2px",
    slotOutline: slot ? getComputedStyle(slot).outlineStyle : null,
    cardsWithRing: [...document.querySelectorAll(".slot section.card")].filter((el) => getComputedStyle(el).outlineStyle !== "none").length,
  };
}

const oneRing = (front) => front.ring && front.slotOutline === "none" && front.cardsWithRing === 1;

/// Wait for the deck to bring a card to the front, then two frames, so a
/// focus the turn asks for has landed.
async function waitFront(page, matches, label) {
  try {
    await page.waitForFunction(matches, { timeout: 10_000 });
  } catch (error) {
    throw new Precondition(`the deck did not turn ${label}: ${error.message}`);
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/// The rows that draw a ring, and how many cards do.
function readRows() {
  const name = (el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`;
  const rings = [...document.querySelectorAll(".slot [data-deck-row]")].filter((row) => getComputedStyle(row).outlineStyle !== "none");
  return {
    active: document.activeElement ? name(document.activeElement) : null,
    rings: rings.map(name),
    width: rings[0] ? getComputedStyle(rings[0]).outlineWidth : null,
    cardsWithRing: [...document.querySelectorAll(".slot section.card")].filter((el) => getComputedStyle(el).outlineStyle !== "none").length,
  };
}

/// A point inside a row that is not inside one of its controls.
function emptyRowPoint(selector) {
  const row = document.querySelector(selector);
  if (!row) return null;
  const box = row.getBoundingClientRect();
  const y = box.top + box.height / 2;
  for (let x = box.left + 3; x < box.right - 3; x += 4) {
    const element = document.elementFromPoint(x, y);
    if (element && row.contains(element) && !element.closest("button, a, input, select, textarea, label")) {
      return { x, y, element: `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}` };
    }
  }
  return null;
}

/// A point on the front card's body that is neither a row nor a control.
function emptyCardPoint(disconnect) {
  const slot = document.querySelector(disconnect)?.closest(".slot");
  if (!slot) return null;
  const box = slot.getBoundingClientRect();
  for (let y = box.bottom - 12; y > box.top; y -= 8) {
    for (const share of [0.5, 0.25, 0.75]) {
      const x = box.left + box.width * share;
      const element = document.elementFromPoint(x, y);
      if (element && slot.contains(element) && !element.closest("[data-deck-row], button, a, input, select, textarea, label")) {
        return { x, y, element: `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}` };
      }
    }
  }
  return null;
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
  await page.waitForSelector(`${DISCONNECT}, ${CONNECT}`, { timeout: 15_000 });
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
          await connected(page, backend).catch((error) => { throw new Precondition(`the devserver was not put back connected: ${error.message}`); });
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

      await leg("nothingFocused", async (r) => {
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        r.state = await page.evaluate(() => ({
          activeIsBody: document.activeElement === document.body,
          surface: Boolean(document.querySelector(".launcher-surface")),
          surfaceInert: Boolean(document.querySelector(".launcher-surface")?.closest("[inert]")),
          dialog: Boolean(document.querySelector('[role="dialog"]')),
        }));
        r.front = await page.evaluate(readFront);
        precondition(r.state.activeIsBody && r.state.surface && !r.state.surfaceInert && !r.state.dialog, `the page is not at rest with nothing focused: ${JSON.stringify(r.state)}`);
        r.asks.t = await press(page, "t");
        r.asks.o = await press(page, "o");
        r.stillConnected = Boolean(await page.$(DISCONNECT));
        check(r.front.cardsWithRing === 0, `a card shows a ring with nothing selected: ${JSON.stringify(r.front)}`);
        check(r.asks.t.length === 0 && r.asks.o.length === 0, `t and o with nothing focused asked for ${JSON.stringify(r.asks)}`);
        check(r.stillConnected, "the devserver is not shown connected after o with nothing focused");
      });

      await leg("pointerCard", async (r) => {
        await blur(page);
        r.point = await page.evaluate(emptyCardPoint, DISCONNECT);
        precondition(r.point, "the front card has no point that is neither a row nor a control");
        await page.mouse.click(r.point.x, r.point.y);
        r.selected = await page.evaluate(readFront);
        check(r.selected.focused, `the mouse click on ${r.point.element} did not select the card: ${JSON.stringify(r.selected)}`);
        check(oneRing(r.selected), `the selected card does not paint one ring: ${JSON.stringify(r.selected)}`);
        r.asks.t = await press(page, "t");
        check(JSON.stringify(r.asks.t) === JSON.stringify([ASK_TERMINAL]), `t at the clicked card asked for ${JSON.stringify(r.asks.t)}, not a terminal on the devserver`);
        r.asks.o = await press(page, "o");
        check(JSON.stringify(r.asks.o) === JSON.stringify([ASK_DISCONNECT]), `o at the clicked card asked for ${JSON.stringify(r.asks.o)}, not a disconnect`);
        await page.waitForSelector(CONNECT, { timeout: 15_000 });
        r.focusAfter = await focusAt(page);
        check(r.focusAfter.at === "card", `focus left the clicked card: ${JSON.stringify(r.focusAfter)}`);
      });

      await leg("pointerRow", async (r) => {
        r.hasT = await page.$eval(WS_TERMINAL, (button) => button.dataset.deckKey === "t" && !button.disabled);
        precondition(r.hasT, "the workspace row's New terminal window is not an enabled t button");
        await blur(page);
        r.point = await page.evaluate(emptyRowPoint, '.slot[aria-current="true"] .ws-head');
        precondition(r.point, "the workspace row has no point outside its controls");
        await page.mouse.click(r.point.x, r.point.y);
        r.focus = await focusAt(page);
        r.rows = await page.evaluate(readRows);
        check(r.focus.at === "workspace", `the click on ${r.point.element} did not select the workspace row: ${JSON.stringify(r.focus)}`);
        check(r.rows.rings.length === 1 && r.rows.rings[0].includes("ws-head") && r.rows.width === "1px" && r.rows.cardsWithRing === 0, `the clicked row does not paint one ring: ${JSON.stringify(r.rows)}`);
        r.asks.t = await press(page, "t");
        check(JSON.stringify(r.asks.t) === JSON.stringify([ASK_WS_TERMINAL]), `t on the clicked row asked for ${JSON.stringify(r.asks.t)}, not its terminal window`);
        r.focusAfter = await focusAt(page);
        check(r.focusAfter.at === "workspace", `focus left the clicked row: ${JSON.stringify(r.focusAfter)}`);
      });

      await leg("allWindowsRow", async (r) => {
        await showCarouselCard(page, `${ALL_WINDOWS_ROW} button[aria-label="Hide window"]`, 15_000);
        await blur(page);
        r.point = await page.evaluate(emptyRowPoint, ALL_WINDOWS_ROW);
        precondition(r.point, "the All windows row has no point outside its controls");
        await page.mouse.click(r.point.x, r.point.y);
        r.clicked = await page.evaluate(readRows);
        const single = (reading) => reading.rings.length === 1 && reading.rings[0] === reading.active && reading.width === "1px" && reading.cardsWithRing === 0;
        check(single(r.clicked), `the clicked All windows row does not paint one ring: ${JSON.stringify(r.clicked)}`);
        // A key turns :focus-visible on for whatever holds focus, which is
        // the row nested in the list item after a click on it.
        await page.keyboard.press("x");
        r.afterKey = await page.evaluate(readRows);
        check(single(r.afterKey), `the All windows row does not paint one ring after a key: ${JSON.stringify(r.afterKey)}`);
        await page.$eval(`${ALL_WINDOWS_ROW} button[aria-label="Hide window"]`, (button) => button.focus());
        r.onControl = await page.evaluate(readRows);
        check(r.onControl.rings.length === 0, `a focused control lights a row's ring: ${JSON.stringify(r.onControl)}`);
      });

      await leg("mouseTurn", async (r) => {
        r.own = await page.$eval(DISCONNECT, (button) => button.closest(".slot").dataset.key);
        await page.click(PREVIOUS);
        await waitFront(page, `document.querySelector('.slot[aria-current="true"]')?.dataset.key === "local"`, "to This machine");
        r.afterPrevious = await page.evaluate(readFront);
        check(r.afterPrevious.focused && oneRing(r.afterPrevious), `the Previous card button did not select This machine with its ring: ${JSON.stringify(r.afterPrevious)}`);
        await page.click(NEXT);
        await waitFront(page, `document.querySelector('.slot[aria-current="true"]')?.dataset.key === ${JSON.stringify(r.own)}`, "back to the devserver");
        r.afterNext = await page.evaluate(readFront);
        check(r.afterNext.focused && oneRing(r.afterNext), `the Next card button did not select the devserver's card with its ring: ${JSON.stringify(r.afterNext)}`);
        r.asks.t = await press(page, "t");
        check(JSON.stringify(r.asks.t) === JSON.stringify([ASK_TERMINAL]), `t after the turn asked for ${JSON.stringify(r.asks.t)}, not a terminal on the new front card`);
        await page.$eval(NEXT, (button) => button.focus());
        await page.keyboard.press("Enter");
        await waitFront(page, `document.querySelector('.slot[aria-current="true"]')?.dataset.key !== ${JSON.stringify(r.own)}`, "from Enter on the Next card button");
        r.afterEnter = await page.evaluate((selector) => ({ onButton: document.activeElement === document.querySelector(selector) }), NEXT);
        check(r.afterEnter.onButton, "Enter on the Next card button took focus off the button");
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
