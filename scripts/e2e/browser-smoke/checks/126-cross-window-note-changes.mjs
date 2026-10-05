// Two windows of one workspace use watch frames to keep the other window's
// tree, link kinds and open tabs current after a note is created, moved or
// deleted. Document sessions are off in both windows so the tab state in this
// check belongs to the watch path.

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

async function wait(page, label, timeout, predicate, value) {
  await page.bringToFront();
  try {
    await page.waitForFunction(predicate, { timeout, polling: 100 }, value);
  } catch (cause) {
    throw new Error(`${label} within ${timeout}ms`, { cause });
  }
}

async function command(page, name) {
  await page.bringToFront();
  await page.evaluate((commandName) => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: commandName } }));
  }, name);
}

async function treeRow(page, name) {
  const rows = await page.$$("[role=tree] [role=treeitem] button.name");
  for (const row of rows) {
    if ((await row.evaluate((node) => node.textContent?.trim())) === name) return row;
  }
  throw new Error(`tree row not found: ${name}`);
}

async function waitTreeRow(page, name, present, label, timeout = 20_000) {
  await wait(page, label, timeout, (args) => {
    const found = [...document.querySelectorAll("[role=tree] [role=treeitem] button.name")]
      .some((node) => node.textContent?.trim() === args.name);
    return found === args.present;
  }, { name, present });
}

async function selectTab(page, label) {
  await wait(page, `tab ${label} was not present`, 30_000, (wanted) =>
    [...document.querySelectorAll(".tabs .tab .path")]
      .some((node) => node.textContent?.trim() === wanted), label);
  const tabs = await page.$$(".tabs .tab");
  for (const tab of tabs) {
    if ((await tab.$eval(".path", (node) => node.textContent?.trim())) === label) {
      await tab.click();
      await wait(page, `tab ${label} was not selected`, 10_000, (wanted) =>
        document.querySelector(".tabs .tab.active .path")?.textContent?.trim() === wanted, label);
      return;
    }
  }
  throw new Error(`tab not clickable: ${label}`);
}

async function browserTabLabel(page) {
  await wait(page, "File Browser tab did not open", 15_000, () =>
    [...document.querySelectorAll(".tabs .tab .path")]
      .some((node) => node.textContent?.trim().endsWith("/")));
  return page.evaluate(() => [...document.querySelectorAll(".tabs .tab .path")]
    .map((node) => node.textContent?.trim())
    .find((label) => label?.endsWith("/")));
}

async function openBrowser(page) {
  await command(page, "app.files.toggle");
  const label = await browserTabLabel(page);
  await selectTab(page, label);
  return label;
}

async function openNote(page, browserLabel, name) {
  await selectTab(page, browserLabel);
  await waitTreeRow(page, name, true, `tree row ${name} did not appear`, 15_000);
  await (await treeRow(page, name)).click();
  await wait(page, `inspector did not offer Open for ${name}`, 15_000, () =>
    [...document.querySelectorAll("button")]
      .some((node) => node.textContent?.trim() === "Open"));
  const buttons = await page.$$("button");
  for (const button of buttons) {
    if ((await button.evaluate((node) => node.textContent?.trim())) === "Open") {
      await button.click();
      await wait(page, `editor tab ${name} did not open`, 30_000, (wanted) =>
        document.querySelector(".tabs .tab.active .path")?.textContent?.trim() === wanted &&
        !!document.querySelector(".editor-tab.active .cm-content"), name);
      return;
    }
  }
  throw new Error(`Open button not clickable for ${name}`);
}

async function rowMenu(page, name, action) {
  await page.bringToFront();
  await (await treeRow(page, name)).click({ button: "right" });
  await wait(page, `menu did not offer ${action}`, 10_000, (wanted) =>
    [...document.querySelectorAll(".ctx button")]
      .some((node) => (node.querySelector(".menu-row-label") ?? node).textContent?.trim() === wanted), action);
  const buttons = await page.$$(".ctx button");
  for (const button of buttons) {
    if ((await button.evaluate((node) =>
      (node.querySelector(".menu-row-label") ?? node).textContent?.trim())) === action) {
      await button.click();
      return;
    }
  }
  throw new Error(`menu action not clickable: ${action}`);
}

async function submitPath(page, path) {
  await wait(page, "path prompt did not open", 10_000, () => !!document.querySelector("#path-prompt-title"));
  const input = await page.$(".modal input");
  if (!input) throw new Error("path prompt had no input");
  await input.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type(path);
  await wait(page, `path ${path} was not accepted`, 10_000, () =>
    !!document.querySelector(".modal button.ok:not([disabled])"));
  await page.click(".modal button.ok");
}

async function assertMarker(page) {
  await page.bringToFront();
  if ((await page.evaluate(() => window.__chanSmokeMarker)) !== "kept") {
    throw new Error("B's page was replaced");
  }
}

export default {
  name: "cross-window-note-changes",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const A = ctx.page;
    const stamp = `${Date.now()}-${process.pid}`;
    const prefix = `xw-${stamp}`;
    const made = `${prefix}-made.md`;
    const kept = `${prefix}-kept.md`;
    const moved = `${prefix}-kept-moved.md`;
    const holder = `${prefix}-holder.md`;
    const target = `${prefix}-made`;
    const bId = `cross-window-peer-${stamp}`;
    const passed = [];
    let B;
    try {
      writeFileSync(join(ctx.workspaceDir, holder), `start ${stamp}\n\n[[${target}]]\n\nend ${stamp}\n`);
      writeFileSync(join(ctx.workspaceDir, kept), `kept ${stamp}\n`);
      await A.bringToFront();
      await A.evaluate(() => localStorage.setItem("chan.docsync", "0"));

      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", bId);
      B = await ctx.browser.newPage();
      await B.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await wait(B, "B's pane did not mount", 30_000, () => !!document.querySelector(".pane"));
      await ctx.waitWindowLive(bId);
      const flag = await B.evaluate(() => localStorage.getItem("chan.docsync"));
      if (flag !== "0") throw new Error(`B loaded with document sessions flag ${flag}`);
      await B.evaluate(() => { window.__chanSmokeMarker = "kept"; });

      const bBrowser = await openBrowser(B);
      await waitTreeRow(B, holder, true, `B's tree lacked ${holder}`, 15_000);
      await waitTreeRow(B, kept, true, `B's tree lacked ${kept}`, 15_000);
      await openNote(B, bBrowser, holder);
      await wait(B, "B's link pill did not start broken", 20_000, (wanted) =>
        document.querySelector(`.editor-tab.active .cm-md-wiki-pill[data-target="${wanted}"]`)
          ?.getAttribute("data-refkind") === "broken", target);
      await openNote(B, bBrowser, kept);
      await wait(B, "B's kept note did not mount", 30_000, (wanted) =>
        document.querySelector(".editor-tab.active .cm-content")?.textContent?.includes(wanted), stamp);
      await selectTab(B, bBrowser);
      await waitTreeRow(B, holder, true, "B's File Browser lost its holder row");
      await waitTreeRow(B, kept, true, "B's File Browser lost its kept row");
      const aBrowser = await openBrowser(A);
      await waitTreeRow(A, holder, true, "A's File Browser lacked the holder row");
      await waitTreeRow(A, kept, true, "A's File Browser lacked the kept row");

      // B's browser tab stays active until the tree has answered each change.
      await command(A, "app.file.new");
      await submitPath(A, target);
      await wait(A, "A's create opened no tab", 30_000, (wanted) =>
        document.querySelector(".tabs .tab.active .path")?.textContent?.trim() === wanted, made);
      await waitTreeRow(B, made, true, "B's tree never showed the note A created");
      passed.push("B's tree never showed the note A created");
      await selectTab(B, holder);
      await wait(B, "B's link pill kept its broken kind after A created its target", 20_000, (wanted) =>
        document.querySelector(`.editor-tab.active .cm-md-wiki-pill[data-target="${wanted}"]`)
          ?.getAttribute("data-refkind") === "file", target);
      passed.push("B's link pill kept its broken kind after A created its target");
      await assertMarker(B);

      await selectTab(B, bBrowser);
      await selectTab(A, aBrowser);
      await rowMenu(A, kept, "Rename / Move");
      await submitPath(A, moved);
      await waitTreeRow(A, moved, true, "A's own tree never showed its move");
      await wait(B, "B's tree never showed the note at the path A moved it to", 20_000,
        ({ from, to }) => {
          const rows = [...document.querySelectorAll("[role=tree] [role=treeitem] button.name")]
            .map((node) => node.textContent?.trim());
          return rows.includes(to) && !rows.includes(from);
        }, { from: kept, to: moved });
      passed.push("B's tree never showed the note at the path A moved it to");
      await selectTab(B, kept);
      await wait(B, "B's tab of the moved note was not marked missing", 20_000, (wanted) =>
        document.querySelector(".editor-tab.active .missing-file-state .missing-path")
          ?.textContent?.trim() === wanted, kept);
      await wait(B, "B closed the tab of a note moved elsewhere", 5_000, (wanted) =>
        [...document.querySelectorAll(".tabs .tab .path")]
          .some((node) => node.textContent?.trim() === wanted), kept);
      if (await B.$(".editor-tab.active .recovery-banner[role=alert]")) {
        throw new Error("B's moved note tab showed a changed-on-disk banner");
      }
      passed.push("B's tab of the moved note was not marked missing");
      await ctx.shot("peer-moved-tab-missing", B);
      await assertMarker(B);

      await openNote(B, bBrowser, made);
      await selectTab(B, bBrowser);
      await waitTreeRow(B, made, true, "B's tree lacked the note before A deleted it");
      await rowMenu(A, made, "Delete");
      await wait(A, "delete confirmation did not open", 10_000,
        () => !!document.querySelector("#confirm-title"));
      await A.click(".modal button.ok");
      await waitTreeRow(A, made, false, "A's tree kept the deleted note");
      await waitTreeRow(B, made, false, "B's tree kept the note A deleted");
      passed.push("B's tree kept the note A deleted");
      await selectTab(B, made);
      await wait(B, "B's tab of the deleted note was not marked missing", 20_000, (wanted) =>
        document.querySelector(".editor-tab.active .missing-file-state .missing-path")
          ?.textContent?.trim() === wanted, made);
      await wait(B, "B closed the tab of a note deleted elsewhere", 5_000, (wanted) =>
        [...document.querySelectorAll(".tabs .tab .path")]
          .some((node) => node.textContent?.trim() === wanted), made);
      passed.push("B's tab of the deleted note was not marked missing");
      await ctx.shot("peer-deleted-tab-missing", B);
      await selectTab(B, holder);
      await wait(B, "B's link pill kept its file kind after A deleted its target", 20_000, (wanted) =>
        document.querySelector(`.editor-tab.active .cm-md-wiki-pill[data-target="${wanted}"]`)
          ?.getAttribute("data-refkind") === "broken", target);
      passed.push("B's link pill kept its file kind after A deleted its target");
      await assertMarker(B);

      await openNote(A, aBrowser, moved);
      await selectTab(A, aBrowser);
      await selectTab(B, bBrowser);
      await rowMenu(A, moved, "Rename / Move");
      await submitPath(A, kept);
      await wait(A, "A's tab did not follow the note moved back", 20_000, (wanted) =>
        [...document.querySelectorAll(".tabs .tab .path")]
          .some((node) => node.textContent?.trim() === wanted), kept);
      await waitTreeRow(B, kept, true, "B's tree never showed the note moved back");
      await selectTab(B, kept);
      await wait(B, "B raised no banner on the tab whose path A filled again", 20_000, () =>
        document.querySelector(".editor-tab.active .recovery-banner[role=alert] .recovery-banner-text")
          ?.textContent?.trim() === "This file changed on disk.");
      passed.push("B raised no banner on the tab whose path A filled again");
      await ctx.shot("peer-restored-path-banner", B);
      await assertMarker(B);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await assertMarker(B);
      return { stamp, peerWindow: bId, passed };
    } catch (error) {
      if (B && !B.isClosed()) await ctx.shot("peer-failure", B).catch(() => {});
      throw error;
    } finally {
      if (B && !B.isClosed()) await B.close().catch(() => {});
      for (const name of [holder, kept, moved, made]) {
        rmSync(join(ctx.workspaceDir, name), { force: true });
      }
    }
  },
};
