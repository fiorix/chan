// A workspace's drafts live outside it. This drives one draft through its
// life in a workspace window and reads all three places it shows: the page,
// the server's drafts list, and the disk.
//
// Create: the workspace root gains nothing and the sidecar store under the
// server's CHAN_HOME holds the draft. Edit: what is typed is saved there, and
// a reload of the page brings the tab and its text back. The Drafts group
// above the file tree lists the draft. The client's own spelling of a
// draft's path, sent to the files route, is refused and creates nothing.
// Save to Workspace on a draft with no attachments makes one file at the
// chosen path, the editor follows it, and the draft leaves the store and the
// group. A second, edited draft discarded from its close dialog lands in
// the store's trash. Nothing the page shows holds a draft path's mark or
// the id of a draft's lifetime.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  activateTab,
  assertNothingMarkedShown,
  closeDraft,
  draftsStore,
  filesUnder,
  groupNames,
  listDrafts,
  markedPath,
  newDraft,
  openTree,
  request,
  saveDraftToWorkspace,
  waitActiveTab,
  waitFor,
  waitGroup,
} from "../lib/drafts.mjs";

export default {
  name: "drafts-lifecycle",
  async run(ctx) {
    const { page } = ctx;
    const stamp = Date.now().toString(36);
    const dir = `smoke-drafts-${stamp}`;
    const target = `${dir}/lone.md`;
    const typed = `lifecycle body ${stamp}`;
    const rootBefore = readdirSync(ctx.workspaceDir).sort();
    try {
      // Create.
      const first = await newDraft(ctx, page);
      const store = draftsStore(ctx, first.name);
      const primary = join(store, first.path);
      if (!existsSync(primary)) throw new Error(`the store holds no ${first.path}`);
      const rootAfter = readdirSync(ctx.workspaceDir).sort();
      if (JSON.stringify(rootAfter) !== JSON.stringify(rootBefore)) {
        throw new Error(`creating a draft changed the workspace root: ${rootAfter.join(", ")}`);
      }
      if (store.startsWith(ctx.workspaceDir + "/")) throw new Error("the drafts store is inside the workspace");

      // Edit, and the save reaches the store.
      await page.click(".editor-tab.active .cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("End");
      await page.keyboard.up("Control");
      await page.keyboard.type(`\n\n${typed}\n`);
      await waitFor("the typed text in the store", 20_000, () => readFileSync(primary, "utf8").includes(typed));
      await assertNothingMarkedShown(page, [first.id], "with the draft open");
      await ctx.shot("draft-open");

      // A reload brings the tab and its text back.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
        { timeout: 30_000 },
        typed,
      );
      await assertNothingMarkedShown(page, [first.id], "after the reload");

      // The client's spelling of the draft's path names no file to the server.
      const marked = encodeURIComponent(markedPath(first.id, first.path)).replace(/%2F/g, "/");
      const rawGet = await request(ctx, `/api/fs/${marked}`);
      const rawPut = await request(ctx, `/api/fs/${marked}`, {
        method: "PUT",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "must not land",
      });
      if (rawGet.status !== 400) throw new Error(`a GET of the marked path answered ${rawGet.status}, not 400`);
      if (rawPut.status !== 400) throw new Error(`a PUT of the marked path answered ${rawPut.status}, not 400`);
      if (readFileSync(primary, "utf8").includes("must not land")) throw new Error("the refused PUT wrote the draft");
      if (JSON.stringify(readdirSync(ctx.workspaceDir).sort()) !== JSON.stringify(rootBefore)) {
        throw new Error("the refused requests changed the workspace root");
      }

      // The Drafts group lists it.
      await openTree(page);
      await waitFor("the draft in the Drafts group", 20_000, async () => (await groupNames(page)).includes(first.name));
      const note = await page.$eval(".drafts-group .drafts-note", (el) => el.textContent.replace(/\s+/g, " ").trim());
      if (!note.includes("kept outside the workspace")) throw new Error(`the group's sentence reads: ${note}`);
      await ctx.shot("drafts-group");
      await activateTab(page, `Drafts/${first.path}`);

      // Save to Workspace: one file at the chosen path, and the editor follows.
      const promotions = [];
      const onResponse = async (response) => {
        if (!response.url().includes("/api/drafts/promote")) return;
        promotions.push({
          status: response.status(),
          request: response.request().postData(),
          answer: await response.text().catch(() => null),
        });
      };
      page.on("response", onResponse);
      mkdirSync(join(ctx.workspaceDir, dir));
      await saveDraftToWorkspace(page, target);
      const onDisk = join(ctx.workspaceDir, target);
      await waitFor("the promoted file in the workspace", 20_000, () => existsSync(onDisk));
      page.off("response", onResponse);
      if (!readFileSync(onDisk, "utf8").includes(typed)) throw new Error("the promoted file lost the typed text");
      const made = filesUnder(dirname(onDisk));
      if (JSON.stringify(made) !== JSON.stringify(["lone.md"])) {
        throw new Error(`a lone draft's save made more than its file: ${made.join(", ")}`);
      }
      await waitActiveTab(page, target, "the editor following the promoted file");
      await page.waitForFunction(
        (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
        { timeout: 20_000 },
        typed,
      );
      if (existsSync(join(store, first.name))) throw new Error("the saved draft is still in the store");
      await waitGroup(page, first.name, false);
      if ((await listDrafts(ctx)).drafts.some((d) => d.name === first.name && d.primary.draft_id === first.id)) {
        throw new Error("the server still lists the saved draft");
      }

      // A second draft, edited, discarded from its close dialog.
      const second = await newDraft(ctx, page);
      await page.click(".editor-tab.active .cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("End");
      await page.keyboard.up("Control");
      await page.keyboard.type(`\n\nto be discarded ${stamp}\n`);
      await waitGroup(page, second.name, true);
      await activateTab(page, `Drafts/${second.path}`);
      await closeDraft(page, "discard");
      await waitFor("the discarded draft to leave the store", 20_000, () => !existsSync(join(store, second.name)));
      // The trash keeps each discarded draft under an id of its own, with
      // the draft's files in it: find the one that holds what was typed.
      const trash = join(dirname(store), "drafts-trash");
      const discardedText = `to be discarded ${stamp}`;
      const trashed = (existsSync(trash) ? readdirSync(trash) : []).filter((entry) =>
        filesUnder(join(trash, entry)).some(
          (file) => file.endsWith(".md") && readFileSync(join(trash, entry, file), "utf8").includes(discardedText),
        ),
      );
      if (trashed.length !== 1) {
        throw new Error(`expected the discarded draft once in ${trash}, found it ${trashed.length} times`);
      }
      await waitGroup(page, second.name, false);
      await assertNothingMarkedShown(page, [first.id, second.id], "at the end");

      return {
        store,
        first,
        second,
        rawGet: rawGet.status,
        rawPut: rawPut.status,
        promotion: promotions[0] ?? null,
        trash: trashed,
      };
    } finally {
      // Leave the shared window and workspace as they were found.
      await page
        .evaluate((promoted) => {
          if (document.querySelector(".tabs .tab.active")?.getAttribute("title") === promoted) {
            window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
          }
        }, target)
        .catch(() => {});
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
    }
  },
};
