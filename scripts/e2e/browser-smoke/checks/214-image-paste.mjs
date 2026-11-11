// An image pasted from the browser's own clipboard lands in each place a
// person pastes one: a workspace document opened from the Files tab, a
// draft, and the Rich Prompt over a terminal, which then delivers it to the
// terminal as a bare path.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit, where the desktop's own
// paste shape is driven by `desktop-observations/basic-flows.sh`.
//
// The paste is the browser's. The fixture PNG is written to Chrome's
// clipboard with `navigator.clipboard.write` (the runner grants sanitized
// write), the target is focused, and Ctrl+V is pressed with the devtools key
// event's paste command, so Chrome fires a trusted paste carrying what its
// clipboard holds. Read on Chrome 156: the page gets types ["Files"], one file
// item of type image/png and a File named image.png, whose bytes are Chrome's
// re-encoding of the fixture (a sanitized write decodes the image and encodes
// it again), so the file on disk is compared with the fixture by decoded
// pixels. A plain Ctrl+V fires the same paste on Linux, where Blink maps the
// chord itself; the paste command keeps the check off that mapping. Before
// the first leg, a blank page in the same browser context is asked whether
// such a paste reaches it as an image File. When it does not, every leg
// dispatches a synthetic ClipboardEvent carrying the File instead, and the
// result says so ("synthetic, untrusted"); the product's legs never choose.
//
// Each leg asserts the embed in the editor, the image loaded at the fixture's
// size, the document's text naming it, and the file where the document's
// images belong with the fixture's pixels: beside the document for a
// workspace file (as 132 expects), in the draft's own directory in the store
// for a draft and for the Rich Prompt. The Rich Prompt leg then submits with
// Ctrl+Enter: a terminal running cat must show, in its scrollback read
// through cs, the bare absolute path of that file on disk and no markdown.
// A capture listener records the shape of the paste each leg's page saw.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeDraft,
  draftsStore,
  filesUnder,
  listDrafts,
  newDraft,
  waitFor,
} from "../lib/drafts.mjs";
import { browserTab, openFileTab, showFiles } from "../lib/files.mjs";
import { decodedPixels, pixelDifference, quadrantPng } from "../lib/png.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs } from "../lib/terminal-prefs.mjs";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const EMBED = /!\[[^\]]*\]\(([^)#\s]+)[^)]*\)/;
const WIDTH = 8;
const HEIGHT = 6;
const TAB = "paste214";

/// Installed once on the check's page: every paste event's shape as the page
/// saw it, in the capture phase before any handler.
function recordPastes() {
  window.__pasteShapes = [];
  window.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    const target = event.target instanceof Element ? event.target : null;
    window.__pasteShapes.push({
      trusted: event.isTrusted,
      types: data ? [...data.types] : null,
      items: data ? [...data.items].map((item) => ({ kind: item.kind, type: item.type })) : null,
      files: data ? [...data.files].map((file) => ({ name: file.name, type: file.type, size: file.size })) : null,
      target: target?.closest(".rich-prompt") ? "rich-prompt" : target?.closest(".editor-tab") ? "editor" : target?.nodeName ?? null,
    });
  }, true);
}

async function writeClipboardImage(page, bytes) {
  await page.bringToFront();
  const answer = await page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([data], { type: "image/png" }) })]);
      return null;
    } catch (error) {
      return String(error);
    }
  }, bytes.toString("base64"));
  if (answer) throw new Error(`Chrome refused the clipboard write of the fixture: ${answer}`);
}

async function pressPaste(page) {
  await page.keyboard.down("Control");
  await page.keyboard.down("KeyV", { commands: ["paste"] });
  await page.keyboard.up("KeyV");
  await page.keyboard.up("Control");
}

/// Whether a trusted paste of the clipboard image reaches a page as an image
/// File, asked of a blank page in the check's own browser context so that no
/// product code stands between the key press and the event.
async function trustedPasteReachesAPage(ctx, page, bytes) {
  await writeClipboardImage(page, bytes);
  const probe = await ctx.browser.newPage();
  try {
    await probe.setContent('<div id="target" contenteditable="true" style="width:320px;height:80px"></div>');
    await probe.evaluate(() => {
      window.__shape = null;
      document.getElementById("target").addEventListener("paste", (event) => {
        window.__shape = {
          trusted: event.isTrusted,
          files: [...(event.clipboardData?.files ?? [])].map((file) => ({ type: file.type, size: file.size })),
        };
        event.preventDefault();
      });
    });
    await probe.bringToFront();
    await probe.click("#target");
    await pressPaste(probe);
    const shape = await probe
      .waitForFunction(() => window.__shape, { timeout: 5_000 })
      .then((handle) => handle.jsonValue(), () => null);
    const reached = Boolean(shape?.trusted && shape.files.some((file) => file.type === "image/png" && file.size > 0));
    return { reached, shape };
  } finally {
    await probe.close().catch(() => {});
    await page.bringToFront();
  }
}

/// Paste the fixture into the focused editor under `scope` and answer the
/// shape of the paste event the page saw.
async function paste(page, scope, mode, bytes) {
  const before = await page.evaluate(() => window.__pasteShapes.length);
  if (mode === "trusted") {
    await writeClipboardImage(page, bytes);
    await pressPaste(page);
  } else {
    await page.evaluate((selector, b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], "image.png", { type: "image/png" }));
      document.querySelector(`${selector} .cm-content`)?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, scope, bytes.toString("base64"));
  }
  return waitFor(`a paste event in ${scope}`, 10_000, () =>
    page.evaluate((count) => window.__pasteShapes[count] ?? null, before),
  );
}

/// Wait until the editor under `scope` shows one image, loaded at the
/// fixture's size.
async function waitImageLoaded(page, scope, label) {
  await page.waitForFunction(
    (selector, width, height) => {
      const images = [...document.querySelectorAll(`${selector} .cm-md-image-wrap img`)];
      return images.length === 1 && images[0].complete && images[0].naturalWidth === width && images[0].naturalHeight === height;
    },
    { timeout: 20_000 },
    scope, WIDTH, HEIGHT,
  ).catch(async () => {
    const seen = await page.evaluate((selector) => ({
      wraps: document.querySelectorAll(`${selector} .cm-md-image-wrap`).length,
      images: [...document.querySelectorAll(`${selector} .cm-content img`)].map((img) => ({
        complete: img.complete, width: img.naturalWidth, height: img.naturalHeight,
      })),
      notices: [...document.querySelectorAll('[class*="notice"]')].map((n) => n.textContent?.trim()).filter(Boolean).slice(-3),
    }), scope);
    throw new Error(`${label}: the editor does not show one image loaded at ${WIDTH}x${HEIGHT}: ${JSON.stringify(seen)}`);
  });
}

/// The one image under `dir` that was not there before, as a file name.
async function newImageIn(dir, before, label) {
  return waitFor(`${label}: the image in ${dir}`, 20_000, () => {
    const added = filesUnder(dir).filter((name) => IMAGE.test(name) && !before.includes(name));
    if (added.length > 1) throw new Error(`${label}: more than one image landed: ${added.join(", ")}`);
    return added[0] ?? null;
  });
}

/// The reference the saved text at `file` holds, once it holds one.
async function savedReference(file, label) {
  const text = await waitFor(`${label}: the reference saved in ${file}`, 20_000, () => {
    const body = existsSync(file) ? readFileSync(file, "utf8") : "";
    return EMBED.test(body) ? body : null;
  });
  return decodeURIComponent(EMBED.exec(text)[1]);
}

async function assertFixturePixels(page, file, fixture, label) {
  const difference = pixelDifference(await decodedPixels(page, readFileSync(file)), fixture);
  if (difference) throw new Error(`${label}: ${file} is not the fixture: ${difference}`);
}

async function typeAtEnd(page, scope, text) {
  await page.click(`${scope} .cm-content`);
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
}

export default {
  name: "image-paste",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    const stamp = Date.now().toString(36);
    const dir = `smoke-paste-${stamp}`;
    const doc = `${dir}/paste-${stamp}.md`;
    const bytes = quadrantPng(WIDTH, HEIGHT);
    const windowId = new URL(page.url()).searchParams.get("w");
    const terminal = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId, CHAN_WORKSPACE_PATH: ctx.workspaceDir },
      timeout: 60_000,
    });
    const result = { browser: await ctx.browser.browser().version(), legs: {} };
    let openedBrowser = false;
    let draftOpen = false;
    let terminalOpen = false;
    try {
      await page.evaluate(recordPastes);
      const fixture = await decodedPixels(page, bytes);
      const capability = await trustedPasteReachesAPage(ctx, page, bytes);
      const mode = capability.reached ? "trusted" : "synthetic, untrusted";
      result.mode = mode;
      result.capability = capability.shape;
      console.log(`[smoke]   ${result.browser}; paste: ${mode}; blank page saw ${JSON.stringify(capability.shape)}`);

      // A workspace document in a folder, opened from the Files tab.
      {
        const scope = ".editor-tab.active";
        mkdirSync(join(ctx.workspaceDir, dir));
        writeFileSync(join(ctx.workspaceDir, doc), `paste doc ${stamp}\n`);
        openedBrowser = (await showFiles(page)) || openedBrowser;
        const opens = await openFileTab(page, doc);
        await page.waitForFunction(
          (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
          { timeout: 30_000 },
          `paste doc ${stamp}`,
        );
        await typeAtEnd(page, scope, "\n\n");
        const folder = join(ctx.workspaceDir, dir);
        const before = filesUnder(folder);
        const shape = await paste(page, scope, mode, bytes);
        await waitImageLoaded(page, scope, "document");
        const image = await newImageIn(folder, before, "document");
        const ref = await savedReference(join(ctx.workspaceDir, doc), "document");
        if (ref !== `./${image}`) throw new Error(`document: the text names ${ref}, not the image beside it, ./${image}`);
        await assertFixturePixels(page, join(folder, image), fixture, "document");
        await ctx.shot("document");
        result.legs.document = { opens, shape, image, ref };
      }

      // A draft: its image lands in its own directory in the store.
      {
        const scope = ".editor-tab.active";
        const draft = await newDraft(ctx, page);
        draftOpen = true;
        const store = draftsStore(ctx, draft.name);
        const own = join(store, draft.name);
        await typeAtEnd(page, scope, `\n\ndraft ${stamp}\n\n`);
        const before = filesUnder(own);
        const shape = await paste(page, scope, mode, bytes);
        await waitImageLoaded(page, scope, "draft");
        const image = await newImageIn(own, before, "draft");
        const ref = await savedReference(join(store, draft.path), "draft");
        if (ref !== `./${image}`) throw new Error(`draft: the text names ${ref}, not the image in the draft, ./${image}`);
        await assertFixturePixels(page, join(own, image), fixture, "draft");
        await ctx.shot("draft");
        await closeDraft(page, "discard");
        draftOpen = false;
        result.legs.draft = { shape, image, ref };
      }

      // The Rich Prompt over a terminal running cat.
      {
        const scope = ".rich-prompt";
        const prefs = await readTerminalPrefs(page, new URL(ctx.serverUrl).searchParams.get("t") ?? "");
        const known = new Set((await listDrafts(ctx)).drafts.map((d) => d.primary.draft_id));
        await openAttachedTerminal(ctx, page, terminal, windowId, TAB, prefs.ghostty ? "ghostty" : "xterm", ["--command", "cat"]);
        terminalOpen = true;
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.richPrompt" } }));
        });
        await page.waitForSelector(`${scope} .cm-content`, { timeout: 15_000 });
        await page.waitForFunction(() => document.activeElement?.closest?.(".rich-prompt") != null, { timeout: 10_000 });
        const draft = await waitFor("the Rich Prompt's draft in the server's list", 20_000, async () =>
          (await listDrafts(ctx)).drafts.find((d) => !known.has(d.primary.draft_id)) ?? null,
        );
        const store = draftsStore(ctx, draft.name);
        const own = join(store, draft.name);
        const before = filesUnder(own);
        const shape = await paste(page, scope, mode, bytes);
        await waitImageLoaded(page, scope, "rich prompt");
        const image = await newImageIn(own, before, "rich prompt");
        await assertFixturePixels(page, join(own, image), fixture, "rich prompt");
        await ctx.shot("rich-prompt");

        await page.keyboard.down("Control");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Control");
        const onDisk = join(own, image);
        const spellings = new Set([onDisk, realpathSync(onDisk)]);
        let last = "";
        const delivered = await waitFor("the image's path in the terminal", 20_000, async () => {
          last = (await terminal(["scrollback", "--tab-name", TAB])).stdout;
          return last.split(/\r?\n/).map((line) => line.trim()).find((line) => spellings.has(line)) ?? null;
        }).catch((error) => {
          throw new Error(`${error.message}; wanted ${onDisk}; the scrollback ends ${JSON.stringify(last.slice(-600))}`);
        });
        if (last.includes("![")) throw new Error(`rich prompt: the terminal received markdown: ${JSON.stringify(last.slice(-600))}`);
        await ctx.shot("rich-prompt-delivered");
        result.legs.richPrompt = { shape, image, delivered };
      }

      for (const [leg, entry] of Object.entries(result.legs)) {
        const opened = entry.opens ? `; opened on try ${entry.opens}` : "";
        console.log(`[smoke]   ${leg}: ${JSON.stringify(entry.shape)} -> ${entry.image}${opened}`);
      }
      return result;
    } finally {
      if (draftOpen) await closeDraft(page, "discard").catch(() => {});
      if (await page.$(".rich-prompt").catch(() => null)) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForFunction(() => !document.querySelector(".rich-prompt"), { timeout: 5_000 }).catch(() => {});
      }
      if (terminalOpen) await terminal(["close", "--tab-name", TAB]).catch(() => {});
      const active = await page
        .evaluate(() => document.querySelector(".tabs .tab.active")?.getAttribute("title") ?? "")
        .catch(() => "");
      if (active === doc) {
        await page
          .evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })))
          .catch(() => {});
      }
      if (openedBrowser) {
        const tab = await browserTab(page).catch(() => null);
        if (tab) {
          await tab.click().catch(() => {});
          await page
            .evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })))
            .catch(() => {});
        }
      }
      await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
    }
  },
};
