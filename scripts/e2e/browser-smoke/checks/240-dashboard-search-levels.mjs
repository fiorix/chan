// The Dashboard's Search slide draws the workspace's directories by level,
// and a double-click on a directory opens or closes it in place.
//
// In a window of its own, with a fixture tree three directories deep in the
// workspace, a Dashboard shows its Search slide. With nothing opened the
// slide draws the workspace's node and one disc for each directory in the
// root, and none for the directories below them: the count of what the route
// answers a request that opens nothing, which lists no deeper directory. A
// double-click on the fixture's disc opens it: the slide asks the route for
// that directory's level and draws the two directories it holds, and a
// double-click on one of those draws the level under it. No request the
// slide sends names anything but the directories the check opened. The
// window's saved session then holds the opened directories, and the window
// opened again from its session alone draws the same spine. A double-click
// on the fixture's disc there closes it, and the canvas is back to the
// root's level.
//
// A double-click here is a user's: Details is closed, the first click
// selects the directory, which opens Details, and the second follows a
// tenth of a second later. Details opens over the right side of the
// canvas, so the last leg pans the spine until the fixture's disc lies
// there and double-clicks it: the second click has to reach the disc under
// the panel, not the panel, and open the directory.
//
// A disc is found by what the slide says of it: a click selects the
// directory under it, and the slide's Details panel is titled with that
// directory's name. The discs are tried from the one painted in the
// directory's place in the route's answer, which is the order the slide
// draws them in. Details takes its room from the canvas a moment after it
// opens, so each click reads the discs again once they hold still.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../lib/drafts.mjs";
import { graphDiscPoints, steadyGraphDiscs, traceGraphDiscs, untraceGraphDiscs } from "../lib/graph-discs.mjs";

const RUN = Date.now().toString(36);
const DIR = `search-levels-${RUN}`;
/// The fixture: DIR holds alpha and beta, alpha holds one and three, and one
/// holds two. Each leaf carries a note, so every directory has text to index.
const LEAVES = ["alpha/one/two", "alpha/three", "beta"];
const DEEPEST = `${DIR}/${LEAVES[0]}`;
const HOST = ".slide-indexing .indexing-graph-host";
const HINT = "double-click a directory to open it";
/// Longer than the session save's debounce and its write, on a loaded host.
const SAVED_WITHIN_MS = 10_000;
/// The room Details takes at the canvas's right side: its default width and
/// the margin on either side of it.
const DETAILS_ROOM = 320 + 24;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function windowUrl(ctx, windowId, layout) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  if (layout) url.hash = "s=" + encodeURIComponent(JSON.stringify(layout));
  return url.href;
}

/// The route's answer to a request that names `open` as opened.
async function indexingState(ctx, open = []) {
  const query = open.map((dir) => `open=${encodeURIComponent(dir)}`).join("&");
  const reply = await request(ctx, `/api/indexing/state${query ? `?${query}` : ""}`);
  assert.equal(reply.status, 200, `GET /api/indexing/state: ${reply.status} ${reply.text?.slice(0, 200)}`);
  return reply.json.nodes.map((node) => node.path);
}

/// The Dashboard tab of the window's saved session, or null.
async function savedDashboard(ctx, windowId) {
  const reply = await request(ctx, `/api/session?w=${encodeURIComponent(windowId)}`);
  if (reply.status === 204) return null;
  assert.equal(reply.status, 200, `GET /api/session: ${reply.status}`);
  const find = (node) => {
    if (!node) return null;
    if (node.k === "s") return find(node.a) ?? find(node.b);
    return [...(node.t ?? []), ...(node.bt ?? [])].find((tab) => tab.k === "d") ?? null;
  };
  return find(reply.json.layout);
}

async function showSlide(page, label, selector) {
  const clicked = await page.evaluate((dotLabel) => {
    const dot = document.querySelector(`.dashboard.active .dot-btn[aria-label="${dotLabel}"]`);
    if (!(dot instanceof HTMLElement)) return false;
    dot.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`carousel dot not found: ${label}`);
  await page.waitForSelector(`.dashboard.active ${selector}`, { timeout: 15_000 });
}

/// The discs once they hold still and number `want`.
async function discs(page, want, what) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const read = await steadyGraphDiscs(page, HOST);
    if (read.count === want) return read;
    if (Date.now() > deadline) throw new Error(`${what}: the slide draws ${read.count} discs, not ${want}`);
    await delay(300);
  }
}

/// The title of the slide's Details panel, which names the selected
/// directory, or null while nothing is selected.
function selectedName(page) {
  return page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
    await frame();
    await frame();
    return document.querySelector(".slide-indexing aside.inspector .title-text")?.textContent?.trim() ?? null;
  });
}

/// Select the directory named `name` by clicking the slide's discs in turn,
/// the one at `likely` first, and answer its place among the discs.
async function select(page, name, likely) {
  const seen = [];
  const total = (await steadyGraphDiscs(page, HOST)).count;
  const others = Array.from({ length: total }, (_, i) => i).filter((i) => i !== likely);
  for (const i of [likely, ...others]) {
    await steadyGraphDiscs(page, HOST);
    const at = (await graphDiscPoints(page, HOST))[i];
    if (!at) continue;
    await page.mouse.click(at.x, at.y);
    const title = await selectedName(page);
    seen.push(title);
    if (title === name) return i;
  }
  throw new Error(`no disc selects ${name}: the discs select ${JSON.stringify(seen)}`);
}

/// Close Details by its own button, which clears the selection.
async function closeDetails(page) {
  await page.evaluate(() => document.querySelector(".slide-indexing aside.inspector button.close")?.click());
  await page.waitForFunction(() => !document.querySelector(".slide-indexing aside.inspector"), { timeout: 5_000 });
}

/// An observed settle window that expires is a delayed reading; a window
/// that never starts is the defect this leg must still be able to find.
function expiredDetails(reading) {
  const error = new Error(`ENVIRONMENT_DETAILS_SETTLE_ELAPSED: Details' observed settle window cleared before the second click reached it: ${JSON.stringify(reading)}`);
  error.code = "ENVIRONMENT_DETAILS_SETTLE_ELAPSED";
  return error;
}

/// Two clicks at one point a tenth of a second apart. The overlay leg also
/// observes the class before the first click, so a slow round trip cannot
/// mislabel an absent settle window as one that already expired.
export async function pressTwice(page, at, underDetails = false) {
  const reading = {};
  if (underDetails) {
    await page.waitForFunction(() => {
      const row = document.querySelector(".slide-indexing .indexing-row");
      return row && !row.classList.contains("details-settling") && !row.querySelector("aside.inspector");
    }, { timeout: 5_000 });
    await page.evaluate(() => {
      const row = document.querySelector(".slide-indexing .indexing-row");
      const state = { entered: false, enteredAt: null, firstAt: null, secondAt: null, secondSettling: null };
      const sample = (records = []) => {
        const settling = row.classList.contains("details-settling");
        if (settling || records.some((record) => record.oldValue?.split(/\s+/).includes("details-settling"))) {
          state.entered = true;
          state.enteredAt ??= performance.now();
        }
        return settling;
      };
      const observer = new MutationObserver(sample);
      observer.observe(row, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
      const press = (event) => {
        if (event.detail === 1) state.firstAt = performance.now();
        if (event.detail === 2) {
          state.secondAt = performance.now();
          state.secondSettling = sample(observer.takeRecords());
        }
      };
      row.addEventListener("mousedown", press, true);
      window.__smokeDetailsPress = {
        read: () => {
          const settling = sample(observer.takeRecords());
          return { ...state, settling, readAt: performance.now() };
        },
        stop: () => { observer.disconnect(); row.removeEventListener("mousedown", press, true); },
      };
    });
  }
  try {
    await page.mouse.click(at.x, at.y);
    await delay(100);
    if (underDetails) {
      reading.before = await page.evaluate(() => window.__smokeDetailsPress.read());
      assert.ok(reading.before.entered, `Details never entered its settle window after the first click: ${JSON.stringify(reading.before)}`);
      if (!reading.before.settling) throw expiredDetails(reading);
    }
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    if (underDetails) {
      reading.after = await page.evaluate(() => window.__smokeDetailsPress.read());
      assert.notEqual(reading.after.secondSettling, null, "the second mousedown was not observed on the indexing row");
      if (!reading.after.secondSettling) throw expiredDetails(reading);
    }
    return reading;
  } catch (error) {
    error.smokeDetails = { detailsPress: reading };
    throw error;
  } finally {
    if (underDetails) await page.evaluate(() => {
      window.__smokeDetailsPress.stop();
      delete window.__smokeDetailsPress;
    });
  }
}

/// The disc of the directory at `path`, with Details closed and the layout
/// at rest: its place among the discs, and where it is. `open` is the
/// directories the slide draws opened.
async function discOf(ctx, page, path, open) {
  const likely = (await indexingState(ctx, open)).indexOf(path);
  const index = await select(page, path.split("/").at(-1), likely);
  await closeDetails(page);
  await steadyGraphDiscs(page, HOST);
  return { index, at: (await graphDiscPoints(page, HOST))[index] };
}

async function doubleClick(ctx, page, path, open) {
  await pressTwice(page, (await discOf(ctx, page, path, open)).at);
}

/// Pan the spine to the right until the disc at `at` lies where Details
/// opens over the canvas, and answer where the disc is then. The press
/// starts on a point no disc is near and ends inside the canvas, which is
/// what makes it a pan.
async function panUnderDetails(page, at) {
  const box = await page.evaluate((host) => {
    const r = document.querySelector(`${host} canvas`).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, HOST);
  const dx = Math.max(0, box.right - DETAILS_ROOM + 80 - at.x);
  const points = await graphDiscPoints(page, HOST);
  const clear = (p) => points.every((d) => Math.hypot(d.x - p.x, d.y - p.y) > 40);
  const starts = [];
  for (let y = box.top + 20; y < box.bottom - 20; y += 40) starts.push({ x: box.left + 20, y });
  const from = starts.find(clear);
  if (!from || from.x + dx > box.right - 10) {
    throw new Error(`no room to pan the spine by ${dx} px: ${JSON.stringify({ box, at })}`);
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y, { steps: 8 });
  await page.mouse.up();
  await steadyGraphDiscs(page, HOST);
  // A disc panned out of view is no longer painted, so the disc is found
  // again by where the pan put it, not by its place among the discs.
  const moved = (await graphDiscPoints(page, HOST)).find((d) => Math.hypot(d.x - (at.x + dx), d.y - at.y) < 8);
  const covered = moved && moved.x > box.right - DETAILS_ROOM + 20 && moved.x < box.right - 20;
  if (!covered) {
    throw new Error(`the pan did not put the disc under Details: ${JSON.stringify({ box, at, dx, moved })}`);
  }
  return moved;
}

export default {
  name: "dashboard-search-levels",
  async run(ctx) {
    for (const leaf of LEAVES) {
      mkdirSync(join(ctx.workspaceDir, DIR, leaf), { recursive: true });
      writeFileSync(join(ctx.workspaceDir, DIR, leaf, "note.md"), `# ${leaf}\n`);
    }
    const windowId = `smoke-240-${RUN}`;
    const pages = [];
    const errors = [];
    /// What each indexing-state request of a page named as opened, in order.
    const asked = [];
    const open = async (href) => {
      const page = await ctx.browser.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (sent) => {
        const url = new URL(sent.url());
        if (url.pathname.endsWith("/api/indexing/state")) asked.push(url.searchParams.getAll("open"));
      });
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".dashboard.active .carousel", { timeout: 30_000 });
      // The trace sees a frame only as it is painted, and a spine at rest
      // paints none: it goes in before the Search slide mounts its canvas.
      await showSlide(page, "Metrics", ".metrics-slide");
      await traceGraphDiscs(page, HOST);
      await showSlide(page, "Search", `${HOST} canvas`);
      return page;
    };
    try {
      // The slide draws what the server's walk of the tree holds.
      const start = Date.now();
      for (;;) {
        const listed = await indexingState(ctx, [DIR, `${DIR}/alpha`, `${DIR}/alpha/one`]);
        if (listed.includes(DEEPEST)) break;
        if (Date.now() - start > 30_000) throw new Error(`the indexing state never listed ${DEEPEST}`);
        await delay(250);
      }
      const rootLevel = await indexingState(ctx);
      const failures = [];
      const below = rootLevel.filter((path) => path.includes("/"));
      if (below.length > 0) {
        failures.push(`a request that opens nothing is answered with ${below.length} directories below the root's level, ${below[0]} among them`);
      }
      // The root and the directories in it, whatever an earlier check left.
      const level = rootLevel.length - below.length;
      assert.ok(rootLevel.includes(DIR), `the root's level lists the fixture: ${JSON.stringify(rootLevel)}`);

      // The tab opens on Metrics with its rotation off, so the slide shown
      // is the one the check asks for.
      const first = await open(windowUrl(ctx, windowId, { k: "l", f: 1, t: [{ k: "d", cs: 3, ar: false, a: 1 }] }));
      const closed = await steadyGraphDiscs(first, HOST);
      if (closed.count !== level) {
        failures.push(`with nothing opened the slide draws ${closed.count} discs, not the ${level} of the root's level`);
      }
      await ctx.shot("240-root-level", first);
      assert.deepEqual(failures, []);
      assert.equal(
        await first.evaluate(() => document.querySelector(".slide-indexing .indexing-hint")?.textContent?.trim() ?? null),
        HINT,
        "the slide names the gesture while a directory it lists holds directories",
      );
      assert.deepEqual([...new Set(asked.map((open) => JSON.stringify(open)))], ["[]"], "with nothing opened the slide asks for the root's level alone");

      await doubleClick(ctx, first, DIR, []);
      await discs(first, level + 2, `${DIR} opened`);
      assert.deepEqual(asked.at(-1), [DIR], "the slide asks for the level of the directory it opened");
      await doubleClick(ctx, first, `${DIR}/alpha`, [DIR]);
      const opened = await discs(first, level + 4, `${DIR}/alpha opened`);
      assert.deepEqual(asked.at(-1), [DIR, `${DIR}/alpha`], "the slide asks for the levels of both opened directories");
      await ctx.shot("240-two-opened", first);

      const start2 = Date.now();
      let saved = null;
      for (;;) {
        saved = await savedDashboard(ctx, windowId);
        if ([DIR, `${DIR}/alpha`].every((dir) => (saved?.de ?? []).includes(dir))) break;
        if (Date.now() - start2 > SAVED_WITHIN_MS) {
          throw new Error(`the saved session did not hold the opened directories within ${SAVED_WITHIN_MS} ms: ${JSON.stringify(saved)}`);
        }
        await delay(200);
      }
      await untraceGraphDiscs(first);
      await first.close();

      const again = await open(windowUrl(ctx, windowId));
      const restored = await discs(again, level + 4, "the window opened again from its session");
      await ctx.shot("240-reopened", again);

      await doubleClick(ctx, again, DIR, [DIR, `${DIR}/alpha`]);
      const shut = await discs(again, level, `${DIR} closed`);
      assert.deepEqual(asked.at(-1), [], "with the fixture closed the slide asks for the root's level alone");

      // The fixture's disc where Details opens over it. Opening the fixture
      // draws alpha's level too, which stayed opened under it.
      const under = await panUnderDetails(again, (await discOf(ctx, again, DIR, [])).at);
      await ctx.shot("240-under-details", again);
      const detailsPress = await pressTwice(again, under, true);
      const start3 = Date.now();
      while (!asked.at(-1).includes(DIR)) {
        if (Date.now() - start3 > 10_000) {
          throw new Error(`a double-click on a directory under the place Details opens did not open it: the slide last asked for ${JSON.stringify(asked.at(-1))}`);
        }
        await delay(200);
      }
      assert.equal(await selectedName(again), DIR, "Details is open for the directory");
      await ctx.shot("240-opened-under-details", again);

      const allowed = [[], [DIR], [DIR, `${DIR}/alpha`]].map((open) => JSON.stringify(open));
      const strays = [...new Set(asked.map((open) => JSON.stringify(open)))].filter((open) => !allowed.includes(open));
      assert.deepEqual(strays, [], "no request names anything but the directories the check opened");
      await untraceGraphDiscs(again);
      assert.deepEqual(errors, []);
      return {
        level,
        closed: closed.count,
        opened: opened.count,
        saved: saved.de,
        restored: restored.count,
        shut: shut.count,
        underDetails: under,
        detailsPress,
        requests: asked.length,
      };
    } catch (error) {
      error.smokeDetails = { ...error.smokeDetails, requests: asked, pageErrors: errors };
      for (const [index, page] of pages.entries()) {
        if (!page.isClosed()) await ctx.shot(`240-failure-${index}`, page).catch(() => {});
      }
      throw error;
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      // The runner keeps one server and one workspace for every check: the
      // fixture and the saved window go with this one.
      rmSync(join(ctx.workspaceDir, DIR), { recursive: true, force: true });
      await request(ctx, `/api/session?w=${encodeURIComponent(windowId)}`, { method: "DELETE" }).catch(() => {});
    }
  },
};
