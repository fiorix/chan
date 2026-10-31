// An image pasted into a workspace document lands beside that document:
// in its folder for a document in a folder, at the workspace root for a
// document at the root. No `attachments/` directory is made, and no
// setting says otherwise any more.
//
// Each document is seeded on disk and opened from the Files tab's directory listing; the paste is an image file on the clipboard.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  filesUnder,
  pasteImageFile,
  waitActiveTab,
  waitFor,
  waitImagesRendered,
} from "../lib/drafts.mjs";
import { browserTab, openFile, showFiles } from "../lib/files.mjs";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

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
      const pasteInto = async (file, marker) => {
        openedBrowser = (await showFiles(page)) || openedBrowser;
        await openFile(page, file);
        await waitActiveTab(page, file, `the editor on ${file}`);
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

      // Both documents exist before Files opens, so each directory's first listing contains its document.
      mkdirSync(join(ctx.workspaceDir, dir));
      writeFileSync(join(ctx.workspaceDir, inFolder), `folder doc ${stamp}\n`);
      writeFileSync(join(ctx.workspaceDir, atRoot), `root doc ${stamp}\n`);
      made.push(atRoot);

      // A document in a folder.
      const folderRef = await pasteInto(inFolder, `folder doc ${stamp}`);
      const beside = filesUnder(join(ctx.workspaceDir, dir));
      const folderImages = beside.filter((name) => IMAGE.test(name));
      if (folderImages.length !== 1 || folderImages[0].includes("/")) {
        throw new Error(`the image did not land beside ${inFolder}: ${beside.join(", ")}`);
      }
      if (!folderRef.startsWith("./")) throw new Error(`the folder document's reference is ${folderRef}`);
      await ctx.shot("in-folder");

      // A document at the workspace root.
      const rootRef = await pasteInto(atRoot, `root doc ${stamp}`);
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
