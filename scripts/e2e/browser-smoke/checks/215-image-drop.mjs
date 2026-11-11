// An image file dropped from outside the browser lands on the row it was
// dropped on, in a workspace document and in the Rich Prompt, and a file
// dropped anywhere else on the page does nothing: the page stays where it is
// and nothing is uploaded.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit.
//
// The drop is the browser's: the devtools protocol dispatches dragEnter,
// dragOver and drop with `data.files` naming the fixture PNG on disk, as the
// OS hands a dragged file to the page. Read on Chrome 156: while the drag
// hovers the page sees types ["Files"] and one image/png item with an empty
// file list (the protected mode of a drag in progress), and the drop carries
// the File with its name and its bytes. Before the first leg a blank page in
// the same browser context is asked whether such a drop reaches it with the
// File; when it does not, every leg dispatches synthetic drag events carrying
// a DataTransfer with the File instead, and the result says so ("synthetic,
// untrusted").
//
// The drop legs assert the embed in the saved text on the row under the drop
// point, the image loaded at the fixture's size, and the file where the
// document's images belong with the fixture's bytes: beside the document, or
// in the Rich Prompt's draft directory in the store. The outside leg drops on
// a point that `[data-file-drop-zone]` and `.cm-editor` (the drop guard's
// zones) do not cover, and asserts that the guard cancelled the drag's
// dragover with no drop effect, that no drop reached the page, that no image
// appeared in the workspace or in any draft, and that the page asked for no
// navigation. That last reading is the one that matters to a person: with
// nothing cancelling the drag, Chrome asks to navigate the window to the
// dropped file's file: URL (read on Chrome 156 as Page.frameRequestedNavigation;
// headless Chrome then refuses to leave the page, a desktop webview follows
// it into a bare file view), so the page's URL alone cannot tell the guard
// is there. Every leg reads the navigation requests and the URL.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { draftsStore, filesUnder, listDrafts, waitFor } from "../lib/drafts.mjs";
import { browserTab, openFileTab, showFiles } from "../lib/files.mjs";
import { quadrantPng } from "../lib/png.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs } from "../lib/terminal-prefs.mjs";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const EMBED = /!\[[^\]]*\]\(([^)#\s]+)[^)]*\)/;
const WIDTH = 8;
const HEIGHT = 6;
const TAB = "drop215";
const ZONES = "[data-file-drop-zone], .cm-editor";

/// Installed once on the check's page: every drag event's shape as the page
/// saw it in the capture phase, and once the event has finished its trip
/// whether anything cancelled it and the drop effect it was left with.
function recordDrags() {
  window.__dragShapes = [];
  for (const type of ["dragenter", "dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      const data = event.dataTransfer;
      const target = event.target instanceof Element ? event.target : null;
      const entry = {
        type,
        trusted: event.isTrusted,
        types: data ? [...data.types] : null,
        items: data ? [...data.items].map((item) => ({ kind: item.kind, type: item.type })) : null,
        files: data ? [...data.files].map((file) => ({ name: file.name, type: file.type, size: file.size })) : null,
        target: target?.closest(".rich-prompt") ? "rich-prompt" : target?.closest(".editor-tab") ? "editor" : target?.nodeName ?? null,
      };
      window.__dragShapes.push(entry);
      setTimeout(() => {
        entry.cancelled = event.defaultPrevented;
        entry.effect = data?.dropEffect ?? null;
      }, 0);
    }, true);
  }
}

/// Whether a dispatched drop reaches a page with the File, asked of a blank
/// page in the check's own browser context.
async function trustedDropReachesAPage(ctx, page, path) {
  const probe = await ctx.browser.newPage();
  try {
    await probe.setContent('<div id="target" style="width:320px;height:160px"></div>');
    await probe.evaluate(() => {
      window.__shape = null;
      const target = document.getElementById("target");
      target.addEventListener("dragover", (event) => event.preventDefault());
      target.addEventListener("drop", (event) => {
        event.preventDefault();
        window.__shape = {
          trusted: event.isTrusted,
          files: [...(event.dataTransfer?.files ?? [])].map((file) => ({ name: file.name, type: file.type, size: file.size })),
        };
      });
    });
    const cdp = await probe.createCDPSession();
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x: 100, y: 80, data }).catch(() => {});
    }
    await cdp.detach().catch(() => {});
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

/// Drop the fixture at `point` and answer the drag events the page saw.
async function drop(page, cdp, mode, point, path, bytes) {
  const before = await page.evaluate(() => window.__dragShapes.length);
  if (mode === "trusted") {
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data });
    }
  } else {
    await page.evaluate(({ x, y }, b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], "dropped.png", { type: "image/png" }));
      const target = document.elementFromPoint(x, y);
      for (const type of ["dragenter", "dragover", "drop"]) {
        target?.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
    }, point, bytes.toString("base64"));
  }
  // Each shape's verdict lands a macrotask after its event.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return page.evaluate((count) => window.__dragShapes.slice(count), before);
}

/// The point at the end of the line under `scope` whose text is `text`, and
/// whether the drop guard's zones cover it.
async function endOfLine(page, scope, text) {
  const point = await page.evaluate((selector, wanted, zones) => {
    const line = [...document.querySelectorAll(`${selector} .cm-line`)].find((el) => el.textContent === wanted);
    if (!line) return null;
    const box = line.getBoundingClientRect();
    const x = Math.round(box.right - 6);
    const y = Math.round(box.top + box.height / 2);
    return { x, y, inZone: Boolean(document.elementFromPoint(x, y)?.closest(zones)) };
  }, scope, text, ZONES);
  if (!point) throw new Error(`no line reading ${JSON.stringify(text)} under ${scope}`);
  return point;
}

/// A point in the tab strip that neither drop zone covers.
async function outsideAnyZone(page) {
  const point = await page.evaluate((zones) => {
    const strip = document.querySelector(".pane .tabs");
    if (!strip) return null;
    const box = strip.getBoundingClientRect();
    for (let x = Math.round(box.right) - 4; x > box.left; x -= 8) {
      const y = Math.round(box.top + box.height / 2);
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest(zones)) return { x, y, at: `${el.nodeName}.${el.className}` };
    }
    return null;
  }, ZONES);
  if (!point) throw new Error("no point in the tab strip lies outside the drop zones");
  return point;
}

/// The image files under `dir`, as paths relative to it. A file that goes
/// while the walk reads its directory is not one.
function imagesUnder(dir, depth = 0) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && depth < 8) {
      for (const name of imagesUnder(join(dir, entry.name), depth + 1)) found.push(`${entry.name}/${name}`);
    } else if (entry.isFile() && IMAGE.test(entry.name)) {
      found.push(entry.name);
    }
  }
  return found;
}

/// Every image in the workspace and in every draft store under the server's
/// CHAN_HOME, where an upload from the page could land.
function imagesEverywhere(ctx) {
  const stores = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "Drafts") stores.push(join(dir, entry.name));
      else walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(ctx.chanHome, 0);
  return [
    ...imagesUnder(ctx.workspaceDir).map((name) => `workspace:${name}`),
    ...stores.flatMap((store) => imagesUnder(store).map((name) => `${store}:${name}`)),
  ].sort();
}

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
    }), scope);
    throw new Error(`${label}: the editor does not show one image loaded at ${WIDTH}x${HEIGHT}: ${JSON.stringify(seen)}`);
  });
}

/// The saved text at `file` once a line of it holds an embed: that line and
/// the embed's reference.
async function savedEmbedLine(file, label) {
  const text = await waitFor(`${label}: the embed saved in ${file}`, 20_000, () => {
    const body = existsSync(file) ? readFileSync(file, "utf8") : "";
    return EMBED.test(body) ? body : null;
  });
  const lines = text.split("\n").filter((line) => EMBED.test(line));
  if (lines.length !== 1) throw new Error(`${label}: ${lines.length} lines of ${file} hold an embed: ${JSON.stringify(text)}`);
  return { line: lines[0], ref: decodeURIComponent(EMBED.exec(lines[0])[1]) };
}

async function newImageIn(dir, before, label) {
  return waitFor(`${label}: the image in ${dir}`, 20_000, () => {
    const added = filesUnder(dir).filter((name) => IMAGE.test(name) && !before.includes(name));
    if (added.length > 1) throw new Error(`${label}: more than one image landed: ${added.join(", ")}`);
    return added[0] ?? null;
  });
}

function assertDropReached(shapes, where, label) {
  const dropped = shapes.find((shape) => shape.type === "drop");
  if (!dropped) throw new Error(`${label}: no drop reached the page: ${JSON.stringify(shapes)}`);
  if (dropped.target !== where) throw new Error(`${label}: the drop reached ${dropped.target}, not the ${where}: ${JSON.stringify(dropped)}`);
  return dropped;
}

/// The page asked for no navigation to a file and is still the document it
/// was. The layout in the address's fragment follows the caret, which a drop
/// into an editor moves, so the fragment is not compared.
function assertSamePage(page, url, navigations, label) {
  const files = navigations.filter((nav) => /^file:/i.test(nav.url));
  if (files.length) throw new Error(`${label}: the page asked to navigate to the dropped file: ${JSON.stringify(files)}`);
  const base = (href) => href.split("#")[0];
  if (base(page.url()) !== base(url)) throw new Error(`${label}: the page left ${base(url)} for ${base(page.url())}`);
}

export default {
  name: "image-drop",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    const stamp = Date.now().toString(36);
    const dir = `smoke-drop-${stamp}`;
    const doc = `${dir}/drop-${stamp}.md`;
    const rows = [`row one ${stamp}`, `row two ${stamp}`, `row three ${stamp}`];
    const bytes = quadrantPng(WIDTH, HEIGHT);
    const fixturePath = join(ctx.outDir, `drop-fixture-${stamp}.png`);
    writeFileSync(fixturePath, bytes);
    const windowId = new URL(page.url()).searchParams.get("w");
    const terminal = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId, CHAN_WORKSPACE_PATH: ctx.workspaceDir },
      timeout: 60_000,
    });
    const result = { browser: await ctx.browser.browser().version(), legs: {} };
    const navigations = [];
    let cdp = null;
    let openedBrowser = false;
    let terminalOpen = false;
    try {
      await page.evaluate(recordDrags);
      const capability = await trustedDropReachesAPage(ctx, page, fixturePath);
      const mode = capability.reached ? "trusted" : "synthetic, untrusted";
      result.mode = mode;
      result.capability = capability.shape;
      console.log(`[smoke]   ${result.browser}; drop: ${mode}; blank page saw ${JSON.stringify(capability.shape)}`);
      cdp = await page.createCDPSession();
      await cdp.send("Page.enable");
      cdp.on("Page.frameRequestedNavigation", (event) => navigations.push({ url: event.url, reason: event.reason }));
      const url = page.url();

      // A workspace document: the image lands on the second row.
      {
        const scope = ".editor-tab.active";
        mkdirSync(join(ctx.workspaceDir, dir));
        writeFileSync(join(ctx.workspaceDir, doc), `${rows.join("\n\n")}\n`);
        openedBrowser = (await showFiles(page)) || openedBrowser;
        const opens = await openFileTab(page, doc);
        await page.waitForFunction(
          (text) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(text),
          { timeout: 30_000 },
          rows[2],
        );
        const docUrl = page.url();
        const folder = join(ctx.workspaceDir, dir);
        const before = filesUnder(folder);
        const point = await endOfLine(page, scope, rows[1]);
        if (!point.inZone) throw new Error(`document: the drop point ${JSON.stringify(point)} is outside the drop zones`);
        const shapes = await drop(page, cdp, mode, point, fixturePath, bytes);
        const dropped = assertDropReached(shapes, "editor", "document");
        await waitImageLoaded(page, scope, "document");
        const image = await newImageIn(folder, before, "document");
        const { line, ref } = await savedEmbedLine(join(ctx.workspaceDir, doc), "document");
        if (!line.startsWith(rows[1])) throw new Error(`document: the embed is on ${JSON.stringify(line)}, not on the drop row ${JSON.stringify(rows[1])}`);
        if (ref !== `./${image}`) throw new Error(`document: the text names ${ref}, not the image beside it, ./${image}`);
        if (!readFileSync(join(folder, image)).equals(bytes)) throw new Error(`document: ${image} does not hold the dropped file's bytes`);
        assertSamePage(page, docUrl, navigations, "document");
        await ctx.shot("document");
        result.legs.document = { opens, point, shapes, dropped, image, line };
      }

      // The Rich Prompt over a terminal running cat: the image lands on the
      // row typed into it, and in its draft's directory.
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
        const typed = `drop row ${stamp}`;
        await page.keyboard.type(typed);
        await page.waitForFunction(
          (selector, text) => [...document.querySelectorAll(`${selector} .cm-line`)].some((el) => el.textContent === text),
          { timeout: 10_000 },
          scope, typed,
        );
        const promptUrl = page.url();
        const before = filesUnder(own);
        const point = await endOfLine(page, scope, typed);
        if (!point.inZone) throw new Error(`rich prompt: the drop point ${JSON.stringify(point)} is outside the drop zones`);
        const shapes = await drop(page, cdp, mode, point, fixturePath, bytes);
        const dropped = assertDropReached(shapes, "rich-prompt", "rich prompt");
        await waitImageLoaded(page, scope, "rich prompt");
        const image = await newImageIn(own, before, "rich prompt");
        const { line, ref } = await savedEmbedLine(join(store, draft.primary.path), "rich prompt");
        if (!line.startsWith(typed)) throw new Error(`rich prompt: the embed is on ${JSON.stringify(line)}, not on the drop row ${JSON.stringify(typed)}`);
        if (ref !== `./${image}`) throw new Error(`rich prompt: the text names ${ref}, not the image in its draft, ./${image}`);
        if (!readFileSync(join(own, image)).equals(bytes)) throw new Error(`rich prompt: ${image} does not hold the dropped file's bytes`);
        assertSamePage(page, promptUrl, navigations, "rich prompt");
        await ctx.shot("rich-prompt");
        result.legs.richPrompt = { point, shapes, dropped, image, line };
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".rich-prompt"), { timeout: 5_000 }).catch(() => {});
      }

      // Outside every zone: nothing happens.
      {
        const before = imagesEverywhere(ctx);
        const outsideUrl = page.url();
        const point = await outsideAnyZone(page);
        const shapes = await drop(page, cdp, mode, point, fixturePath, bytes);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const overs = shapes.filter((shape) => shape.type === "dragover");
        if (!overs.length) throw new Error(`outside: no dragover reached the page: ${JSON.stringify(shapes)}`);
        const uncancelled = overs.filter((shape) => !shape.cancelled || shape.effect !== "none");
        if (uncancelled.length) {
          throw new Error(`outside: a dragover was left uncancelled or with a drop effect: ${JSON.stringify(uncancelled)}`);
        }
        const dropped = shapes.filter((shape) => shape.type === "drop" && !shape.cancelled);
        if (dropped.length) throw new Error(`outside: a drop reached the page uncancelled: ${JSON.stringify(dropped)}`);
        assertSamePage(page, outsideUrl, navigations, "outside");
        const after = imagesEverywhere(ctx);
        const added = after.filter((name) => !before.includes(name));
        if (added.length) throw new Error(`outside: images appeared: ${added.join(", ")}`);
        await ctx.shot("outside");
        result.legs.outside = { point, shapes };
      }

      assertSamePage(page, url, navigations, "the whole check");
      result.navigations = navigations;
      for (const [leg, entry] of Object.entries(result.legs)) {
        const last = entry.shapes.at(-1);
        const opened = entry.opens ? `; opened on try ${entry.opens}` : "";
        console.log(`[smoke]   ${leg}: at ${JSON.stringify(entry.point)}; ${entry.shapes.map((s) => s.type).join(",")}; last ${JSON.stringify(last)}${entry.image ? ` -> ${entry.image}` : ""}${opened}`);
      }
      return result;
    } finally {
      await cdp?.detach().catch(() => {});
      if (await page.$(".rich-prompt").catch(() => null)) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForFunction(() => !document.querySelector(".rich-prompt"), { timeout: 5_000 }).catch(() => {});
      }
      if (terminalOpen) await terminal(["close", "--tab-name", TAB]).catch(() => {});
      for (let i = 0; i < 2; i++) {
        const active = await page
          .evaluate(() => document.querySelector(".tabs .tab.active")?.getAttribute("title") ?? "")
          .catch(() => "");
        if (active !== doc) break;
        await page
          .evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })))
          .catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
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
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
    }
  },
};
