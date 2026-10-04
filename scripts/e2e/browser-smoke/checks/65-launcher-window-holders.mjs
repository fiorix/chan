// A launcher-opened window keeps this page load's holder tag through navigation.
// The library lists that tag for its live socket, and Open uses the tag on the
// named window's current page to keep or repair it. This drives one browser's
// named popup; it cannot simulate a browser's Duplicate Tab command, another
// browser, an unreadable foreign origin, or the desktop window host.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, holderTagOf, killChild, mask, openHeldRow, openRow, pageAddress, poll, sameTags, spawnDevserver, tenantUrl, wait } from "../lib/launcher-devserver.mjs";

export default {
  name: "launcher-window-holders",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    const chanHome = mkdtempSync(join(tmpdir(), "chan-launcher-holders-"));
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
      await goto(launcher, launchUrl);
      await launcher.waitForSelector('button[aria-label="New local terminal"]', { timeout: 30_000 });

      const popupPromise = new Promise((resolve) => launcher.once("popup", resolve));
      await launcher.click('button[aria-label="New local terminal"]');
      popup = await Promise.race([
        popupPromise,
        wait(30_000).then(() => { throw new Error("New terminal opened no popup within 30s"); }),
      ]);
      try {
        await popup.waitForFunction(() => new URL(location.href).searchParams.has("h"), { timeout: 30_000 });
      } catch {
        throw new Error("the popup's URL names no h within 30s");
      }
      const opened = new URL(popup.url());
      const tag = holderTagOf(opened.toString());
      if (!tag || !/^[0-9a-f]{32}$/.test(tag)) throw new Error("the popup's URL has no 32-hex holder tag");
      const windowId = opened.searchParams.get("w");
      if (!windowId || opened.searchParams.get("kind") !== "terminal" || !opened.searchParams.get("lib")) {
        throw new Error("the popup's URL lacks w, kind=terminal or lib");
      }
      if ([...opened.searchParams.keys()].at(-1) !== "h") throw new Error("h is not the popup URL's last parameter");
      await popup.waitForSelector(".pane", { timeout: 30_000 });

      const held = await poll("new window's holder", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, [tag]) ? record : null;
      });
      const rowName = `Terminal Window ${held.ordinal}${held.label ? ` [${held.label.trim()}]` : ""}`;
      const originalUrl = popup.url();
      const originalAddress = pageAddress(originalUrl);
      await ctx.shot("holder-listed", popup);
      await ctx.shot("launcher-row", launcher);

      await popup.evaluate(() => { window.__chanSmokeMarker = "kept"; });
      await openHeldRow(launcher, popup, rowName, originalAddress, "single holder");
      const afterHeld = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
      if (!sameTags(afterHeld?.holders, [tag])) throw new Error("Open changed the held socket list");
      await ctx.shot("held-open", popup);

      twin = await ctx.browser.newPage();
      await goto(twin, tenantUrl(origin, held, "smoke-twin"));
      const withTwin = await poll("two live holder tags", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, [tag, "smoke-twin"]) ? record : null;
      });
      await openHeldRow(launcher, popup, rowName, originalAddress, "second holder");
      await ctx.shot("twin-held-open", popup);

      const dead = new URL(`/${held.prefix.replace(/^\/+|\/+$/g, "")}/favicon.ico`, origin);
      dead.searchParams.set("h", "smoke-dead");
      await goto(popup, dead.toString());
      const afterDead = await poll("only the twin's live tag", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, ["smoke-twin"]) ? record : null;
      });
      await ctx.shot("dead-page", popup);
      await openRow(launcher, rowName);
      const repaired = await poll("repaired popup URL", async () => {
        const url = new URL(popup.url());
        return url.pathname === new URL(tenantUrl(origin, held, tag)).pathname &&
          url.searchParams.get("w") === windowId && holderTagOf(url.toString()) === tag ? url : null;
      });
      const afterRepair = await poll("repaired socket holder", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, [tag, "smoke-twin"]) ? record : null;
      });
      await ctx.shot("repaired-page", popup);
      const details = {
        windowId,
        tag,
        rowName,
        heldHolders: afterHeld.holders,
        twinHolders: withTwin.holders,
        deadHolders: afterDead.holders,
        repairedHolders: afterRepair.holders,
        repairedUrl: mask(repaired.toString()),
        launcherUrl: mask(launchUrl),
      };
      passed = true;
      return details;
    } finally {
      if (twin) await twin.close().catch(() => {});
      if (popup) await popup.close().catch(() => {});
      if (launcher) await launcher.close().catch(() => {});
      await killChild(devserver.child);
      if (!passed) cpSync(chanHome, join(ctx.outDir, "launcher-home"), {
        recursive: true,
        filter: (source) => source !== join(chanHome, "devserver", "config.json"),
      });
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
