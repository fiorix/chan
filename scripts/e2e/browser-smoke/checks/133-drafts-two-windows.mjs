// Two windows on one workspace follow each other's drafts. Window A makes,
// discards and promotes; window B, which made none of them, shows what the
// server says:
//
//   - a draft made in A appears in B's Drafts group;
//   - B has that draft open in a tab; A discards it, and B's tab says the
//     draft no longer exists, with Close alone;
//   - B has a second draft open; A saves it to the workspace, and B's tab
//     follows it to the file it became.
//
// B is driven only to open what A made and to read what it shows.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  assertNothingMarkedShown,
  closeDraft,
  draftsStore,
  groupNames,
  newDraft,
  openTree,
  saveDraftToWorkspace,
  waitActiveTab,
  waitFor,
  waitGroup,
} from "../lib/drafts.mjs";

async function typeAtEnd(page, text) {
  await page.bringToFront();
  await page.click(".editor-tab.active .cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
}

/// Open the draft `name` in `page` from its row in the Drafts group.
async function openFromGroup(page, name, text) {
  await page.bringToFront();
  await waitFor(`${name} in the other window's Drafts group`, 20_000, async () => (await groupNames(page)).includes(name));
  await page.evaluate((wanted) => {
    const row = [...document.querySelectorAll(".drafts-group .draft-row")].find(
      (el) => el.querySelector(".draft-name")?.textContent === wanted,
    );
    row?.click();
  }, name);
  await page
    .waitForFunction(
      (body) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(body),
      { timeout: 20_000 },
      text,
    )
    .catch(async () => {
      const shown = await page.evaluate(() => ({
        tab: document.querySelector(".tabs .tab.active")?.getAttribute("title") ?? null,
        text: (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").slice(0, 120),
      }));
      throw new Error(`the other window did not show ${name}'s text after opening it: ${JSON.stringify(shown)}`);
    });
}

/// Wait until what was typed in a draft has been saved to the store: the
/// other window reads the draft from the server when it opens it.
async function savedInStore(ctx, draft, text) {
  const file = join(draftsStore(ctx, draft.name), draft.path);
  await waitFor(`${draft.name}'s text in the store`, 20_000, () => readFileSync(file, "utf8").includes(text));
}

export default {
  name: "drafts-two-windows",
  async run(ctx) {
    const A = ctx.page;
    const stamp = Date.now().toString(36);
    const dir = `smoke-drafts-${stamp}`;
    const target = `${dir}/shared.md`;
    const bId = `drafts-peer-${stamp}`;
    let B;
    try {
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", bId);
      B = await ctx.browser.newPage();
      await B.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await B.waitForSelector(".pane", { timeout: 30_000 });
      await ctx.waitWindowLive(bId);

      // A makes a draft; B's group shows it and B opens it.
      const gone = await newDraft(ctx, A);
      await typeAtEnd(A, `\n\nto discard ${stamp}\n`);
      await savedInStore(ctx, gone, `to discard ${stamp}`);
      await openTree(B);
      await openFromGroup(B, gone.name, `to discard ${stamp}`);

      // A discards it; B's tab says so.
      await closeDraft(A, "discard");
      await B.bringToFront();
      await B.waitForFunction(
        () => document.querySelector(".editor-tab.active .missing-title")?.textContent?.trim() === "This draft no longer exists",
        { timeout: 20_000 },
      ).catch(() => {
        throw new Error("the other window's tab did not say the discarded draft no longer exists");
      });
      const offered = await B.evaluate(() =>
        [...document.querySelectorAll(".editor-tab.active .missing-actions button")].map((b) => b.textContent.trim()),
      );
      if (JSON.stringify(offered) !== JSON.stringify(["Close"])) {
        throw new Error(`a gone draft's tab offers: ${offered.join(", ")}`);
      }
      await assertNothingMarkedShown(B, [gone.id], "B, on the gone draft");
      await ctx.shot("b-gone", B);
      await B.click(".editor-tab.active .missing-actions button");
      await waitGroup(B, gone.name, false);

      // A makes a second draft; B opens it; A saves it to the workspace.
      const kept = await newDraft(ctx, A);
      await typeAtEnd(A, `\n\nto keep ${stamp}\n`);
      await savedInStore(ctx, kept, `to keep ${stamp}`);
      await openFromGroup(B, kept.name, `to keep ${stamp}`);
      mkdirSync(join(ctx.workspaceDir, dir));
      await saveDraftToWorkspace(A, target);
      await waitFor("the promoted file in the workspace", 20_000, () => existsSync(join(ctx.workspaceDir, target)));
      await B.bringToFront();
      await waitActiveTab(B, target, "B's tab following the promoted file");
      await B.waitForFunction(
        (text) =>
          (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text) &&
          !document.querySelector(".editor-tab.active .missing-title"),
        { timeout: 20_000 },
        `to keep ${stamp}`,
      );
      await waitGroup(B, kept.name, false);
      await assertNothingMarkedShown(B, [gone.id, kept.id], "B, after the promotion");
      await ctx.shot("b-followed", B);

      return { gone, kept, target };
    } finally {
      await A.bringToFront().catch(() => {});
      await A
        .evaluate((promoted) => {
          if (document.querySelector(".tabs .tab.active")?.getAttribute("title") === promoted) {
            window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
          }
        }, target)
        .catch(() => {});
      await B?.close().catch(() => {});
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
    }
  },
};
