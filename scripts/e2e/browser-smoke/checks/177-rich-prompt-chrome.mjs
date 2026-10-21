// The Rich Prompt's chrome on a phone. At 390 by 844 with a touch screen
// emulated, the card opens from the terminal menu; its close button lies on
// the screen and a tap hides the card, whose draft is there when it opens
// again; the menu's Show Style Toolbar row floats the toolbar over the text
// area with the first row below it; the source toggle swaps the card to source
// and back with no scroller or paint of the source editor's own; and a bold
// tapped on the toolbar reaches the text the card sends. The card's first
// message starts `cat` into a workspace file, which is how the check reads
// what the card sends; either terminal backend serves.

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const WINDOW = "rich-prompt-chrome-177";
const SENT = "rp177-sent.txt";
const CARD = ".rich-prompt";
const TOOLBAR = `${CARD} [role="toolbar"]`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rectOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

/// Open the terminal's menu, as a long press does, and tap the row named.
async function tapMenuRow(page, label) {
  await page.$eval(".terminal-tab.active", (el) => el.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 40, clientY: 160,
  })));
  await page.waitForSelector("button.mbtn", { visible: true, timeout: 10_000 });
  const row = (await page.evaluateHandle((label) => [...document.querySelectorAll("button.mbtn")]
    .find((b) => b.querySelector(".mbtn-label")?.textContent?.trim() === label) ?? null, label)).asElement();
  assert.ok(row, `the terminal menu has a "${label}" row`);
  await row.tap();
  await page.waitForFunction(() => !document.querySelector("button.mbtn"), { timeout: 10_000 });
}

/// Tap a control, after checking that a tap at its centre lands on it and
/// not on whatever overlaps it.
async function tapControl(page, selector) {
  const hit = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { onIt: !!top && el.contains(top), top: top?.outerHTML?.slice(0, 120) ?? null };
  });
  assert.ok(hit.onIt, `a tap on ${selector} lands on it, not on ${hit.top}`);
  await page.tap(selector);
}

/// Replace the card's text with `text`, typed as a person types it.
async function typeInCard(page, text) {
  await page.tap(`${CARD} .cm-content`);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
}

function cardText(page) {
  return page.$eval(`${CARD} .cm-content`, (el) => el.textContent ?? "");
}

export default {
  name: "rich-prompt-chrome",
  async run(ctx) {
    const sentPath = join(ctx.workspaceDir, SENT);
    rmSync(sentPath, { force: true });
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", WINDOW);
    const details = { pageErrors: [] };
    page.on("pageerror", (error) => details.pageErrors.push(String(error)));
    let failed = false;
    try {
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.evaluate(() => window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.terminal.toggle" } }),
      ));
      await page.waitForSelector(".terminal-tab.active .xterm-screen, .terminal-tab.active .terminal-host canvas",
        { timeout: 30_000 });
      // A live shell before the card sends to it.
      await sleep(2500);

      // The card opens from the terminal menu; its first message starts `cat`.
      await tapMenuRow(page, "Show Rich Prompt");
      await page.waitForSelector(`${CARD} .cm-content`, { visible: true, timeout: 15_000 });
      await typeInCard(page, `cat > ${sentPath}`);
      await tapControl(page, `${CARD} .rp-primary`);
      await page.waitForFunction((card) => (document.querySelector(`${card} .cm-content`)?.textContent ?? "x").trim() === "",
        { timeout: 15_000 }, CARD);

      // Its close button lies on the screen.
      const close = await page.$(`${CARD} button[aria-label="Close Rich Prompt"]`);
      assert.ok(close, "the card has a close button");
      details.close = await rectOf(page, `${CARD} button[aria-label="Close Rich Prompt"]`);
      assert.ok(details.close.left >= 0 && details.close.right <= 390 && details.close.top >= 0 &&
        details.close.bottom <= 844 && details.close.width > 0, `the close button lies on the screen: ${JSON.stringify(details.close)}`);

      // A tap hides the card; the draft is there when it opens again.
      await typeInCard(page, "kept draft");
      await tapControl(page, `${CARD} button[aria-label="Close Rich Prompt"]`);
      await page.waitForFunction((card) => !document.querySelector(card), { timeout: 10_000 }, CARD);
      await tapMenuRow(page, "Show Rich Prompt");
      await page.waitForSelector(`${CARD} .cm-content`, { visible: true, timeout: 15_000 });
      await page.waitForFunction((card) => document.querySelector(`${card} .cm-content`)?.textContent?.includes("kept draft"),
        { timeout: 10_000 }, CARD);

      // The toolbar row floats the toolbar over the text area, the first row
      // below it.
      await tapMenuRow(page, "Show Style Toolbar");
      await page.waitForSelector(TOOLBAR, { visible: true, timeout: 10_000 });
      // The first row moves down with a short padding transition; read it
      // once it has settled.
      const settled = await page.waitForFunction((card, toolbar) => {
        const line = document.querySelector(`${card} .cm-line`)?.getBoundingClientRect();
        const bar = document.querySelector(toolbar)?.getBoundingClientRect();
        return line && bar && line.top >= bar.bottom;
      }, { timeout: 5_000 }, CARD, TOOLBAR).then(() => true, () => false);
      details.toolbar = await rectOf(page, TOOLBAR);
      details.firstLine = await rectOf(page, `${CARD} .cm-line`);
      details.pad = await page.evaluate((card) => ({
        token: getComputedStyle(document.querySelector(`${card} .rp-editor`)).getPropertyValue("--editor-top-pad"),
        content: getComputedStyle(document.querySelector(`${card} .cm-content`)).paddingTop,
      }), CARD);
      assert.ok(settled && details.firstLine.top >= details.toolbar.bottom,
        `the first row (top ${details.firstLine.top}) sits below the toolbar (bottom ${details.toolbar.bottom}); ${JSON.stringify(details.pad)}`);

      // A bold tapped on the toolbar: the pill expands the row, and the
      // control lies inside the card.
      await typeInCard(page, "word");
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await tapControl(page, `${TOOLBAR} button.pill`);
      await page.waitForSelector(`${TOOLBAR} button[aria-label="bold"]`, { visible: true, timeout: 5_000 });
      const card = await rectOf(page, CARD);
      details.bold = await rectOf(page, `${TOOLBAR} button[aria-label="bold"]`);
      assert.ok(details.bold.left >= card.left && details.bold.right <= card.right &&
        details.bold.top >= card.top && details.bold.bottom <= card.bottom,
        `the bold control lies inside the card: ${JSON.stringify({ bold: details.bold, card })}`);
      await tapControl(page, `${TOOLBAR} button[aria-label="bold"]`);

      // The source toggle: the card shows the draft as source, with no
      // scroller or paint of the source editor's own, and back.
      details.renderedHeight = (await rectOf(page, CARD)).height;
      await tapControl(page, `${TOOLBAR} button[aria-label="show source"]`);
      await page.waitForSelector(`${CARD} .md-source .cm-content`, { visible: true, timeout: 10_000 });
      details.source = await page.$eval(`${CARD} .md-source`, (el) => {
        const style = getComputedStyle(el);
        return {
          overflow: style.overflowY,
          background: style.backgroundColor,
          text: el.querySelector(".cm-content")?.textContent ?? "",
          height: el.closest(".rich-prompt").getBoundingClientRect().height,
          line: el.querySelector(".cm-line")?.getBoundingClientRect().height ?? 0,
          innerScroll: (() => {
            const scroller = el.querySelector(".cm-scroller");
            return scroller ? scroller.scrollHeight - scroller.clientHeight : null;
          })(),
        };
      });
      assert.equal(details.source.text, "**word**", "the source shows the bold the toolbar made");
      assert.equal(details.source.overflow, "visible", "the source editor holds no scroller of its own");
      assert.equal(details.source.background, "rgba(0, 0, 0, 0)", "the source editor paints no background of its own");
      assert.ok(details.source.innerScroll !== null && details.source.innerScroll <= 1,
        `the source editor's scroller has nothing to scroll (${details.source.innerScroll})`);
      // The two editors set their lines in different faces, so the card's
      // height may differ by less than one line, never by a second box.
      assert.ok(Math.abs(details.source.height - details.renderedHeight) < details.source.line,
        `the card keeps its height in source within a line (${details.source.height}, rendered ${details.renderedHeight}, line ${details.source.line})`);
      await tapControl(page, `${TOOLBAR} button[aria-label="show rendered"]`);
      await page.waitForSelector(`${CARD} .md-wysiwyg-cm6 .cm-content`, { visible: true, timeout: 10_000 });

      // The card sends what it holds: the terminal's `cat` writes it to the file.
      await tapControl(page, `${CARD} .rp-primary`);
      const deadline = Date.now() + 15_000;
      for (;;) {
        details.sent = (() => {
          try { return readFileSync(sentPath, "utf8"); } catch { return ""; }
        })();
        if (details.sent.includes("**word**")) break;
        if (Date.now() > deadline) assert.fail(`the sent text reads ${JSON.stringify(details.sent)}, expected **word**`);
        await sleep(250);
      }
      details.cardAfterSend = await cardText(page).catch(() => null);
      return details;
    } catch (error) {
      failed = true;
      await ctx.shot("177-failure", page).catch(() => {});
      if (details.pageErrors.length) error.message += `; page errors: ${details.pageErrors.join(" | ")}`;
      throw error;
    } finally {
      // Close the terminal, which ends `cat`, and its card, and leave no file
      // behind.
      // A terminal left open fails the check, unless the check already failed.
      try {
        await page.evaluate(() => window.dispatchEvent(
          new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }),
        ));
        const confirmOk = await page.waitForSelector('[role="dialog"] button.ok', { timeout: 5_000 }).catch(() => null);
        if (confirmOk) await confirmOk.click();
        await page.waitForFunction(() => !document.querySelector(".terminal-tab"), { timeout: 10_000 });
      } catch (error) {
        if (!failed) throw error;
        console.log(`[smoke]   the terminal was not closed: ${error.message}`);
      } finally {
        rmSync(sentPath, { force: true });
        await page.close().catch(() => {});
      }
    }
  },
};
