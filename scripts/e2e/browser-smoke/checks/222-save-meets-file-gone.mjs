// A save that meets its file gone, under a workspace root that is still
// there, reads as the file gone and keeps the typed text; Save here writes it
// back to the same path.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit.
//
// The page's `chan.docsync` flag is off, so the editor saves by autosave PUTs
// with the modification time it loaded, the path whose refusal this check
// drives (a document on a live session learns of a removal from the session
// instead). Each leg types a marker into the open document and holds the
// autosave's PUT in the browser (a devtools Fetch interception) while the
// check removes the file, then the file and its folder, and then releases
// it: the server refuses the write as the write conflict with no time on
// disk. The tab must turn to "File moved or deleted" with no dialog over it,
// say the unsaved edits are still in the tab and offer Save here, Find and
// Close. Save here must put the file back, its folder with it, reading
// exactly the typed text, and the tab must be the file's again with nothing
// unsaved.

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserTab, openFileTab, showFiles } from "../lib/files.mjs";
import { waitFor } from "../lib/drafts.mjs";

const RUN = Date.now().toString(36);
const EDITOR = ".editor-tab.active";
const DOCSYNC_FLAG = "chan.docsync";
const MISSING_ACTIONS = ["Save here", "Find", "Close"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEditor(page) {
  return page.evaluate((selector) => {
    const view = document.querySelector(`${selector} .cm-content`)?.cmTile?.root?.view;
    return view ? view.state.doc.toString() : null;
  }, EDITOR);
}

async function typeAtEndOfFirstLine(page, text) {
  await page.evaluate((selector) => {
    const view = document.querySelector(`${selector} .cm-content`)?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable");
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });
    view.focus();
  }, EDITOR);
  await sleep(150);
  await page.keyboard.type(text);
}

/// The active tab's dirty mark and the missing state's text and buttons.
function readTab(page) {
  return page.evaluate(() => {
    const state = document.querySelector(".editor-tab .missing-file-state");
    return {
      dirty: document.querySelector(".tabs .tab.active .dirty.unsaved") !== null,
      missing: state ? state.textContent?.replace(/\s+/g, " ").trim() ?? "" : null,
      actions: state ? [...state.querySelectorAll(".missing-actions button")].map((b) => b.textContent?.trim() ?? "") : [],
      dialog: document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) ?? null,
    };
  });
}

/// One leg: type `marker`, hold its save, run `remove`, release the save, and
/// read the missing state; then Save here and read the file.
async function leg(ctx, page, hold, { name, file, doc, before, marker, remove }) {
  const typed = before.replace(/\n/, ` ${marker}\n`);
  const answers = hold.answers.length;
  hold.on = true;
  await typeAtEndOfFirstLine(page, ` ${marker}`);
  await waitFor(`${name}: the autosave of the typed text, held`, 15_000, () => hold.held.length > 0 || null);
  remove();
  if (existsSync(file)) throw new Error(`${name}: ${doc} still exists after the removal`);
  await hold.release();
  await waitFor(`${name}: the answer to the held save`, 15_000, () => hold.answers.length > answers || null);
  const saveAnswer = hold.answers[answers];
  const missing = await waitFor(`${name}: the tab's missing state`, 15_000, async () => {
    const tab = await readTab(page);
    return tab.missing !== null || tab.dialog !== null ? tab : null;
  }).catch(async (error) => {
    throw new Error(`${error.message}; the tab reads ${JSON.stringify(await readTab(page))}`);
  });
  // A prompt opens in the turn that reads the refusal; read the page a
  // second past it.
  await sleep(1_000);
  const settled = await readTab(page);
  await ctx.shot(`222-${name}-gone`, page);
  if (settled.dialog !== null) throw new Error(`${name}: a save that met its file gone opened a dialog: ${settled.dialog}`);
  const failures = [];
  if (!settled.dirty) failures.push("the tab shows nothing unsaved");
  if (!settled.missing?.includes("File moved or deleted") || !settled.missing.includes(doc)) failures.push("no File moved or deleted state for the document");
  if (!settled.missing?.includes("The unsaved edits are still in this tab.")) failures.push("the state does not say the edits are kept");
  if (JSON.stringify(settled.actions) !== JSON.stringify(MISSING_ACTIONS)) failures.push(`it offers ${JSON.stringify(settled.actions)}`);
  if (failures.length) throw new Error(`${name}: ${failures.join("; ")}; the tab reads ${JSON.stringify(settled)}`);

  const saveHere = (await page.evaluateHandle(() =>
    [...document.querySelectorAll(".editor-tab .missing-actions button")]
      .find((button) => button.textContent?.trim() === "Save here"))).asElement();
  await saveHere.click();
  await waitFor(`${name}: Save here to put the file back`, 20_000, () =>
    (existsSync(file) && readFileSync(file, "utf8") === typed) || null,
  ).catch((error) => {
    throw new Error(`${error.message}; the file ${existsSync(file) ? `reads ${JSON.stringify(readFileSync(file, "utf8"))}` : "is absent"}`);
  });
  const back = await waitFor(`${name}: the tab back on its file with nothing unsaved`, 15_000, async () => {
    const tab = await readTab(page);
    const text = await readEditor(page);
    return tab.missing === null && !tab.dirty && text === typed ? { tab, text } : null;
  }).catch(async (error) => {
    throw new Error(`${error.message}; the tab reads ${JSON.stringify(await readTab(page))}, the editor ${JSON.stringify(await readEditor(page))}`);
  });
  await ctx.shot(`222-${name}-saved-here`, page);
  console.log(`[smoke]   ${name}: save answer ${saveAnswer}; missing ${JSON.stringify(missing.missing)}; written back ${typed.length} chars`);
  return { saveAnswer, missingState: settled, writtenBack: typed, dialog: back.tab.dialog };
}

export default {
  name: "save-meets-file-gone",
  async run(ctx) {
    const dir = `smoke-gone-${RUN}`;
    const doc = `${dir}/gone-${RUN}.md`;
    const file = join(ctx.workspaceDir, doc);
    const seed = `gone doc ${RUN}\n\ntail line ${RUN}\n`;
    const result = { browser: await ctx.browser.browser().version(), doc };
    const page = await ctx.browser.newPage();
    let cdp = null;
    let primary = null;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.bringToFront();
      await page.evaluateOnNewDocument((key) => localStorage.setItem(key, "0"), DOCSYNC_FLAG);
      mkdirSync(join(ctx.workspaceDir, dir));
      writeFileSync(file, seed);

      const hold = { on: false, held: [], answers: [], release: null };
      const docPath = `/api/fs/${doc}`;
      page.on("response", (response) => {
        if (response.request().method() === "PUT" && new URL(response.url()).pathname === docPath) {
          hold.answers.push(response.status());
        }
      });
      cdp = await page.createCDPSession();
      cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
        if (hold.on && request.method === "PUT") hold.held.push(requestId);
        else cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*${docPath}*`, requestStage: "Request" }] });
      let docSockets = 0;
      await cdp.send("Network.enable");
      cdp.on("Network.webSocketCreated", ({ url: socketUrl }) => {
        if (new URL(socketUrl).pathname.endsWith("/api/doc/ws")) docSockets += 1;
      });
      hold.release = async () => {
        hold.on = false;
        for (const requestId of hold.held.splice(0)) {
          await cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
        }
      };

      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", `save-gone-222-${RUN}`);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
      await showFiles(page);
      result.opens = await openFileTab(page, doc);
      await waitFor("the document in the editor", 30_000, async () => ((await readEditor(page)) === seed) || null);

      const first = `G1x${RUN}`;
      result.fileGone = await leg(ctx, page, hold, {
        name: "file", file, doc, before: seed, marker: first,
        remove: () => unlinkSync(file),
      });
      const second = `G2x${RUN}`;
      result.folderGone = await leg(ctx, page, hold, {
        name: "folder", file, doc, before: result.fileGone.writtenBack, marker: second,
        remove: () => rmSync(join(ctx.workspaceDir, dir), { recursive: true }),
      });
      // The path the saves took: classic PUTs, no document session.
      if (docSockets !== 0) throw new Error(`the page opened ${docSockets} document session sockets with ${DOCSYNC_FLAG} off`);
      result.docSockets = docSockets;
      console.log(`[smoke]   ${result.browser}`);
      return result;
    } catch (error) {
      primary = error;
      await ctx.shot("222-failure", page).catch(() => {});
      throw error;
    } finally {
      try {
        await cdp?.detach().catch(() => {});
        const tab = await browserTab(page);
        if (tab) {
          await tab.click();
          await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })));
        }
        await page.evaluate((key) => localStorage.removeItem(key), DOCSYNC_FLAG);
        await page.close();
      } catch (error) {
        if (primary) console.log(`[smoke]   cleanup also failed: ${error?.message ?? error}`);
        else throw error;
      } finally {
        rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
      }
    }
  },
};
