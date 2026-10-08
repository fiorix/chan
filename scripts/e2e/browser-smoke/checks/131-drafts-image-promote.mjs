// An image belongs to its document's place, and a draft's place is its own
// directory in the store. This follows one image across two drafts and out
// into the workspace:
//
//   1. An image file pasted into draft A lands in A's directory in the
//      store and renders.
//   2. A's text, copied with its image and pasted into draft B, is a paste
//      across two drafts: the image is copied into B's directory, and B
//      renders it from there.
//   3. A is discarded. B still renders its image: the copy is B's own.
//   4. B is saved to the workspace at a chosen FILE path. A draft with
//      attachments becomes a directory named after the chosen file's stem,
//      holding the primary and the image; the editor follows the primary
//      and the image renders through the relative link as it was written.
//
// The promotion's request body and the server's answer are recorded in the
// result, since what the web sends as the target is part of the contract.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  activateTab,
  assertNothingMarkedShown,
  closeDraft,
  draftsStore,
  filesUnder,
  newDraft,
  pasteImageFile,
  saveDraftToWorkspace,
  waitActiveTab,
  waitFor,
  waitImagesRendered,
} from "../lib/drafts.mjs";

async function typeAtEnd(page, text) {
  await page.click(".editor-tab.active .cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
}

/// Copy the whole of the active editor's document the way a copy does, and
/// answer the rich payload the app put on the clipboard once its images are
/// inlined. The copy event is synthesized; the payload is the app's own.
async function copyAllRich(page) {
  await page.click(".editor-tab.active .cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    document
      .querySelector(".editor-tab.active .cm-content")
      ?.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  return waitFor("the inlined copy on the clipboard", 20_000, () =>
    page.evaluate(async () => {
      for (const item of await navigator.clipboard.read()) {
        if (!item.types.includes("text/html")) continue;
        const html = await (await item.getType("text/html")).text();
        if (html.includes("data-chan-markdown") && html.includes("data:image")) return html;
      }
      return null;
    }),
  );
}

async function pasteRich(page, html) {
  await page.click(".editor-tab.active .cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await page.evaluate((payload) => {
    const dt = new DataTransfer();
    dt.setData("text/html", payload);
    dt.setData("text/plain", "");
    document
      .querySelector(".editor-tab.active .cm-content")
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
}

function imagesIn(dir) {
  return filesUnder(dir).filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name));
}

export default {
  name: "drafts-image-promote",
  async run(ctx) {
    const { page } = ctx;
    const stamp = Date.now().toString(36);
    const dir = `smoke-drafts-${stamp}`;
    const chosen = `${dir}/report.md`;
    try {
      // 1. Draft A takes a pasted image file.
      const a = await newDraft(ctx, page);
      const store = draftsStore(ctx, a.name);
      await typeAtEnd(page, `\n\nfrom A ${stamp}\n\n`);
      await pasteImageFile(page);
      await waitImagesRendered(page, 1, "draft A");
      const aImages = await waitFor("A's image in its directory", 20_000, () => {
        const found = imagesIn(join(store, a.name));
        return found.length === 1 ? found : null;
      });
      await waitFor("A's text with the image reference in the store", 20_000, () =>
        readFileSync(join(store, a.path), "utf8").includes("![]("),
      );
      const wrapper = await copyAllRich(page);
      const origin = /data-chan-root="draft"/.test(wrapper) && /data-chan-draft-id="/.test(wrapper);
      if (!origin) throw new Error("the copy from a draft does not name its origin by root and lifetime id");
      if (wrapper.includes(String.fromCharCode(0))) throw new Error("the copy wrote a draft path's mark to the clipboard");
      await ctx.shot("draft-a");

      // 2. Draft B takes A's text and image by a rich paste.
      const b = await newDraft(ctx, page);
      await typeAtEnd(page, `\n\ninto B ${stamp}\n\n`);
      await pasteRich(page, wrapper);
      await waitImagesRendered(page, 1, "draft B after the paste");
      const bImages = await waitFor("the image copied into B's directory", 20_000, () => {
        const found = imagesIn(join(store, b.name));
        return found.length === 1 ? found : null;
      });
      const bText = await waitFor("B's text saved with the reference", 20_000, () => {
        const text = readFileSync(join(store, b.path), "utf8");
        return text.includes(`from A ${stamp}`) && text.includes("![](") ? text : null;
      });
      const ref = /!\[[^\]]*\]\(([^)#]+)/.exec(bText)?.[1] ?? "";
      if (!ref.startsWith("./")) throw new Error(`B's image reference is not beside it: ${ref}`);

      // 3. A is discarded; B's image is its own.
      await activateTab(page, `Drafts/${a.path}`);
      await page.waitForFunction(
        (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
        { timeout: 15_000 },
        `from A ${stamp}`,
      );
      await closeDraft(page, "discard");
      await waitFor("A to leave the store", 20_000, () => !existsSync(join(store, a.name)));
      await activateTab(page, `Drafts/${b.path}`);
      await page.waitForFunction(
        (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
        { timeout: 15_000 },
        `into B ${stamp}`,
      );
      await waitImagesRendered(page, 1, "draft B after A was discarded");

      // 4. B is saved to the workspace at a chosen file path.
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
      await saveDraftToWorkspace(page, chosen);
      const leaf = b.path.split("/").pop();
      const promotedDir = join(ctx.workspaceDir, dir, "report");
      await waitFor("the promoted directory in the workspace", 20_000, () => existsSync(join(promotedDir, leaf)));
      page.off("response", onResponse);
      const promoted = filesUnder(join(ctx.workspaceDir, dir));
      const expected = [`report/${leaf}`, `report/${bImages[0]}`].sort();
      if (JSON.stringify(promoted) !== JSON.stringify(expected)) {
        throw new Error(`the promotion made ${promoted.join(", ")}, expected ${expected.join(", ")}`);
      }
      const promotedText = readFileSync(join(promotedDir, leaf), "utf8");
      if (!promotedText.includes(ref)) throw new Error("the promoted text's image reference changed");
      await waitActiveTab(page, `${dir}/report/${leaf}`, "the editor following the promoted primary");
      await page.waitForFunction(
        (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
        { timeout: 20_000 },
        `into B ${stamp}`,
      );
      await waitImagesRendered(page, 1, "the promoted document");
      if (existsSync(join(store, b.name))) throw new Error("the saved draft is still in the store");
      await assertNothingMarkedShown(page, [a.id, b.id], "after the promotion");
      await ctx.shot("promoted");

      const promotion = promotions[0] ?? null;
      if (!promotion) throw new Error("no promotion request was seen");
      const sent = JSON.parse(promotion.request ?? "{}");
      if (sent.target !== chosen) throw new Error(`the promotion sent target ${sent.target}, not the chosen file ${chosen}`);
      if (promotion.status !== 200) throw new Error(`the promotion answered ${promotion.status}: ${promotion.answer}`);

      return { store, a, b, aImages, bImages, ref, promoted, promotion };
    } finally {
      await page
        .evaluate(() => {
          window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }));
        })
        .catch(() => {});
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
    }
  },
};
