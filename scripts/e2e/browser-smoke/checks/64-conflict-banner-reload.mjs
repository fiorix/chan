// Conflict surfacing: a doc-attached editor whose live edits collide
// with an external same-line disk write must (1) keep both sides safe,
// (2) raise the conflict banner instead of going silently stale, and
// (3) adopt the LIVE disk content when the user picks "Reload from
// disk". Also pins the context-menu "Reload from disk" entry in the
// editor body menu.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "conflict-banner.md";
const STAMP = Date.now();
const LINE1 = `SMOKE-CONFLICT-BASE-${STAMP}`;
const THEIRS = `SMOKE-CONFLICT-THEIRS-${STAMP}`;

async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? (el.textContent ?? "") : null;
  });
}

export default {
  name: "conflict-banner-reload-from-disk",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { browser, serverUrl } = ctx;
    const page = await browser.newPage();
    try {
      await page.goto(`${serverUrl}&w=smoke-conflict-w-${STAMP}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.bringToFront();

      const windowId = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      if (!windowId) throw new Error("could not resolve the page's window id");
      // The pane is mounted; the server does not necessarily know this window
      // yet, and everything below addresses it by id.
      await ctx.waitWindowLive(windowId);
      const env = {
        ...process.env,
        CHAN_CONTROL_SOCKET: socket,
        CHAN_WINDOW_ID: windowId,
      };

      // 1. Seed a multi-line file and open it.
      writeFileSync(
        join(ctx.workspaceDir, FILE),
        `${LINE1}\n\nfiller one\n\nfiller two\n`,
      );
      await ctx.exec(ctx.chanBin, ["shell", "open", FILE], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 30_000,
      });
      await page.waitForFunction(
        (marker) => (document.querySelector(".cm-content")?.textContent ?? "").includes(marker),
        { timeout: 30_000 },
        LINE1,
      );
      await ctx.shot("opened", page);

      // 2. Dirty the live session by REPLACING line 1 (a prefix insert
      // would commute with the external line rewrite through the
      // scalar three-way merge -- correctly -- and never conflict),
      // then land an overlapping external write before the ~800ms
      // flush debounce: the classic agent-vs-editor collision.
      await page.click(".cm-content");
      await page.evaluate(() => {
        const el = document.querySelector(".cm-content");
        el?.dispatchEvent(new FocusEvent("focus"));
      });
      await page.keyboard.down("Control");
      await page.keyboard.press("Home");
      await page.keyboard.up("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("End");
      await page.keyboard.up("Shift");
      // One CDP roundtrip, not per-key events: the whole dirty-then-
      // collide sequence must land inside the authority's ~800ms flush
      // debounce even on a slow runner.
      const cdp = await page.createCDPSession();
      await cdp.send("Input.insertText", { text: "MINE-LOCAL-REWRITE" });
      await cdp.detach();
      const preCollision = readFileSync(join(ctx.workspaceDir, FILE), "utf8");
      if (!preCollision.includes(LINE1)) {
        throw new Error(
          "harness raced the flush debounce: the local edit reached disk before the external write; re-run",
        );
      }
      writeFileSync(
        join(ctx.workspaceDir, FILE),
        `${THEIRS}\n\nfiller one\n\nfiller two\n`,
      );

      // 3. The conflict banner appears; the editor keeps the local side.
      try {
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll(".recovery-banner")].some((b) =>
              (b.textContent ?? "").includes("conflicts with your edits"),
            ),
          { timeout: 15_000 },
        );
      } catch (e) {
        const text = await editorText(page);
        const banners = await page.evaluate(() =>
          [...document.querySelectorAll(".recovery-banner")].map((b) => b.textContent?.trim()),
        );
        const diskNow = readFileSync(join(ctx.workspaceDir, FILE), "utf8");
        throw new Error(
          `banner never appeared; editor=${JSON.stringify(text?.slice(0, 120))} ` +
            `mine=${text?.includes("MINE-LOCAL-REWRITE")} theirs=${text?.includes("SMOKE-CONFLICT-THEIRS")} ` +
            `disk-theirs=${diskNow.includes("SMOKE-CONFLICT-THEIRS")} banners=${JSON.stringify(banners)}`,
        );
      }
      await ctx.shot("banner", page);
      const during = await editorText(page);
      if (!during?.includes("MINE-LOCAL-REWRITE")) {
        throw new Error("local edit vanished while the conflict was pending");
      }
      const diskDuring = readFileSync(join(ctx.workspaceDir, FILE), "utf8");
      if (!diskDuring.includes(THEIRS)) {
        throw new Error("external write was clobbered while the conflict was pending");
      }

      // 4. The editor body context menu carries "Reload from disk".
      const editorBox = await page.$(".cm-content");
      const box = await editorBox.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + 40, { button: "right" });
      await page.waitForSelector(".tab-menu-bubble", { timeout: 5_000 });
      const hasMenuRow = await page.evaluate(() =>
        [...document.querySelectorAll(".tab-menu-bubble .mbtn-label")].some(
          (l) => l.textContent?.trim() === "Reload from disk",
        ),
      );
      await ctx.shot("menu", page);
      if (!hasMenuRow) {
        throw new Error("editor context menu is missing the Reload from disk row");
      }
      await page.keyboard.press("Escape");

      // 5. Resolve via the banner: Reload from disk, confirm the
      // destructive prompt, and converge on the live disk content.
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".recovery-banner button")].find(
          (b) => b.textContent?.trim() === "Reload from disk",
        );
        btn?.click();
      });
      await page.waitForSelector(".modal .actions .ok", { timeout: 5_000 });
      await ctx.shot("confirm", page);
      await page.click(".modal .actions .ok");

      await page.waitForFunction(
        (marker) => (document.querySelector(".cm-content")?.textContent ?? "").includes(marker),
        { timeout: 15_000 },
        THEIRS,
      );
      const after = await editorText(page);
      if (after?.includes("MINE-LOCAL-REWRITE")) {
        throw new Error("reload kept the discarded local side");
      }
      const bannerGone = await page.evaluate(
        () =>
          ![...document.querySelectorAll(".recovery-banner")].some((b) =>
            (b.textContent ?? "").includes("conflicts with your edits"),
          ),
      );
      if (!bannerGone) throw new Error("conflict banner did not clear after reload");
      await ctx.shot("resolved", page);
    } finally {
      await page.close();
    }
  },
};
