// The Computers card scrolls under the wheel and keeps its last row clear of
// its border. A machine card holding more workspace rows than the deck's
// height shows scrolls inside the card: wheel input over its list moves the
// list without turning the deck, and at the end of the range the last row
// stops its end padding above the card's inner bottom; keyboard selection of
// the last row shows it whole with that same margin.
//
// The harness's `chan serve` has no launcher at `/`, so this spawns its own
// isolated `chan devserver run` over a fresh CHAN_HOME seeded with twelve
// workspaces through `chan workspace add`. Only the desktop surface deals the
// deck (a devserver page lists its cards flat), so the launcher document is
// answered with its surface meta rewritten to `desktop`, the surface
// chan-desktop's own devserver serves.
//
// Skips when the launcher bundle is missing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showCarouselCard } from "../lib/carousel.mjs";
import { goto, killChild, mask, spawnDevserver, wait } from "../lib/launcher-devserver.mjs";

const ROWS = 12;
// The one control that names This machine on a deck with no devserver.
const THIS_MACHINE = 'button[aria-label="New local terminal"]';
const SURFACE_META = /<meta name="chan-launcher-surface" content="devserver">/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// The front card's scroller, where its last row ends against its inner bottom,
// and a pointer position over its list.
function measure() {
  const slot = document.querySelector(".slot.active");
  const card = slot?.querySelector("section.card.machine");
  if (!card) return { error: "no machine card in front" };
  const rows = [...card.querySelectorAll("[data-deck-row]")];
  const last = rows[rows.length - 1].getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const style = getComputedStyle(card);
  return {
    active: slot.getAttribute("aria-label"),
    rows: rows.length,
    scrollTop: card.scrollTop,
    range: card.scrollHeight - card.clientHeight,
    padding: parseFloat(style.paddingBottom),
    lastRowBottom: last.bottom,
    innerBottom: box.bottom - parseFloat(style.borderBottomWidth),
    point: { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 },
  };
}

function clearance(m) {
  return m.innerBottom - m.lastRowBottom;
}

function assertLastRowClear(m, what) {
  const c = clearance(m);
  check(
    c + 0.5 >= m.padding,
    `${what}: the last row ends ${Math.abs(c).toFixed(2)}px ${c < 0 ? "below" : "above"} the card's inner bottom, ` +
      `not the scroller's ${m.padding}px end padding above it (scrollTop ${m.scrollTop} of ${m.range})`,
  );
}

export default {
  name: "launcher-card-scroll",
  async run(ctx) {
    const distRoot = join(ctx.repoRoot, "web-launcher", "dist");
    if (!existsSync(join(distRoot, "index.html"))) {
      ctx.skip(
        "launcher dist missing; the devserver has no launcher SPA to serve; run the web build before SMOKE_SKIP_BUILD=1",
      );
    }
    const root = mkdtempSync(join(tmpdir(), "chan-card-scroll-"));
    const chanHome = join(root, "home");
    mkdirSync(chanHome);
    const env = { ...process.env, CHAN_HOME: chanHome, CHAN_NO_DEVSERVER_HANDOFF: "1" };
    for (let i = 1; i <= ROWS; i += 1) {
      const dir = join(root, `ws-${String(i).padStart(2, "0")}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "README.md"), `# ws-${i}\n`);
      execFileSync(ctx.chanBin, ["workspace", "add", dir], { env, stdio: "pipe" });
    }
    const devserver = spawnDevserver(ctx.chanBin, chanHome, ["--no-tunnel"]);
    let page = null;
    try {
      const url = await devserver.url;
      page = await ctx.browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", async (request) => {
        if (request.resourceType() !== "document") return request.continue();
        try {
          const response = await fetch(request.url(), { headers: request.headers() });
          const body = (await response.text()).replace(
            SURFACE_META,
            '<meta name="chan-launcher-surface" content="desktop">',
          );
          await request.respond({ status: response.status, contentType: "text/html; charset=utf-8", body });
        } catch (error) {
          await request.abort().catch(() => {});
          ctx.mark("document-rewrite-failed", { error: mask(error instanceof Error ? error.message : String(error)) });
        }
      });
      await goto(page, url);
      await showCarouselCard(page, THIS_MACHINE);
      await page.waitForFunction(
        (n) => document.querySelectorAll(".slot.active section.card.machine .ws-head").length >= n,
        { timeout: 30_000 },
        ROWS,
      );
      const start = await page.evaluate(measure);
      check(!start.error, start.error);
      check(start.range > 0, `the card must overflow its slot to scroll; its range is ${start.range}px`);
      check(clearance(start) < 0, `the last row must start below the card's edge; it ends ${clearance(start).toFixed(2)}px above it`);

      // Wheel over the list until the range ends. The pointer stays put; only
      // the list under it may move.
      await page.mouse.move(start.point.x, start.point.y);
      let wheeled = start;
      for (let notch = 0; notch < 40; notch += 1) {
        await page.mouse.wheel({ deltaY: 300 });
        await wait(80);
        const next = await page.evaluate(measure);
        const settled = notch > 0 && next.scrollTop === wheeled.scrollTop;
        wheeled = next;
        if (settled) break;
      }
      check(wheeled.active === start.active, `the wheel turned the deck: ${start.active} -> ${wheeled.active}`);
      check(wheeled.scrollTop > 0, `the wheel did not scroll the card (scrollTop ${wheeled.scrollTop} of ${wheeled.range})`);
      check(
        wheeled.scrollTop >= wheeled.range - 1,
        `the wheel stopped at scrollTop ${wheeled.scrollTop} of ${wheeled.range}`,
      );
      assertLastRowClear(wheeled, "after wheeling to the end");
      await ctx.shot("wheel-end", page);

      // Keyboard selection down to the last row from the top of the range.
      await page.evaluate(() => {
        document.querySelector(".slot.active section.card.machine").scrollTop = 0;
        document.querySelector(".slot.active").focus({ preventScroll: true });
      });
      for (let i = 0; i < start.rows + 1; i += 1) {
        await page.keyboard.press("ArrowDown");
        await wait(30);
      }
      await wait(200);
      const onLastRow = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".slot.active section.card.machine [data-deck-row]")];
        return document.activeElement === rows[rows.length - 1];
      });
      check(onLastRow, "ArrowDown did not reach the last row");
      const keyed = await page.evaluate(measure);
      check(keyed.active === start.active, `the keys turned the deck: ${start.active} -> ${keyed.active}`);
      assertLastRowClear(keyed, "after selecting the last row with the keyboard");
      await ctx.shot("keys-end", page);

      return {
        url: mask(url),
        rows: start.rows,
        range: start.range,
        padding: start.padding,
        wheel: { scrollTop: wheeled.scrollTop, clearance: +clearance(wheeled).toFixed(2) },
        keys: { scrollTop: keyed.scrollTop, clearance: +clearance(keyed).toFixed(2) },
      };
    } finally {
      if (page) await page.close().catch(() => {});
      await killChild(devserver.child);
      rmSync(root, { recursive: true, force: true });
    }
  },
};
