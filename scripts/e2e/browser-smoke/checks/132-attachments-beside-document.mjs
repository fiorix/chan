// An image pasted into a workspace document lands beside that document:
// in its folder for a document in a folder, at the workspace root for a
// document at the root. No `attachments/` directory is made, and no
// setting says otherwise any more.
//
// Each document is seeded on disk and opened as a person would, from the
// file tree of a File Browser tab; the paste is an image file on the
// clipboard.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  browserTab,
  filesUnder,
  pasteImageFile,
  showFileTree,
  treeItem,
  waitActiveTab,
  waitFor,
  waitImagesRendered,
} from "../lib/drafts.mjs";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/// Open `file`, which sits in the top-level folder `dir` (or at the root
/// when `dir` is null), from the tree: expand the folder, select the file's
/// row and take the inspector's Open.
async function openFromTree(page, dir, file, title) {
  const opened = await showFileTree(page);
  if (dir !== null) {
    const folder = await waitFor(`the folder ${dir} in the tree`, 20_000, () => treeItem(page, dir));
    if ((await folder.evaluate((el) => el.getAttribute("aria-expanded"))) !== "true") {
      await (await folder.$("button.twirl")).click();
    }
  }
  const row = await waitFor(`the file ${file} in the tree`, 20_000, () => treeItem(page, file)).catch(async (e) => {
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("[role=tree] [role=treeitem] .name")].map((n) => n.textContent?.trim()),
    );
    throw new Error(`${e.message}; the tree lists: ${rows.join(" | ")}`);
  });
  await (await row.$(".name")).click();
  const open = await waitFor(`the inspector's Open for ${file}`, 15_000, async () => {
    for (const button of await page.$$("button")) {
      if ((await button.evaluate((node) => node.textContent?.trim())) === "Open") return button;
    }
    return null;
  });
  await open.click();
  await waitActiveTab(page, title, `the editor on ${title}`);
  return opened;
}

export default {
  name: "attachments-beside-document",
  async run(ctx) {
    const { page } = ctx;
    const stamp = Date.now().toString(36);
    const dir = `smoke-attach-${stamp}`;
    const folderDoc = `in-folder-${stamp}.md`;
    const inFolder = `${dir}/${folderDoc}`;
    const atRoot = `smoke-attach-${stamp}-root.md`;
    const rootImagesBefore = readdirSync(ctx.workspaceDir).filter((name) => IMAGE.test(name));
    const hadAttachments = existsSync(join(ctx.workspaceDir, "attachments"));
    const made = [];
    let openedBrowser = false;
    try {
      const pasteInto = async (folder, name, file, marker) => {
        openedBrowser = (await openFromTree(page, folder, name, file)) || openedBrowser;
        await page.waitForFunction(
          (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
          { timeout: 30_000 },
          marker,
        );
        await page.click(".editor-tab.active .cm-content");
        await page.keyboard.down("Control");
        await page.keyboard.press("End");
        await page.keyboard.up("Control");
        await page.keyboard.type("\n\n");
        await pasteImageFile(page);
        await waitImagesRendered(page, 1, file);
        const text = await waitFor(`the reference saved in ${file}`, 20_000, () => {
          const body = readFileSync(join(ctx.workspaceDir, file), "utf8");
          return body.includes("![](") ? body : null;
        });
        return /!\[[^\]]*\]\(([^)#]+)/.exec(text)?.[1] ?? "";
      };

      // Both documents are on disk before the tree is first shown, so its
      // first listing holds them: what the tree does with a file made while
      // its tab is not in front is not this check's subject.
      mkdirSync(join(ctx.workspaceDir, dir));
      writeFileSync(join(ctx.workspaceDir, inFolder), `folder doc ${stamp}\n`);
      writeFileSync(join(ctx.workspaceDir, atRoot), `root doc ${stamp}\n`);
      made.push(atRoot);

      // A document in a folder.
      const folderRef = await pasteInto(dir, folderDoc, inFolder, `folder doc ${stamp}`);
      const beside = filesUnder(join(ctx.workspaceDir, dir));
      const folderImages = beside.filter((name) => IMAGE.test(name));
      if (folderImages.length !== 1 || folderImages[0].includes("/")) {
        throw new Error(`the image did not land beside ${inFolder}: ${beside.join(", ")}`);
      }
      if (!folderRef.startsWith("./")) throw new Error(`the folder document's reference is ${folderRef}`);
      await ctx.shot("in-folder");

      // A document at the workspace root.
      const rootRef = await pasteInto(null, atRoot, atRoot, `root doc ${stamp}`);
      const rootImages = readdirSync(ctx.workspaceDir).filter(
        (name) => IMAGE.test(name) && !rootImagesBefore.includes(name),
      );
      if (rootImages.length !== 1) {
        throw new Error(`the image did not land at the workspace root: ${rootImages.join(", ") || "none new"}`);
      }
      made.push(...rootImages);
      if (!rootRef.startsWith("./")) throw new Error(`the root document's reference is ${rootRef}`);
      await ctx.shot("at-root");

      if (!hadAttachments && existsSync(join(ctx.workspaceDir, "attachments"))) {
        throw new Error("an attachments directory was created");
      }
      return { folderImages, folderRef, rootImages, rootRef };
    } finally {
      // Close the two documents' tabs, each once it is the active one, and
      // the File Browser tab when this check opened it.
      const activeIsNot = (title) => document.querySelector(".tabs .tab.active")?.getAttribute("title") !== title;
      for (const file of [atRoot, inFolder]) {
        const active = await page
          .evaluate(() => document.querySelector(".tabs .tab.active")?.getAttribute("title") ?? "")
          .catch(() => "");
        if (active !== file) continue;
        await page
          .evaluate(() => {
            window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
          })
          .catch(() => {});
        await page.waitForFunction(activeIsNot, { timeout: 5_000 }, file).catch(() => {});
      }
      if (openedBrowser) {
        const tab = await browserTab(page).catch(() => null);
        if (tab) {
          await tab.click().catch(() => {});
          await page
            .evaluate(() => {
              window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
            })
            .catch(() => {});
        }
      }
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
      for (const name of made) rmSync(join(ctx.workspaceDir, name), { force: true });
    }
  },
};
