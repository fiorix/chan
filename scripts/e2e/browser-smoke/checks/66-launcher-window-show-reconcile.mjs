// Browser Show changes visibility on connected records without acquiring a
// window. Reconciliation observes live and closed local handles without
// opening a page, then removes a record after its last holder leaves.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchWindows, findWindowRow, goto, holderTagOf, killChild, mask, pageAddress,
  poll, sameTags, spawnDevserver, tenantUrl, wait,
} from "../lib/launcher-devserver.mjs";

async function clickRowButton(launcher, rowName, label) {
  const button = await poll(`${rowName}: ${label} button`, async () => {
    const row = await findWindowRow(launcher, rowName);
    return row.$(`button[aria-label="${label}"]`);
  });
  if (await button.evaluate((element) => element.disabled)) {
    throw new Error(`${rowName}: ${label} button disabled`);
  }
  const box = await button.boundingBox();
  if (!box) throw new Error(`${rowName}: ${label} button has no box`);
  await launcher.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function withoutNavigation(page, label, action) {
  let changed = null;
  let sawNavigation;
  const navigated = new Promise((resolve) => { sawNavigation = resolve; });
  const onNavigation = (frame) => {
    if (frame !== page.mainFrame()) return;
    changed = mask(frame.url());
    sawNavigation();
  };
  page.on("framenavigated", onNavigation);
  try {
    await action();
    await Promise.race([navigated, wait(2_000)]);
    if (changed) throw new Error(`${label}: Show navigated a connected record's page: ${changed}`);
  } finally {
    page.off("framenavigated", onNavigation);
  }
}

export default {
  name: "launcher-window-show-reconcile",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    const chanHome = mkdtempSync(join(tmpdir(), "chan-launcher-show-"));
    const devserver = spawnDevserver(ctx.chanBin, chanHome);
    let launcher = null;
    let popup = null;
    let twin = null;
    let passed = false;
    try {
      const launchUrl = await devserver.url;
      const parsed = new URL(launchUrl);
      const origin = parsed.origin;
      const token = parsed.searchParams.get("t");
      if (!token) throw new Error("launcher URL has no management token");
      launcher = await ctx.browser.newPage();
      let popups = 0;
      launcher.on("popup", () => { popups += 1; });
      await goto(launcher, launchUrl);
      await launcher.waitForSelector('button[aria-label="New local terminal"]', { timeout: 30_000 });
      const popupPromise = new Promise((resolve) => launcher.once("popup", resolve));
      await launcher.click('button[aria-label="New local terminal"]');
      popup = await Promise.race([
        popupPromise,
        wait(30_000).then(() => { throw new Error("New terminal opened no popup within 30s"); }),
      ]);
      await popup.waitForFunction(() => new URL(location.href).searchParams.has("h"), { timeout: 30_000 });
      const opened = new URL(popup.url());
      const tag = holderTagOf(opened.toString());
      if (!tag || !/^[0-9a-f]{32}$/.test(tag)) throw new Error("popup has no 32-hex holder tag");
      const windowId = opened.searchParams.get("w");
      if (!windowId || opened.searchParams.get("kind") !== "terminal") {
        throw new Error("popup lacks its terminal window id");
      }
      await popup.waitForSelector(".pane", { timeout: 30_000 });
      const record = await poll("new window holder", async () => {
        const found = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return found?.connected && sameTags(found.holders, [tag]) ? found : null;
      });
      const rowName = `Terminal Window ${record.ordinal}${record.label ? ` [${record.label.trim()}]` : ""}`;
      const originalUrl = popup.url();
      const originalAddress = pageAddress(originalUrl);
      await popup.evaluate(() => { window.__chanSmokeMarker = "kept"; });
      const readRecord = async () => (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
      const assertMarker = async (label) => {
        const marker = await popup.evaluate(() => window.__chanSmokeMarker);
        if (marker !== "kept" || pageAddress(popup.url()) !== originalAddress) {
          throw new Error(`${label}: held page changed: marker=${marker} url=${mask(popup.url())}`);
        }
      };
      const assertNoPopup = () => {
        if (popups !== 1) throw new Error(`launcher opened ${popups} pages; expected its original popup only`);
      };

      // A: Hide and Show keep the connected holder and its page.
      await withoutNavigation(popup, "held Show", async () => {
        await clickRowButton(launcher, rowName, "Hide window");
        await poll("hidden record", async () => (await readRecord())?.hidden === true);
        await clickRowButton(launcher, rowName, "Show window");
        await poll("shown record", async () => {
          const current = await readRecord();
          if (current?.hidden) throw new Error(`still hidden; connected=${current.connected}`);
          return current && current.hidden !== true;
        });
      });
      await assertMarker("held Show");
      if (!sameTags((await readRecord())?.holders, [tag])) {
        throw new Error("held Show changed the holder list");
      }
      assertNoPopup();
      const hiddenOverlayAfterShow = !!(await popup.$(
        '[role="alertdialog"][aria-label="hidden by the session leader"]',
      ));

      // B: A second holder leaves the launcher's live handle settled.
      twin = await ctx.browser.newPage();
      await goto(twin, tenantUrl(origin, record, "smoke-twin"));
      await poll("two holder tags", async () => {
        const current = await readRecord();
        return current?.connected && sameTags(current.holders, [tag, "smoke-twin"]);
      });
      const liveRow = await findWindowRow(launcher, rowName);
      if (!(await liveRow.$('button[aria-label="Open window"]')) ||
          await liveRow.$('button[aria-label="Open window"].attention')) {
        throw new Error("live handle gained Open attention after holder change");
      }
      await assertMarker("second holder");
      assertNoPopup();

      // C: A connected record held elsewhere does not make Show repair a dead page.
      const dead = new URL(`/${record.prefix.replace(/^\/+|\/+$/g, "")}/favicon.ico`, origin);
      dead.searchParams.set("h", "smoke-dead");
      await goto(popup, dead.toString());
      await poll("twin-only holder", async () => sameTags((await readRecord())?.holders, ["smoke-twin"]));
      const deadAddress = pageAddress(popup.url());
      await withoutNavigation(popup, "twin-held Show", async () => {
        await clickRowButton(launcher, rowName, "Hide window");
        await poll("twin-held hidden record", async () => (await readRecord())?.hidden === true);
        await clickRowButton(launcher, rowName, "Show window");
        await poll("twin-held shown record", async () => {
          const current = await readRecord();
          if (current?.hidden) throw new Error(`still hidden; connected=${current.connected}`);
          return current && current.hidden !== true;
        });
      });
      if (pageAddress(popup.url()) !== deadAddress) {
        throw new Error("twin-held Show took back the dead page");
      }
      assertNoPopup();
      await goto(popup, originalUrl);
      await poll("restored two holders", async () => sameTags((await readRecord())?.holders, [tag, "smoke-twin"]));

      // D: A closed local handle stays while a peer holds the record.
      await popup.close();
      popup = null;
      await poll("twin holds closed handle", async () => sameTags((await readRecord())?.holders, ["smoke-twin"]));
      const kept = await readRecord();
      if (!kept?.connected) throw new Error("record dropped while another holder keeps it connected");
      const keptRow = await findWindowRow(launcher, rowName);
      const attention = await keptRow.$('button[aria-label="Open window (not open here)"].attention');
      if (!attention) throw new Error("closed local handle lacks Open attention");
      assertNoPopup();

      // E: The last socket leaves and the record and row disappear.
      await twin.close();
      twin = null;
      await poll("record after last holder", async () => !(await readRecord()));
      await poll("row after last holder", async () => {
        const names = await launcher.$$eval("section.machine .term-list .row .row-name", (nodes) =>
          nodes.map((node) => node.textContent?.trim()));
        return !names.includes(rowName);
      });
      assertNoPopup();
      passed = true;
      return { windowId, tag, rowName, hiddenOverlayAfterShow, popups };
    } catch (error) {
      if (launcher) await ctx.shot("show-reconcile-launcher-failure", launcher).catch(() => {});
      throw error;
    } finally {
      if (twin) await twin.close().catch(() => {});
      if (popup) await popup.close().catch(() => {});
      if (launcher) await launcher.close().catch(() => {});
      await killChild(devserver.child);
      if (!passed) cpSync(chanHome, join(ctx.outDir, "launcher-show-home"), {
        recursive: true,
        filter: (source) => source !== join(chanHome, "devserver", "config.json"),
      });
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
