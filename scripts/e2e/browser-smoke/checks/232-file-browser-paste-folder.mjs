// The file browser menu's Paste lands in the right-clicked row's folder.
// Copies keep.txt through the row menu, right-clicks the sub folder row of a
// Files tab showing notes, and pastes through the menu: the file must land
// in notes/sub on disk with the landed entry selected, while the chord and
// the launcher keep the shared rule (covered by the destinations suite).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileRow, navigateFiles } from "../lib/files.mjs";

async function menuButton(page, title) {
  const found = await page.evaluateHandle((name) => [...document.querySelectorAll(".ctx button")].find(
    (candidate) => candidate.querySelector(".menu-row-label")?.textContent?.trim() === name) ?? null, title);
  const element = found.asElement();
  if (!element) throw new Error(`menu row ${JSON.stringify(title)} not found`);
  return element;
}

async function rowByName(page, name) {
  const row = await fileRow(page, name);
  if (!row) throw new Error(`file row ${JSON.stringify(name)} not found`);
  return row;
}

export default {
  name: "file-browser-paste-folder",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    mkdirSync(join(ctx.workspaceDir, "notes", "sub"), { recursive: true });
    writeFileSync(join(ctx.workspaceDir, "notes", "keep.txt"), "keep me\n");
    await navigateFiles(page, "notes");

    const keep = await rowByName(page, "keep.txt");
    await keep.click({ button: "right" });
    await (await menuButton(page, "Copy")).click();

    const sub = await rowByName(page, "sub");
    await sub.click({ button: "right" });
    await (await menuButton(page, "Paste")).click();

    const landed = join(ctx.workspaceDir, "notes", "sub", "keep.txt");
    await ctx.pollFile(landed, 15_000);
    if (readFileSync(landed, "utf8") !== "keep me\n") throw new Error("pasted content differs");
    if (!existsSync(join(ctx.workspaceDir, "notes", "keep.txt"))) throw new Error("copy removed the source");
    await page.waitForFunction((path) => [...document.querySelectorAll('[role="option"],[role="treeitem"]')].some(
      (row) => (row.getAttribute("title") ?? "").endsWith(path) && row.getAttribute("aria-selected") === "true",
    ), { timeout: 15_000 }, "notes/sub/keep.txt");
  },
};
